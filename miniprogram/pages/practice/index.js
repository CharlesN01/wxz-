const dataService = require('../../services/data-service');
const studyStore = require('../../utils/study-store');
const navigation = require('../../utils/navigation');
const api = require('../../services/api');

const GROUP_SIZE = 6;
function canRequest() { return typeof wx !== 'undefined' && typeof wx.request === 'function'; }
function settle(promise) { return Promise.resolve(promise).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })); }
function hasToken() { try { return Boolean(api.auth && api.auth.getToken && api.auth.getToken()); } catch (_) { return false; } }
function errorText(error) {
  if (error && error.code === 'ENTITLEMENT_REQUIRED') return '当前专项需要开通学习权益';
  if (error && (error.status === 401 || error.code === 'INVALID_TOKEN')) return '登录状态已失效，请重新登录';
  if (error && error.status === 403) return '当前账号暂无访问权限';
  if (error && error.code === 'NETWORK_ERROR') return '网络暂不可用，当前显示本地演示题目';
  return error && error.message ? String(error.message) : '题目加载失败';
}
function normalizeState(value) {
  const version = Number(value && value.version);
  return { favorite: Boolean(value && value.favorite), mastered: Boolean(value && value.mastered), version: Number.isFinite(version) && version >= 0 ? version : 0 };
}
function cloneRows(rows) {
  try { return JSON.parse(JSON.stringify(Array.isArray(rows) ? rows : [])); } catch (_) { return []; }
}
function localQuestionState(id) {
  const state = studyStore.getState();
  return { favorite: state.favorites.indexOf(id) !== -1, mastered: Object.prototype.hasOwnProperty.call(state.mastered, id), version: 0 };
}

Page({
  data: { loading: true, hasError: false, errorMessage: '', dataSource: 'local', personalError: '', requiresEntitlement: false, restrictedCount: 0, title: '重点字词专项', typeLabel: '重点字词', isWord: true, mode: 'writing', questions: [], total: 0, completed: 0, progressPercent: 0, groupIndex: 0, groupCount: 0, nextLabel: '下一组' },
  onLoad(options) {
    options = options || {};
    this.articleId = options.articleId || '';
    this._requestedQuestionId = options.questionId || '';
    const localArticle = dataService.getArticles().find((article) => article.id === this.articleId);
    this.articleTitle = options.articleTitle || (localArticle && localArticle.title) || '';
    this.questionType = options.type === 'translation' ? 'translation' : 'word';
    this.allQuestions = [];
    this._stateMap = {};
    this._groupCache = {};
    this._resumeVersion = 0;
    this._remoteLoaded = false;
    const initialMode = options.mode === 'reciting' ? 'reciting' : options.mode === 'writing' ? 'writing' : studyStore.getMode();
    studyStore.setMode(initialMode);
    this.setData({ title: this.questionType === 'word' ? '重点字词专项' : '重点翻译专项', articleTitle: this.articleTitle, typeLabel: this.questionType === 'word' ? '重点字词' : '重点翻译', isWord: this.questionType === 'word', mode: initialMode });
    if (canRequest()) this.loadRemote(options && options.resume === '1');
    else {
      this.allQuestions = dataService.getQuestions({ source: 'classical', articleId: this.articleId || undefined, type: this.questionType });
      this._remoteLoaded = true;
      this.setData({ loading: false, dataSource: 'local', personalError: '当前环境无法连接服务，显示本地演示题目' });
      this.refreshQuestions();
    }
  },
  onShow() {
    if (!this._remoteLoaded) return;
    if (this.data.requiresEntitlement && hasToken()) this.loadRemote(false);
    else this.refreshQuestions();
  },
  async loadRemote(restore) {
    this.setData({ loading: true, hasError: false, errorMessage: '', requiresEntitlement: false, restrictedCount: 0 });
    const response = this.articleId
      ? await settle(api.content.questions(
        { source: 'classical', articleId: this.articleId, type: this.questionType, page: 1 },
        { auth: hasToken() }
      ))
      : await this.loadGlobalRemoteQuestions();
    if (!response.ok) {
      if (response.error && response.error.code === 'NETWORK_ERROR' && restore && this.restoreCachedResume()) {
        this._remoteLoaded = true;
        this.setData({ loading: false, dataSource: 'local', personalError: errorText(response.error) });
        this.refreshQuestions();
        return;
      }
      this.allQuestions = dataService.getQuestions({ source: 'classical', articleId: this.articleId || undefined, type: this.questionType });
      this._remoteLoaded = true;
      if (response.error && response.error.code !== 'NETWORK_ERROR') this.setData({ loading: false, hasError: true, errorMessage: errorText(response.error), total: 0, questions: [] });
      else this.setData({ loading: false, dataSource: 'local', personalError: errorText(response.error) });
      if (!this.data.hasError) this.refreshQuestions();
      return;
    }
    const payload = response.value || {};
    this.allQuestions = Array.isArray(payload.results) ? payload.results.slice() : [];
    let next = payload.next || null;
    const seen = new Set();
    while (next && !seen.has(String(next))) {
      seen.add(String(next));
      const pageResult = await settle(api.pagination.follow(next, { auth: 'optional', basePath: '/api/student/v1/questions/' }));
      if (!pageResult.ok) {
        this.setData({ loading: false, hasError: true, errorMessage: errorText(pageResult.error), total: 0, questions: [] });
        return;
      }
      const page = pageResult.value || {};
      if (Array.isArray(page.results)) this.allQuestions.push(...page.results);
      next = page.next || null;
    }
    this._remoteLoaded = true;
    const restrictedCount = Math.max(0, Number(payload.access && payload.access.restrictedCount) || 0);
    this.setData({ restrictedCount });
    if (!this.allQuestions.length) { this.setData({ loading: false, dataSource: 'remote', requiresEntitlement: restrictedCount > 0, total: 0, questions: [] }); return; }
    const stateError = await this.loadStates(this.allQuestions);
    if (restore) await this.restoreResume();
    this.setData({ loading: false, dataSource: 'remote', personalError: stateError ? errorText(stateError) : '' });
    this.refreshQuestions();
  },
  async loadGlobalRemoteQuestions() {
    const articlesResult = await settle(api.content.articles({ page: 1 }, { auth: hasToken() }));
    if (!articlesResult.ok) return articlesResult;
    const articlePayload = articlesResult.value || {};
    const articles = Array.isArray(articlePayload.results) ? articlePayload.results.slice() : [];
    let next = articlePayload.next || null;
    const seenPages = new Set();
    while (next && !seenPages.has(String(next))) {
      seenPages.add(String(next));
      const pageResult = await settle(api.pagination.follow(next, { auth: 'optional', basePath: '/api/student/v1/articles/' }));
      if (!pageResult.ok) return pageResult;
      const page = pageResult.value || {};
      if (Array.isArray(page.results)) articles.push(...page.results);
      next = page.next || null;
    }
    const rows = [];
    const access = { restrictedCount: 0 };
    for (const article of articles) {
      const result = await settle(api.content.questions(
        { source: 'classical', articleId: article.id, type: this.questionType, page: 1 },
        { auth: hasToken() }
      ));
      if (!result.ok) return result;
      const payload = result.value || {};
      access.restrictedCount += Math.max(0, Number(payload.access && payload.access.restrictedCount) || 0);
      if (Array.isArray(payload.results)) rows.push(...payload.results);
      let questionNext = payload.next || null;
      const seenQuestions = new Set();
      while (questionNext && !seenQuestions.has(String(questionNext))) {
        seenQuestions.add(String(questionNext));
        const pageResult = await settle(api.pagination.follow(questionNext, { auth: 'optional', basePath: '/api/student/v1/questions/' }));
        if (!pageResult.ok) return pageResult;
        const page = pageResult.value || {};
        if (Array.isArray(page.results)) rows.push(...page.results);
        questionNext = page.next || null;
      }
    }
    return { ok: true, value: { results: rows, next: null, access } };
  },
  async loadStates(rows) {
    if (!hasToken()) return;
    const results = await Promise.all(rows.map((item) => settle(api.learning.questionState(item.id))));
    let firstError = null;
    results.forEach((item, index) => { if (item.ok) this._stateMap[rows[index].id] = normalizeState(item.value); else firstError = firstError || item.error; });
    return firstError;
  },
  async restoreResume() {
    if (this._requestedQuestionId) {
      const requestedIndex = this.allQuestions.findIndex((question) => String(question.id) === String(this._requestedQuestionId));
      if (requestedIndex >= 0) {
        this.setData({ groupIndex: Math.floor(requestedIndex / GROUP_SIZE) });
        return;
      }
    }
    let saved = null;
    if (hasToken()) {
      const result = await settle(api.learning.resume());
      const remote = result.ok && result.value && result.value.valid ? result.value.resume : null;
      const sameArticle = this.articleId
        ? String(remote && remote.articleId || '') === String(this.articleId)
        : !remote || remote.articleId == null;
      if (remote && remote.source === 'classical' && sameArticle && remote.type === this.questionType) {
        saved = remote;
        if (!this.articleId && remote.articleId) this.articleId = remote.articleId;
        if (result.value && Number(result.value.version) >= 0) this._resumeVersion = Number(result.value.version);
      }
    }
    if (!saved) {
      const local = studyStore.getResume(); const options = local && local.options || {};
      const sameArticle = this.articleId
        ? String(options.articleId || '') === String(this.articleId)
        : !options.articleId;
      if (local && /pages\/practice\/index$/.test(local.path || '') && sameArticle && options.type === this.questionType) saved = { groupIndex: Number(local.groupIndex) + 1 };
    }
    if (saved) {
      let rawIndex = Number(saved.groupIndex);
      if ((!Number.isInteger(rawIndex) || rawIndex < 1) && saved.questionId) {
        const questionIndex = this.allQuestions.findIndex((question) => String(question.id) === String(saved.questionId));
        if (questionIndex >= 0) rawIndex = Math.floor(questionIndex / GROUP_SIZE) + 1;
      }
      if (Number.isInteger(rawIndex) && rawIndex >= 1) this.setData({ groupIndex: rawIndex - 1 });
    }
  },
  refreshQuestions() {
    const states = this._stateMap || {};
    const decorated = (this.allQuestions || []).map((question) => Object.assign({}, question, states[question.id] || (!hasToken() ? localQuestionState(question.id) : normalizeState(null))));
    const total = decorated.length; const groupCount = Math.ceil(total / GROUP_SIZE); const groupIndex = groupCount ? Math.min(Math.max(this.data.groupIndex, 0), groupCount - 1) : 0; const completed = decorated.filter((question) => question.mastered).length;
    const questions = decorated.slice(groupIndex * GROUP_SIZE, groupIndex * GROUP_SIZE + GROUP_SIZE);
    const pageCompleted = questions.filter((question) => question.mastered).length;
    this.setData({ questions, total, completed, pageCompleted, pageProgressPercent: Math.round(pageCompleted / GROUP_SIZE * 100), progressPercent: total ? Math.round(completed / total * 100) : 0, groupIndex, groupCount, nextLabel: '下一页' });
    if (total) this.savePosition();
  },
  savePosition() {
    const groupCache = {};
    (this.allQuestions || []).forEach((question, index) => {
      const group = String(Math.floor(index / GROUP_SIZE) + 1);
      if (!groupCache[group]) groupCache[group] = [];
      groupCache[group].push(cloneRows([question])[0]);
    });
    studyStore.saveResume({
      path: '/pages/practice/index',
      options: { articleId: this.articleId || null, type: this.questionType },
      groupIds: (this.allQuestions || []).map((question) => question.id),
      groupIndex: this.data.groupIndex,
      groupCount: Math.ceil((this.allQuestions || []).length / GROUP_SIZE),
      roundQuestionCount: (this.allQuestions || []).length,
      groupPageSize: GROUP_SIZE,
      groupCache
    });
    if (!hasToken() || !this.allQuestions.length) return;
    const first = this.allQuestions[this.data.groupIndex * GROUP_SIZE] || this.allQuestions[0]; if (!first) return;
    const body = { source: 'classical', articleId: this.articleId || null, type: this.questionType, mode: this.data.mode, questionId: first.id, roundId: null, groupIndex: null, baseVersion: this._resumeVersion };
    settle(api.learning.saveResume(body)).then((result) => {
      if (result.ok && Number(result.value && result.value.version) >= 0) this._resumeVersion = Number(result.value.version);
      else if (!result.ok && result.error && result.error.code === 'VERSION_CONFLICT') {
        const current = result.error.current || result.error.fields && result.error.fields.current;
        if (current && Number(current.version) >= 0) {
          this._resumeVersion = Number(current.version);
          settle(api.learning.saveResume(Object.assign({}, body, { baseVersion: this._resumeVersion }))).then((retry) => {
            if (retry.ok && Number(retry.value && retry.value.version) >= 0) this._resumeVersion = Number(retry.value.version);
            else if (!retry.ok) this.setData({ personalError: errorText(retry.error) });
          });
        }
      } else if (!result.ok) this.setData({ personalError: errorText(result.error) });
    });
  },
  restoreCachedResume() {
    const resume = studyStore.getResume();
    const options = resume && resume.options || {};
    if (!resume || resume.path !== '/pages/practice/index' || options.articleId !== this.articleId || options.type !== this.questionType) return false;
    const cache = resume.groupCache && typeof resume.groupCache === 'object' ? resume.groupCache : {};
    const rows = Object.keys(cache).sort((a, b) => Number(a) - Number(b)).reduce((all, key) => {
      return all.concat(Array.isArray(cache[key]) ? cache[key] : []);
    }, []);
    if (!rows.length) return false;
    this._groupCache = cache;
    this.allQuestions = rows;
    const groupCount = Number(resume.groupCount) || Math.ceil(rows.length / GROUP_SIZE);
    const groupIndex = Math.max(0, Math.min(Number(resume.groupIndex) || 0, groupCount - 1));
    this.setData({ groupIndex, groupCount, total: rows.length });
    return true;
  },
  onRetry() { this.loadRemote(false); },
  onModeChange(event) { const mode = event.detail.mode; if (mode !== 'writing' && mode !== 'reciting') return; studyStore.setMode(mode); this.setData({ mode }); this.refreshQuestions(); },
  async updateState(id, field, desiredValue) {
    if (!id) return;
    if (!hasToken()) {
      const current = localQuestionState(id);
      const next = typeof desiredValue === 'boolean' ? desiredValue : !current[field];
      if (next !== current[field]) studyStore[field === 'favorite' ? 'toggleFavorite' : 'toggleMastered'](id);
      this._stateMap[id] = localQuestionState(id);
      this.setData({ personalError: '当前未登录，学习状态仅保存在本地' });
      this.refreshQuestions();
      return;
    }
    const currentResult = await settle(api.learning.questionState(id)); if (!currentResult.ok) { this.setData({ personalError: errorText(currentResult.error) }); return; }
    const current = normalizeState(currentResult.value); const next = typeof desiredValue === 'boolean' ? desiredValue : !current[field];
    if (next === current[field]) { this._stateMap[id] = current; this.refreshQuestions(); return; }
    const result = await settle(api.learning.setQuestionState(id, { [field]: next, baseVersion: current.version }));
    if (result.ok) { this._stateMap[id] = normalizeState(result.value); this.refreshQuestions(); return; }
    const server = result.error && (result.error.current || result.error.fields && result.error.fields.current);
    if (result.error && result.error.code === 'VERSION_CONFLICT' && server) { const retry = await settle(api.learning.setQuestionState(id, { [field]: next, baseVersion: normalizeState(server).version })); if (retry.ok) { this._stateMap[id] = normalizeState(retry.value); this.refreshQuestions(); return; } }
    this.setData({ personalError: errorText(result.error) });
  },
  onFavorite(event) { return this.updateState(event.detail.id, 'favorite'); },
  onMaster(event) { return this.updateState(event.detail.id, 'mastered', event.detail.mastered); },
  onPreviousGroup() { if (!this.data.total || this.data.groupIndex <= 0) return; this.setData({ groupIndex: this.data.groupIndex - 1 }); this.refreshQuestions(); if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 180 }); },
  onNextGroup() { if (!this.data.total || this.data.groupIndex >= this.data.groupCount - 1) return; this.setData({ groupIndex: this.data.groupIndex + 1 }); this.refreshQuestions(); if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 180 }); },
  onEmptyAction() {
    if (this.data.requiresEntitlement) { navigation.openPage('/pages/mine/index'); return; }
    if (getCurrentPages().length > 1) wx.navigateBack({ delta: 1 }); else navigation.openPage('/pages/classical/index');
  }
});

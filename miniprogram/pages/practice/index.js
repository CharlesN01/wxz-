const { withStudyTime } = require('../../utils/study-timer');
const dataService = require('../../services/data-service');
const studyStore = require('../../utils/study-store');
const navigation = require('../../utils/navigation');
const api = require('../../services/api');
const answerDrafts = require('../../utils/answer-drafts');

const GROUP_SIZE = 6;
function currentTheme() { try { return wx.getStorageSync('chinese-study.theme') === 'night' ? 'night' : 'day'; } catch (_) { return 'day'; } }
function canRequest() { return typeof wx !== 'undefined' && typeof wx.request === 'function'; }
function settle(promise) { return Promise.resolve(promise).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })); }
function getToken() { try { return api.auth && api.auth.getToken && api.auth.getToken() || ''; } catch (_) { return ''; } }
function hasToken() { return Boolean(getToken()); }
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
function masteredCount(value, total) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, total) : null;
}
function cloneRows(rows) {
  try { return JSON.parse(JSON.stringify(Array.isArray(rows) ? rows : [])); } catch (_) { return []; }
}
function localQuestionState(id) {
  const state = studyStore.getState();
  return { favorite: state.favorites.indexOf(id) !== -1, mastered: Object.prototype.hasOwnProperty.call(state.mastered, id), version: 0 };
}

Page(withStudyTime({
  data: { theme: 'day', loading: true, hasError: false, errorMessage: '', dataSource: 'local', personalError: '', requiresEntitlement: false, restrictedCount: 0, title: '重点字词专项', typeLabel: '重点字词', isWord: true, mode: 'writing', questions: [], total: 0, completed: 0, progressPercent: 0, answeredCount: 0, answerProgressPercent: 0, pageCompleted: 0, pageProgressPercent: 0, pageQuestionCount: 0, groupIndex: 0, groupCount: 0, nextLabel: '下一组' },
  onLoad(options) {
    options = options || {};
    this.articleId = options.articleId || '';
    this._requestedQuestionId = options.questionId || '';
    const localArticle = dataService.getArticles().find((article) => article.id === this.articleId);
    const requestedTitle = navigation.decodeQueryValue ? navigation.decodeQueryValue(options.articleTitle) : options.articleTitle;
    this.articleTitle = requestedTitle || (localArticle && localArticle.title) || '';
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
    this.setData({ theme: currentTheme() });
    if (!this._remoteLoaded || this.data.loading) return;
    if (canRequest() && (this._contentToken !== getToken()
      || hasToken() && (this.data.restrictedCount > 0 || this.data.dataSource === 'local'))) return this.loadRemote(false);
    else this.refreshQuestions();
  },
  onUnload() { this._loadGeneration = (this._loadGeneration || 0) + 1; },
  async loadRemote(restore) {
    const generation = (this._loadGeneration || 0) + 1;
    this._loadGeneration = generation;
    this._changingGroup = false;
    this._contentToken = getToken();
    this._stateMap = {};
    this._groupCache = {};
    this._remoteRows = {};
    this._scopes = [];
    this._remoteTotal = 0;
    this._scopeRestricted = {};
    this._pageSize = 0;
    this._savedPosition = '';
    this._remotePaging = true;
    this.allQuestions = [];
    this.setData({ loading: true, hasError: false, errorMessage: '', personalError: '', groupLoading: false, requiresEntitlement: false, restrictedCount: 0, questions: [], groupIndex: 0 });
    const result = await settle(this.prepareRemoteScopes(generation));
    if (generation !== this._loadGeneration) return;
    if (!result.ok) {
      this._remotePaging = false;
      if (result.error && result.error.code === 'NETWORK_ERROR' && restore && this.restoreCachedResume()) {
        this._remoteLoaded = true;
        this.setData({ loading: false, dataSource: 'local', personalError: errorText(result.error) });
        this.refreshQuestions();
        return;
      }
      this.allQuestions = dataService.getQuestions({ source: 'classical', articleId: this.articleId || undefined, type: this.questionType });
      this._remoteLoaded = true;
      if (result.error && result.error.code !== 'NETWORK_ERROR') this.setData({ loading: false, hasError: true, errorMessage: errorText(result.error), total: 0, questions: [] });
      else this.setData({ loading: false, dataSource: 'local', personalError: errorText(result.error) });
      if (!this.data.hasError) this.refreshQuestions();
      return;
    }
    if (restore) {
      const resumed = await settle(this.restoreResume());
      if (!resumed.ok) this.setData({ personalError: errorText(resumed.error).replace('当前显示本地演示题目', '继续学习位置暂未恢复') });
    }
    if (generation !== this._loadGeneration) return;
    const groupIndex = Math.min(Math.max(this.data.groupIndex, 0), Math.max(0, Math.ceil(this._remoteTotal / GROUP_SIZE) - 1));
    const group = await settle(this.ensureRemoteGroup(groupIndex));
    if (generation !== this._loadGeneration) return;
    this._remoteLoaded = true;
    if (!group.ok) {
      this.setData({ loading: false, hasError: true, errorMessage: errorText(group.error), total: 0, questions: [] });
      return;
    }
    this.setData({ loading: false, dataSource: 'remote', groupIndex, requiresEntitlement: !this._remoteTotal && this.data.restrictedCount > 0 });
    this.refreshQuestions();
  },
  async prepareRemoteScopes(generation) {
    if (this.articleId) {
      const payload = await api.content.questions({ source: 'classical', articleId: this.articleId, type: this.questionType, page: 1 }, { auth: hasToken() });
      if (generation !== this._loadGeneration) return;
      const rows = Array.isArray(payload.results) ? payload.results : [];
      const scope = { id: this.articleId, title: this.articleTitle, start: 0, count: Number.isInteger(payload.count) ? payload.count : rows.length, pages: {}, generation, mastered: null };
      this._scopes = [scope];
      this._remoteTotal = scope.count;
      this.acceptRemotePage(scope, 1, payload);
      return;
    }
    const articles = [];
    let payload = await api.content.articles({ page: 1 }, { auth: hasToken() });
    const seen = new Set();
    while (payload) {
      if (generation !== this._loadGeneration) return;
      if (Array.isArray(payload.results)) articles.push(...payload.results);
      if (!payload.next || seen.has(String(payload.next))) break;
      seen.add(String(payload.next));
      payload = await api.pagination.follow(payload.next, { auth: 'optional', basePath: '/api/student/v1/articles/' });
    }
    const countField = this.questionType === 'translation' ? 'translationCount' : 'wordCount';
    const publishedField = this.questionType === 'translation' ? 'publishedTranslationCount' : 'publishedWordCount';
    const masteredField = this.questionType === 'translation' ? 'masteredTranslationCount' : 'masteredWordCount';
    for (const article of articles) {
      let count = Number(article[countField]);
      let first = null;
      // Compatibility with older servers: fetch each scope once, never once per question.
      if (!Number.isInteger(count) || count < 0) {
        first = await api.content.questions({ source: 'classical', articleId: article.id, type: this.questionType, page: 1 }, { auth: hasToken() });
        count = Number.isInteger(first.count) ? first.count : (first.results || []).length;
      }
      if (generation !== this._loadGeneration) return;
      const scope = { id: article.id, title: article.title || '', start: this._remoteTotal, count, pages: {}, generation,
        mastered: masteredCount(article.progress && article.progress[masteredField], count) };
      this._scopes.push(scope);
      this._remoteTotal += count;
      if (Number.isInteger(article[publishedField])) this._scopeRestricted[scope.id] = Math.max(0, article[publishedField] - count);
      if (first) this.acceptRemotePage(scope, 1, first);
    }
    this.setData({ restrictedCount: Object.values(this._scopeRestricted).reduce((sum, count) => sum + count, 0) });
  },
  acceptRemotePage(scope, pageNumber, payload) {
    if (scope.generation !== this._loadGeneration) return;
    const rows = (Array.isArray(payload.results) ? payload.results : []).map((question) => ({
      ...question,
      articleTitle: question.articleTitle || scope.title || ''
    }));
    const completed = masteredCount(payload.progress && payload.progress.masteredCount, scope.count);
    if (completed !== null) scope.mastered = completed;
    const size = Number(payload.access && payload.access.pageSize);
    if (Number.isInteger(size) && size > 0) this._pageSize = size;
    if (!this._pageSize) this._pageSize = rows.length || GROUP_SIZE;
    scope.pages[pageNumber] = rows;
    const start = scope.start + (pageNumber - 1) * this._pageSize;
    rows.forEach((question, index) => {
      this._remoteRows[start + index] = question;
      if (question.state) this._stateMap[question.id] = normalizeState(question.state);
    });
    this._scopeRestricted[scope.id] = Math.max(0, Number(payload.access && payload.access.restrictedCount) || 0);
    this.setData({ restrictedCount: Object.values(this._scopeRestricted).reduce((sum, count) => sum + count, 0) });
    this.allQuestions = Object.keys(this._remoteRows).sort((a, b) => Number(a) - Number(b)).map(key => this._remoteRows[key]);
  },
  async loadScopePage(scope, pageNumber) {
    if (scope.generation !== this._loadGeneration) return [];
    if (scope.pages[pageNumber]) return scope.pages[pageNumber];
    const payload = await api.content.questions({ source: 'classical', articleId: scope.id, type: this.questionType, page: pageNumber }, { auth: hasToken() });
    this.acceptRemotePage(scope, pageNumber, payload);
    return scope.pages[pageNumber] || [];
  },
  async ensureRemoteGroup(groupIndex) {
    const start = groupIndex * GROUP_SIZE;
    const end = Math.min(start + GROUP_SIZE, this._remoteTotal);
    // Only pages intersecting this six-question group are loaded. Cross-article
    // ordering follows the catalog and never depends on request completion order.
    for (const scope of this._scopes) {
      const lower = Math.max(start, scope.start);
      const upper = Math.min(end, scope.start + scope.count);
      if (lower >= upper) continue;
      if (!this._pageSize) await this.loadScopePage(scope, 1);
      const first = Math.floor((lower - scope.start) / this._pageSize) + 1;
      const last = Math.floor((upper - 1 - scope.start) / this._pageSize) + 1;
      for (let page = first; page <= last; page += 1) await this.loadScopePage(scope, page);
    }
  },
  async locateRemoteQuestion(questionId) {
    const cachedIndex = Object.keys(this._remoteRows).find(key => String(this._remoteRows[key].id) === String(questionId));
    if (cachedIndex !== undefined) return Number(cachedIndex);
    let detail = null;
    if (api.content.question) {
      const result = await settle(api.content.question(questionId, { auth: hasToken() }));
      if (result.ok) detail = result.value;
    }
    if (detail && detail.type && detail.type !== this.questionType) return -1;
    let scope = detail && this._scopes.find(item => String(item.id) === String(detail.articleId));
    if (!scope && this.articleId) scope = this._scopes[0];
    if (!scope) return -1;
    const size = Number(detail && detail.access && detail.access.pageSize);
    if (Number.isInteger(size) && size > 0) this._pageSize = size;
    if (!this._pageSize) await this.loadScopePage(scope, 1);
    const index = detail && detail.scopeIndex;
    if (Number.isInteger(index) && index >= 0 && index < scope.count) {
      const pageNumber = Math.floor(index / this._pageSize) + 1;
      const rows = await this.loadScopePage(scope, pageNumber);
      const offset = rows.findIndex(question => String(question.id) === String(questionId));
      if (offset >= 0) return scope.start + (pageNumber - 1) * this._pageSize + offset;
      return -1;
    }
    // Older servers do not report scopeIndex. Keep their existing resume support
    // bounded to the one identified article instead of scanning the whole catalog.
    for (let page = 1; page <= Math.ceil(scope.count / this._pageSize); page += 1) {
      const rows = await this.loadScopePage(scope, page);
      const offset = rows.findIndex(question => String(question.id) === String(questionId));
      if (offset >= 0) return scope.start + (page - 1) * this._pageSize + offset;
    }
    return -1;
  },
  async restoreResume() {
    const findQuestion = async (id) => this._remotePaging ? this.locateRemoteQuestion(id) : this.allQuestions.findIndex(question => String(question.id) === String(id));
    if (this._requestedQuestionId) {
      const requestedIndex = await findQuestion(this._requestedQuestionId);
      if (requestedIndex >= 0) {
        this.setData({ groupIndex: Math.floor(requestedIndex / GROUP_SIZE) });
        return;
      }
    }
    let saved = null;
    if (hasToken()) {
      const result = await settle(api.learning.resume());
      const remote = result.ok && result.value && result.value.valid ? result.value.resume : null;
      const sameArticle = this.articleId ? String(remote && remote.articleId || '') === String(this.articleId) : !remote || remote.articleId == null;
      if (remote && remote.source === 'classical' && sameArticle && remote.type === this.questionType) {
        saved = remote;
        if (Number(result.value && result.value.version) >= 0) this._resumeVersion = Number(result.value.version);
      }
    }
    if (!saved) {
      const local = studyStore.getResume && studyStore.getResume();
      const options = local && local.options || {};
      const sameArticle = this.articleId ? String(options.articleId || '') === String(this.articleId) : !options.articleId;
      if (local && /pages\/practice\/index$/.test(local.path || '') && sameArticle && options.type === this.questionType) {
        const group = local.groupCache && local.groupCache[String(Number(local.groupIndex) + 1)];
        saved = { groupIndex: Number(local.groupIndex) + 1, questionId: options.questionId || group && group[0] && group[0].id || local.groupIds && local.groupIds[Number(local.groupIndex) * GROUP_SIZE] };
      }
    }
    if (saved) {
      if (saved.questionId) {
        const index = await findQuestion(saved.questionId);
        if (index >= 0) { this.setData({ groupIndex: Math.floor(index / GROUP_SIZE) }); return; }
      }
      const rawIndex = Number(saved.groupIndex);
      if (Number.isInteger(rawIndex) && rawIndex >= 1) this.setData({ groupIndex: rawIndex - 1 });
    }
  },
  refreshQuestions() {
    const states = this._stateMap || {};
    const total = this._remotePaging ? this._remoteTotal : (this.allQuestions || []).length;
    const groupCount = Math.ceil(total / GROUP_SIZE);
    const groupIndex = groupCount ? Math.min(Math.max(this.data.groupIndex, 0), groupCount - 1) : 0;
    const rows = this._remotePaging
      ? Array.from({ length: Math.min(GROUP_SIZE, total - groupIndex * GROUP_SIZE) }, (_value, index) => this._remoteRows[groupIndex * GROUP_SIZE + index]).filter(Boolean)
      : (this.allQuestions || []).slice(groupIndex * GROUP_SIZE, groupIndex * GROUP_SIZE + GROUP_SIZE);
    const questions = answerDrafts.decorate(rows.map(question => Object.assign({}, question, states[question.id] || (!hasToken() ? localQuestionState(question.id) : normalizeState(null)))), this.draftStore());
    const completed = this._remotePaging
      ? this._scopes.reduce((sum, scope) => sum + (scope.mastered !== null ? scope.mastered
        : Object.keys(this._remoteRows).filter(key => Number(key) >= scope.start && Number(key) < scope.start + scope.count
          && hasToken() && normalizeState(states[this._remoteRows[key].id]).mastered).length), 0)
      : (this.allQuestions || []).filter(question => (states[question.id] || (!hasToken() ? localQuestionState(question.id) : normalizeState(null))).mastered).length;
    const answerProgress = answerDrafts.progress(questions);
    this.setData(Object.assign({ questions, total, completed, pageCompleted: answerProgress.answeredCount, pageProgressPercent: answerProgress.answerProgressPercent, progressPercent: total ? Math.round(completed / total * 100) : 0, groupIndex, groupCount, nextLabel: '下一页' }, answerProgress));
    if (questions.length) {
      this._groupCache = this._groupCache || {};
      this._groupCache[String(groupIndex + 1)] = cloneRows(questions);
      this.savePosition();
    }
  },
  savePosition() {
    const total = this._remotePaging ? this._remoteTotal : (this.allQuestions || []).length;
    const groupIds = this._remotePaging
      ? Object.keys(this._remoteRows).sort((a, b) => Number(a) - Number(b)).map(key => this._remoteRows[key].id)
      : (this.allQuestions || []).map(question => question.id);
    const groupCache = Object.assign({}, this._groupCache || {});
    if (!this._remotePaging) (this.allQuestions || []).forEach((question, index) => {
      const group = String(Math.floor(index / GROUP_SIZE) + 1);
      if (!groupCache[group]) groupCache[group] = [];
      if (!groupCache[group].some(row => row.id === question.id)) groupCache[group].push(cloneRows([question])[0]);
    });
    const currentFirst = this._remotePaging ? this._remoteRows[this.data.groupIndex * GROUP_SIZE] : this.allQuestions[this.data.groupIndex * GROUP_SIZE];
    studyStore.saveResume({
      path: '/pages/practice/index', options: { articleId: this.articleId || null, type: this.questionType, questionId: currentFirst && currentFirst.id },
      groupIds, groupIndex: this.data.groupIndex, groupCount: Math.ceil(total / GROUP_SIZE), roundQuestionCount: total, groupPageSize: GROUP_SIZE, groupCache
    });
    if (!hasToken() || !total) return;
    const first = this._remotePaging ? this._remoteRows[this.data.groupIndex * GROUP_SIZE] : this.allQuestions[this.data.groupIndex * GROUP_SIZE];
    if (!first) return;
    const position = [this.articleId || '', this.questionType, this.data.mode, first.id].join(':');
    if (position === this._savedPosition) return;
    this._savedPosition = position;
    const body = { source: 'classical', articleId: this.articleId || null, type: this.questionType, mode: this.data.mode, questionId: first.id, roundId: null, groupIndex: null, baseVersion: this._resumeVersion };
    settle(api.learning.saveResume(body)).then((result) => {
      if (result.ok && Number(result.value && result.value.version) >= 0) this._resumeVersion = Number(result.value.version);
      else if (!result.ok && result.error && result.error.code === 'VERSION_CONFLICT') {
        const current = result.error.current || result.error.fields && result.error.fields.current;
        if (current && Number(current.version) >= 0) {
          this._resumeVersion = Number(current.version);
          settle(api.learning.saveResume(Object.assign({}, body, { baseVersion: this._resumeVersion }))).then((retry) => {
            if (retry.ok && Number(retry.value && retry.value.version) >= 0) this._resumeVersion = Number(retry.value.version);
            else if (!retry.ok) { this._savedPosition = ''; this.setData({ personalError: errorText(retry.error) }); }
          });
        }
      } else if (!result.ok) { this._savedPosition = ''; this.setData({ personalError: errorText(result.error) }); }
    });
  },
  restoreCachedResume() {
    const resume = studyStore.getResume && studyStore.getResume();
    const options = resume && resume.options || {};
    if (!resume || resume.path !== '/pages/practice/index' || String(options.articleId || '') !== String(this.articleId || '') || options.type !== this.questionType) return false;
    const cache = resume.groupCache && typeof resume.groupCache === 'object' ? resume.groupCache : {};
    const groupIndex = Math.max(0, Number(resume.groupIndex) || 0);
    if (!Array.isArray(cache[String(groupIndex + 1)]) || !cache[String(groupIndex + 1)].length) return false;
    const total = Number(resume.roundQuestionCount) || Number(resume.groupCount) * GROUP_SIZE || Object.values(cache).reduce((sum, rows) => sum + rows.length, 0);
    const rows = new Array(total);
    Object.keys(cache).forEach(key => {
      if (!Array.isArray(cache[key])) return;
      cache[key].forEach((question, index) => { rows[(Number(key) - 1) * GROUP_SIZE + index] = question; });
    });
    this._groupCache = cache;
    this._stateMap = this._stateMap || {};
    rows.forEach(question => { this._stateMap[question.id] = normalizeState(question.state || question); });
    this.allQuestions = rows;
    this.setData({ groupIndex, groupCount: Math.ceil(total / GROUP_SIZE), total });
    return true;
  },
  onRetry() { this.loadRemote(false); },
  draftStore() {
    if (!this._draftStore) this._draftStore = answerDrafts.createStore(api.auth, typeof wx === 'undefined' ? null : wx);
    return this._draftStore;
  },
  onAnswerInput(event) {
    const update = answerDrafts.acceptInput(this, event, this.draftStore());
    if (update) this.setData(Object.assign(update, { pageCompleted: update.answeredCount, pageProgressPercent: update.answerProgressPercent }));
  },
  onModeChange(event) { const mode = event.detail.mode; if (mode !== 'writing' && mode !== 'reciting') return; studyStore.setMode(mode); this.setData({ mode }); this.refreshQuestions(); },
  acceptQuestionState(id, value) {
    const next = normalizeState(value);
    const previous = normalizeState(this._stateMap[id]);
    // Concurrent submissions can finish out of order. Apply each confirmed
    // mastered transition once and never replace a newer state with an old one.
    if (next.version < previous.version) return;
    if (this._remotePaging && next.mastered !== previous.mastered) {
      const index = Object.keys(this._remoteRows).find(key => String(this._remoteRows[key].id) === String(id));
      const scope = index === undefined ? null : this._scopes.find(item => Number(index) >= item.start && Number(index) < item.start + item.count);
      if (scope && scope.mastered !== null) scope.mastered = Math.min(scope.count, Math.max(0, scope.mastered + (next.mastered ? 1 : -1)));
    }
    this._stateMap[id] = next;
  },
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
    const currentResult = this._stateMap[id] ? { ok: true, value: this._stateMap[id] } : await settle(api.learning.questionState(id));
    if (!currentResult.ok) { this.setData({ personalError: errorText(currentResult.error) }); return; }
    const current = normalizeState(currentResult.value); const next = typeof desiredValue === 'boolean' ? desiredValue : !current[field];
    if (!this._stateMap[id]) this._stateMap[id] = current;
    if (next === current[field]) { this._stateMap[id] = current; this.refreshQuestions(); return; }
    const result = await settle(api.learning.setQuestionState(id, { [field]: next, baseVersion: current.version }));
    if (result.ok) { this.acceptQuestionState(id, result.value); this.refreshQuestions(); return; }
    const server = result.error && (result.error.current || result.error.fields && result.error.fields.current);
    if (result.error && result.error.code === 'VERSION_CONFLICT' && server) { const retry = await settle(api.learning.setQuestionState(id, { [field]: next, baseVersion: normalizeState(server).version })); if (retry.ok) { this.acceptQuestionState(id, retry.value); this.refreshQuestions(); return; } }
    this.setData({ personalError: errorText(result.error) });
  },
  onFavorite(event) { return this.updateState(event.detail.id, 'favorite'); },
  onMaster(event) { return this.updateState(event.detail.id, 'mastered', event.detail.mastered); },
  async changeGroup(index) {
    if (this._changingGroup || this.data.loading || index < 0 || index >= this.data.groupCount) return;
    if (!this._remotePaging && !this.allQuestions[index * GROUP_SIZE]) {
      this.setData({ personalError: '当前分页尚未缓存，请联网后重试' });
      return;
    }
    const generation = this._loadGeneration;
    this._changingGroup = true;
    this.setData({ groupLoading: true });
    if (this._remotePaging) {
      const loaded = await settle(this.ensureRemoteGroup(index));
      if (generation !== this._loadGeneration) return;
      if (!loaded.ok) {
        this._changingGroup = false;
        this.setData({ groupLoading: false, personalError: errorText(loaded.error).replace('当前显示本地演示题目', '请重试下一页') });
        return;
      }
    }
    this._changingGroup = false;
    this.setData({ groupLoading: false, groupIndex: index, personalError: '' });
    this.refreshQuestions();
    if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 180 });
  },
  onPreviousGroup() { return this.changeGroup(this.data.groupIndex - 1); },
  onNextGroup() { return this.changeGroup(this.data.groupIndex + 1); },
  onEmptyAction() {
    if (this.data.requiresEntitlement) { navigation.openPage('/pages/mine/index'); return; }
    if (getCurrentPages().length > 1) wx.navigateBack({ delta: 1 }); else navigation.openPage('/pages/classical/index');
  }
}));

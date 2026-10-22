const { withStudyTime } = require('../../utils/study-timer');
const dataService = require('../../services/data-service');
const studyStore = require('../../utils/study-store');
const safeTop = require('../../utils/safe-top');
const navigation = require('../../utils/navigation');
const api = require('../../services/api');
const answerDrafts = require('../../utils/answer-drafts');

const GROUP_SIZE = 6;
const PAGE_PATH = '/pages/random/index';
function currentTheme() { try { return wx.getStorageSync('chinese-study.theme') === 'night' ? 'night' : 'day'; } catch (_) { return 'day'; } }
function settle(promise) { return Promise.resolve(promise).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })); }
function getToken() { try { return api.auth && api.auth.getToken && api.auth.getToken() || ''; } catch (_) { return ''; } }
function hasToken() { return Boolean(getToken()); }
function getAccountKey() {
  try {
    const session = api.auth && api.auth.getSession && api.auth.getSession();
    if (session && session.user && session.user.id) return String(session.user.id);
  } catch (_) {}
  return getToken();
}
function errorText(error) {
  if (error && error.code === 'ENTITLEMENT_REQUIRED') return '随机练习需要先开通学习权益';
  if (error && (error.status === 401 || error.code === 'INVALID_TOKEN')) return '登录状态已失效，请重新登录';
  if (error && error.status === 403) return '当前账号暂无访问权限';
  if (error && error.code === 'NETWORK_ERROR') return '网络暂不可用，当前显示本地演示题目';
  return error && error.message ? String(error.message) : '随机练习加载失败';
}
function normalizeState(value) {
  const version = Number(value && value.version);
  return { favorite: Boolean(value && value.favorite), mastered: Boolean(value && value.mastered), version: Number.isFinite(version) && version >= 0 ? version : 0 };
}
function cloneRows(rows) {
  try { return JSON.parse(JSON.stringify(Array.isArray(rows) ? rows : [])); } catch (_) { return []; }
}
function compatibleType(source, type) {
  return type == null || (source === 'literature' ? type === 'fact' : type === 'word' || type === 'translation');
}

Page(withStudyTime({
  data: { theme: 'day', loading: true, hasError: false, errorMessage: '', dataSource: 'local', personalError: '', roundContentUnavailable: false, source: 'literature', safeTop: 0, typeFilter: 'word', mode: 'writing', sourceName: '文学常识', subtitle: '8 类混合随机 · 每页 6 题', questions: [], groupNumber: 0, groupCount: 0, roundQuestionCount: 0, groupPageSize: GROUP_SIZE, progressPercent: 0, answeredCount: 0, answerProgressPercent: 0, pageQuestionCount: 0, nextLabel: '下一组' },

  onLoad(options = {}) {
    this._source = options.source === 'classical' ? 'classical' : 'literature';
    this._typeExplicit = Boolean(options.type) && compatibleType(this._source, options.type);
    this._type = this._typeExplicit ? options.type : (this._source === 'classical' ? 'word' : null);
    // Shared navigation parameters may retain a classical type/article. A
    // literature round accepts only fact or null and never an article scope.
    this._articleId = this._source === 'classical' ? options.articleId || null : null;
    this._requestedRoundId = options.roundId || '';
    this._requestedGroupIndex = Number(options.groupIndex) > 0 ? Number(options.groupIndex) : 0;
    this._modeExplicit = options.mode === 'reciting' || options.mode === 'writing';
    this._groupIndex = 1;
    this._roundId = '';
    this._roundIds = [];
    this._groupCache = {};
    this._stateMap = {};
    this._resumeVersion = 0;
    this._ready = false;
    const initialMode = options.mode === 'reciting' ? 'reciting' : options.mode === 'writing' ? 'writing' : studyStore.getMode();
    studyStore.setMode(initialMode);
    this.setData({
      source: this._source,
      safeTop: 0,
      mode: initialMode,
      typeFilter: this._type === 'translation' ? 'translation' : 'word',
      sourceName: this._source === 'classical' ? '文言文' : '文学常识',
      groupPageSize: GROUP_SIZE,
      subtitle: this._source === 'classical' ? '字词与翻译 · 每页 6 题' : '8 类混合随机 · 每页 6 题'
    });
    const restoreRequested = options.resume === '1' || (this._requestedRoundId && this._requestedGroupIndex > 0);
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && hasToken()) this.startRemoteRound(restoreRequested);
    else {
      this.startLocalRound(restoreRequested);
      this._ready = true;
      this.setData({ dataSource: 'local', personalError: hasToken() ? '' : '未登录，当前显示本地演示题目' });
      this.refreshLocalGroup();
    }
  },

  onShow() {
    this.setData({ theme: currentTheme() });
    if (this.data.loading || !this._ready && !this.data.hasError) return;
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && hasToken()) {
      if (this._contentAccountKey !== getAccountKey()) {
        this._stateMap = {}; this._groupCache = {}; this._resumeVersion = 0;
        return this.startRemoteRound(false);
      }
      if (this.data.dataSource === 'local') return this.startRemoteRound(Boolean(this._roundId));
      if (this._roundId) return this.loadRemoteGroup(this._groupIndex);
      return this.startRemoteRound(false);
    }
    if (this.data.dataSource === 'remote') {
      this._roundId = ''; this._groupCache = {}; this._stateMap = {};
      this.startLocalRound(false);
      this.setData({ dataSource: 'local', personalError: '未登录，当前显示本地演示题目' });
    }
    this.refreshLocalGroup();
  },

  startLocalRound(restore) {
    const resume = restore ? studyStore.getResume() : null;
    const resumeOptions = resume && resume.options || {};
    const matchesContext = resumeOptions.source === this._source
      && compatibleType(this._source, resumeOptions.type)
      && (this._source === 'classical' || !resumeOptions.articleId)
      && (!this._typeExplicit || resumeOptions.type === this._type)
      && (!this._articleId || String(resumeOptions.articleId || '') === String(this._articleId));
    if (resume && resume.path === PAGE_PATH && matchesContext && Array.isArray(resume.groupIds) && resume.groupIds.length) {
      if (!this._typeExplicit && (resumeOptions.type === 'word' || resumeOptions.type === 'translation' || resumeOptions.type === 'fact')) {
        this._type = resumeOptions.type;
        this.setData({ typeFilter: resumeOptions.type === 'translation' ? 'translation' : 'word' });
      }
      if (!this._articleId && resumeOptions.articleId) this._articleId = resumeOptions.articleId;
      if (!this._modeExplicit && (resumeOptions.mode === 'writing' || resumeOptions.mode === 'reciting')) {
        this.setData({ mode: resumeOptions.mode });
        studyStore.setMode(resumeOptions.mode);
      }
      this._roundIds = resume.groupIds.slice();
      this._groupCache = resume.groupCache || {};
      this._groups = [];
      for (let i = 0; i < this._roundIds.length; i += GROUP_SIZE) this._groups.push(this._roundIds.slice(i, i + GROUP_SIZE));
      this._groupIndex = Math.max(1, Math.min(Number(resume.groupIndex) + 1 || 1, this._groups.length || 1));
      if (this._requestedGroupIndex > 0) {
        this._groupIndex = Math.max(1, Math.min(this._requestedGroupIndex, this._groups.length || this._requestedGroupIndex));
      }
      return;
    }
    const rows = dataService.getQuestions({ source: this._source }).filter((item) => !this._type || item.type === this._type);
    this._roundIds = rows.map((item) => item.id);
    for (let i = this._roundIds.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); const tmp = this._roundIds[i]; this._roundIds[i] = this._roundIds[j]; this._roundIds[j] = tmp; }
    this._groups = []; for (let i = 0; i < this._roundIds.length; i += GROUP_SIZE) this._groups.push(this._roundIds.slice(i, i + GROUP_SIZE));
    this._groupIndex = 1;
  },

  refreshLocalGroup() {
    const ids = (this._groups && this._groups[this._groupIndex - 1]) || [];
    const cached = this._groupCache && this._groupCache[String(this._groupIndex)];
    const questions = (Array.isArray(cached) ? cached : ids.map((id) => dataService.getQuestion(id)).filter(Boolean))
      .map((item) => Object.assign({}, item, normalizeState(this._stateMap[item.id])));
    const count = this._groups ? this._groups.length : 0;
    const decorated = this.decorateDrafts(dataService.decorateQuestions(questions));
    this.setData(Object.assign({ loading: false, dataSource: this.data.dataSource || 'local', questions: decorated, groupNumber: count ? this._groupIndex : 0, groupCount: count, roundQuestionCount: this._roundIds.length, groupPageSize: GROUP_SIZE, progressPercent: count ? Math.round(this._groupIndex / count * 100) : 0, nextLabel: this._groupIndex >= count ? '再练一轮' : '下一组' }, answerDrafts.progress(decorated)));
    if (count) this.saveResume();
  },

  async startRemoteRound(restore) {
    this._contentAccountKey = getAccountKey();
    if (!restore) { this._roundId = ''; this._roundIds = []; this._groupIndex = 1; }
    const localResume = restore ? studyStore.getResume() : null;
    if (restore) this.hydrateLocalResume(localResume);
    this.setData({ loading: true, hasError: false, errorMessage: '', roundContentUnavailable: false });
    if (restore && this._requestedRoundId && this._requestedGroupIndex > 0) {
      this._roundId = this._requestedRoundId;
      this._groupIndex = this._requestedGroupIndex;
      await this.loadRemoteGroup(this._groupIndex);
      this._ready = true;
      return;
    }
    if (restore) {
      const savedResult = await settle(api.learning.resume());
      if (!savedResult.ok && savedResult.error && savedResult.error.code === 'NETWORK_ERROR') {
        if (!this.renderCachedGroup(this._groupIndex, errorText(savedResult.error))) {
          this.startLocalRound(true);
          this.setData({ loading: false, dataSource: 'local', personalError: errorText(savedResult.error) });
          this.refreshLocalGroup();
        }
        this._ready = true;
        return;
      }
      if (!savedResult.ok) { this.setData({ loading: false, hasError: true, errorMessage: errorText(savedResult.error), questions: [] }); return; }
      const snapshot = savedResult.value || {};
      const saved = snapshot.valid && snapshot.resume ? snapshot.resume : null;
      const matchesType = saved && compatibleType(this._source, saved.type)
        && (this._typeExplicit ? saved.type === this._type : true);
      const matchesArticle = saved && (this._source === 'classical' || !saved.articleId)
        && (this._articleId ? String(saved.articleId || '') === String(this._articleId) : true);
      if (saved && saved.source === this._source && matchesArticle && matchesType && saved.roundId && Number(saved.groupIndex) > 0) {
        if (!this._typeExplicit && (saved.type === 'word' || saved.type === 'translation' || saved.type === 'fact')) {
          this._type = saved.type;
          this.setData({ typeFilter: saved.type === 'translation' ? 'translation' : 'word' });
        }
        if (!this._articleId && saved.articleId) this._articleId = saved.articleId;
        this._roundId = saved.roundId;
        this._groupIndex = Number(saved.groupIndex);
        this._resumeVersion = Number(snapshot.version) >= 0 ? Number(snapshot.version) : 0;
        if (saved.mode === 'writing' || saved.mode === 'reciting') { this.setData({ mode: saved.mode }); studyStore.setMode(saved.mode); }
        const restored = await this.loadRemoteGroup(this._groupIndex);
        if (restored) return;
        if (!this.data.errorMessage || !this.data.errorMessage.includes('网络')) return;
        if (!this.renderCachedGroup(this._groupIndex, this.data.errorMessage)) {
          this.startLocalRound(true);
          this.setData({ hasError: false, loading: false, dataSource: 'local', personalError: this.data.errorMessage });
          this.refreshLocalGroup();
        }
        return;
      }
    }
    const result = await settle(api.practice.createRound({ source: this._source, categoryId: null, articleId: this._articleId, type: this._type, mode: this.data.mode }));
    if (!result.ok) {
      if (result.error && result.error.code === 'NETWORK_ERROR') { this.startLocalRound(restore); this._ready = true; this.setData({ loading: false, dataSource: 'local', personalError: errorText(result.error) }); this.refreshLocalGroup(); }
      else this.setData({ loading: false, hasError: true, errorMessage: errorText(result.error), questions: [] });
      return;
    }
    const round = result.value || {};
    this._roundId = round.id || '';
    this._groupIndex = 1;
    this._roundCount = Number(round.groupCount) || 0;
    this._roundTotal = Number(round.totalCount) || 0;
    this._groupPageSize = Number(round.pageSize) > 0 ? Number(round.pageSize) : GROUP_SIZE;
    if (!this._roundId) { this.setData({ loading: false, hasError: true, errorMessage: '服务端未返回练习轮次' }); return; }
    await this.loadRemoteGroup(1);
    this._ready = true;
  },

  async loadRemoteGroup(index) {
    this.setData({ loading: true, hasError: false, roundContentUnavailable: false });
    const result = await settle(api.practice.group(this._roundId, index));
    if (!result.ok) {
      const message = errorText(result.error);
      if (result.error && result.error.code === 'NETWORK_ERROR' && this.renderCachedGroup(index, message)) return false;
      this.setData({ loading: false, hasError: true, errorMessage: message, questions: [] });
      return false;
    }
    const payload = result.value || {};
    this._groupIndex = Number(payload.groupIndex) || index;
    this._roundCount = Number(payload.groupCount) || this._roundCount || 0;
    this._roundTotal = Number(payload.totalCount) || this._roundTotal || 0;
    this._groupPageSize = Number(payload.pageSize) > 0 ? Number(payload.pageSize) : this._groupPageSize || GROUP_SIZE;
    const rows = Array.isArray(payload.results) ? payload.results : [];
    this._groupCache[String(this._groupIndex)] = cloneRows(rows);
    await this.loadStates(rows);
    const seenIds = new Set(this._roundIds);
    rows.forEach((item) => { if (item.id && !seenIds.has(item.id)) { seenIds.add(item.id); this._roundIds.push(item.id); } });
    const questions = this.decorateDrafts(rows.map((item) => Object.assign({}, item, this._stateMap[item.id] || normalizeState(null))));
    const restricted = !rows.length && Array.isArray(payload.skipped)
      && payload.skipped.some((item) => item && item.reason === 'ENTITLEMENT_REQUIRED');
    const roundContentUnavailable = !rows.length && Array.isArray(payload.skipped) && payload.skipped.length > 0
      && payload.skipped.every((item) => item && (item.reason === 'UNAVAILABLE' || item.reason === 'SCOPE_CHANGED'));
    this.setData(Object.assign({ loading: false, dataSource: 'remote', questions, roundContentUnavailable, groupNumber: this._groupIndex, groupCount: this._roundCount, roundQuestionCount: this._roundTotal, groupPageSize: this._groupPageSize, progressPercent: this._roundCount ? Math.round(this._groupIndex / this._roundCount * 100) : 0, nextLabel: this._groupIndex >= this._roundCount ? '再练一轮' : '下一组', personalError: restricted ? errorText({ code: 'ENTITLEMENT_REQUIRED' }) : '' }, answerDrafts.progress(questions)));
    this.saveResume();
    return true;
  },

  async loadStates(rows) {
    if (!hasToken()) return;
    rows.forEach((item) => { if (item.state) this._stateMap[item.id] = normalizeState(item.state); });
    const missing = rows.filter((item) => !item.state);
    if (!missing.length) return;
    const results = await Promise.all(missing.map((item) => settle(api.learning.questionState(item.id))));
    let firstError;
    results.forEach((item, index) => {
      if (item.ok) this._stateMap[missing[index].id] = normalizeState(item.value);
      else firstError = firstError || item.error;
    });
    if (firstError) this.setData({ personalError: errorText(firstError) });
  },

  saveResume() {
    studyStore.saveResume({
      path: PAGE_PATH,
      options: { source: this._source, type: this._type, articleId: this._articleId || null, mode: this.data.mode },
      groupIds: this._roundIds.slice(),
      groupIndex: Math.max(0, this._groupIndex - 1),
      roundId: this._roundId || null,
      groupCount: this._roundCount || 0,
      roundQuestionCount: this._roundTotal || this._roundIds.length,
      groupPageSize: this._groupPageSize || GROUP_SIZE,
      groupCache: this._groupCache
    });
    if (!hasToken() || !this._roundIds.length) return;
    const id = this.data.questions[0] && this.data.questions[0].id || this._roundIds[0];
    if (!id) return;
    const body = { source: this._source, categoryId: null, articleId: this._articleId, type: this._type, mode: this.data.mode, questionId: id, roundId: this._roundId || null, groupIndex: this._groupIndex, baseVersion: this._resumeVersion };
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

  hydrateLocalResume(record) {
    if (!record || record.path !== PAGE_PATH) return false;
    const options = record.options || {};
    if (options.source !== this._source || !compatibleType(this._source, options.type)
      || this._source === 'literature' && options.articleId || (this._typeExplicit && options.type !== this._type)
      || (this._articleId && String(options.articleId || '') !== String(this._articleId))) return false;
    this._roundId = record.roundId || this._roundId || '';
    this._roundIds = Array.isArray(record.groupIds) ? record.groupIds.slice() : this._roundIds;
    this._groupCache = record.groupCache && typeof record.groupCache === 'object' ? record.groupCache : this._groupCache;
    this._roundCount = Number(record.groupCount) || this._roundCount || 0;
    this._roundTotal = Number(record.roundQuestionCount) || this._roundTotal || this._roundIds.length;
    this._groupPageSize = Number(record.groupPageSize) || this._groupPageSize || GROUP_SIZE;
    if (record.groupIndex != null) this._groupIndex = Math.max(1, Number(record.groupIndex) + 1);
    this._groups = [];
    for (let i = 0; i < this._roundIds.length; i += GROUP_SIZE) this._groups.push(this._roundIds.slice(i, i + GROUP_SIZE));
    return true;
  },

  renderCachedGroup(index, message) {
    const rows = this._groupCache && this._groupCache[String(index)];
    if (!Array.isArray(rows) || !rows.length) return false;
    this._groupIndex = Number(index) || this._groupIndex || 1;
    const states = this._stateMap || {};
    const questions = this.decorateDrafts(rows.map((item) => Object.assign({}, item, normalizeState(states[item.id]))));
    const count = this._roundCount || Math.max(this._groupIndex, Math.ceil(this._roundIds.length / GROUP_SIZE));
    this.setData(Object.assign({
      loading: false, hasError: false, errorMessage: '', dataSource: 'local', personalError: message || '网络暂不可用，当前显示已缓存题组',
      questions, groupNumber: this._groupIndex, groupCount: count, roundQuestionCount: this._roundTotal || this._roundIds.length,
      groupPageSize: this._groupPageSize || GROUP_SIZE, progressPercent: count ? Math.round(this._groupIndex / count * 100) : 0,
      nextLabel: this._groupIndex >= count ? '再练一轮' : '下一组'
    }, answerDrafts.progress(questions)));
    return true;
  },

  draftStore() {
    if (!this._draftStore) this._draftStore = answerDrafts.createStore(api.auth, typeof wx === 'undefined' ? null : wx);
    return this._draftStore;
  },
  decorateDrafts(questions) { return answerDrafts.decorate(questions, this.draftStore()); },
  onAnswerInput(event) {
    const update = answerDrafts.acceptInput(this, event, this.draftStore());
    if (update) this.setData(update);
  },
  restartUpdatedRound() {
    if (!this.data.roundContentUnavailable || this.data.loading || this.data.hasError || this.data.questions.length) return;
    this._groupCache = {}; this._stateMap = {};
    this._requestedRoundId = ''; this._requestedGroupIndex = 0;
    return this.startRemoteRound(false);
  },
  onRetry() { if (hasToken()) this.startRemoteRound(false); else { this.startLocalRound(false); this.refreshLocalGroup(); } },
  async onModeChange(event) { const mode = event.detail.mode; if (mode !== 'writing' && mode !== 'reciting' || mode === this.data.mode) return; studyStore.setMode(mode); this.setData({ mode }); if (this.data.dataSource === 'remote') { await this.loadRemoteGroup(this._groupIndex); this.saveResume(); } else this.refreshLocalGroup(); },
  async updateState(id, field, desiredValue) {
    if (!id) return;
    if (!hasToken()) {
      const current = studyStore.getState();
      const isSet = field === 'favorite' ? current.favorites.indexOf(id) !== -1 : Object.prototype.hasOwnProperty.call(current.mastered, id);
      const next = typeof desiredValue === 'boolean' ? desiredValue : !isSet;
      if (next !== isSet) studyStore[field === 'favorite' ? 'toggleFavorite' : 'toggleMastered'](id);
      this._stateMap[id] = normalizeState({ favorite: field === 'favorite' ? next : current.favorites.indexOf(id) !== -1, mastered: field === 'mastered' ? next : Object.prototype.hasOwnProperty.call(current.mastered, id) });
      this.setData({ personalError: '当前未登录，学习状态仅保存在本地' });
      this.refreshLocalGroup();
      return;
    }
    const currentResult = await settle(api.learning.questionState(id)); if (!currentResult.ok) { this.setData({ personalError: errorText(currentResult.error) }); return; }
    const current = normalizeState(currentResult.value); const next = typeof desiredValue === 'boolean' ? desiredValue : !current[field];
    if (next === current[field]) { this._stateMap[id] = current; await this.loadRemoteGroup(this._groupIndex); return; }
    const result = await settle(api.learning.setQuestionState(id, { [field]: next, baseVersion: current.version }));
    if (result.ok) { this._stateMap[id] = normalizeState(result.value); if (this.data.dataSource === 'local') this.refreshLocalGroup(); else this.loadRemoteGroup(this._groupIndex); return; }
    const server = result.error && (result.error.current || result.error.fields && result.error.fields.current);
    if (result.error && result.error.code === 'VERSION_CONFLICT' && server) { const retry = await settle(api.learning.setQuestionState(id, { [field]: next, baseVersion: normalizeState(server).version })); if (retry.ok) { this._stateMap[id] = normalizeState(retry.value); this.loadRemoteGroup(this._groupIndex); return; } }
    this.setData({ personalError: errorText(result.error) });
  },
  onFavorite(event) { return this.updateState(event.detail.id, 'favorite'); },
  onMaster(event) { return this.updateState(event.detail.id, 'mastered', event.detail.mastered); },
  onTypeChange(event) {
    const type = event.currentTarget.dataset.type;
    if (this._source !== 'classical' || (type !== 'word' && type !== 'translation') || type === this._type) return;
    this._type = type;
    this._roundId = '';
    this._roundIds = [];
    this._groups = [];
    this._groupIndex = 1;
    this._stateMap = {};
    this.setData({ typeFilter: type, questions: [], groupNumber: 0, groupCount: 0, roundQuestionCount: 0, progressPercent: 0 });
    if (this.data.dataSource === 'remote') this.startRemoteRound(false);
    else { this.startLocalRound(false); this.refreshLocalGroup(); }
  },
  onPreviousGroup() {
    if (this.data.groupNumber <= 1) return;
    if (this.data.dataSource === 'remote') this.loadRemoteGroup(this._groupIndex - 1);
    else { this._groupIndex -= 1; this.refreshLocalGroup(); }
    if (typeof wx !== 'undefined' && wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 180 });
  },
  onNextGroup() {
    if (!this.data.groupCount || this._groupIndex >= this.data.groupCount) return;
    if (this.data.dataSource === 'remote') this.loadRemoteGroup(this._groupIndex + 1);
    else { this._groupIndex += 1; this.refreshLocalGroup(); }
    if (typeof wx !== 'undefined' && wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },
  openHome() { navigation.openPage('/pages/home/index'); },
  openFavorites() { navigation.openPage('/pages/favorites/index'); },
  openProfile() { navigation.openPage('/pages/mine/index'); },
  onGoStudy() { navigation.openPage(this._source === 'classical' ? '/pages/classical/index' : '/pages/literature/index'); }
}));

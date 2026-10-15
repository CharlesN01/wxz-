const dataService = require('../../services/data-service');
const studyStore = require('../../utils/study-store');
const questionUtils = require('../../utils/question-utils');
const api = require('../../services/api');
const navigation = require('../../utils/navigation');

function settle(promise) { return Promise.resolve(promise).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })); }
function hasToken() { try { return Boolean(api.auth && api.auth.getToken && api.auth.getToken()); } catch (_) { return false; } }
function normalizeState(value) { return { favorite: Boolean(value && value.favorite), mastered: Boolean(value && value.mastered), version: Number(value && value.version) >= 0 ? Number(value.version) : 0 }; }
function errorText(error) {
  if (error && error.code === 'ENTITLEMENT_REQUIRED') return '当前收藏需要开通学习权益';
  if (error && (error.status === 401 || error.code === 'INVALID_TOKEN')) return '登录状态已失效，请重新登录';
  if (error && error.status === 403) return '当前账号暂无访问权限';
  if (error && error.code === 'NETWORK_ERROR') return '网络暂不可用，当前显示本地收藏';
  if (error && error.code === 'VERSION_CONFLICT') return '收藏状态已在其他设备更新，请重试';
  return error && error.message ? String(error.message) : '收藏加载失败';
}
function normalizeFavoriteRow(row) {
  const item = row || {};
  const question = item.question && typeof item.question === 'object' ? item.question : null;
  const questionId = item.questionId || item.state && item.state.questionId || '';
  const state = normalizeState(item.state || item);
  if (!question) return { id: String(questionId), source: item.source || '', categoryId: item.categoryId || null, articleId: item.articleId || null, type: item.type || null, unavailable: true, unavailableReason: item.unavailableReason || 'ENTITLEMENT_REQUIRED', favorite: state.favorite, mastered: state.mastered, version: state.version, title: '该考点暂不可访问', stem: '当前账号暂无查看此题内容的权限。' };
  return Object.assign({}, question, state, { id: String(question.id || questionId) });
}

function decorateFavorite(question) {
  const item = question || {};
  const answers = Array.isArray(item.answers) ? item.answers : (item.answer ? [item.answer] : []);
  const prefix = item.source === 'classical' && item.type === 'translation' ? '译文：' : '答案：';
  const answerText = answers.filter(Boolean).join('；');
  const stem = String(item.stem || item.title || '收藏考点');
  const parts = questionUtils.segments(stem, answers, studyStore.getMode()).map((part) => {
    const text = part.isAnswer ? part.text.slice(1, -1) : part.text;
    return Object.assign({}, part, { text, isBlank: text === '____', isFilled: Boolean(part.isAnswer) });
  });
  return Object.assign({}, item, { parts, answerText: answerText ? prefix + answerText : '', answerVisible: false, title: item.title || item.stem || '收藏考点' });
}

Page({
  data: { categoryRows: [], categoryId: '', activeCategoryElement: '', activeCategoryRow: 'literature', sourceFilter: 'literature', mode: 'writing', questions: [], hasQuestions: false, pageNumber: 0, pageCount: 0, totalFavorites: 0, todayAdded: 0, nextLabel: '下一页', loading: true, hasError: false, errorMessage: '', dataSource: 'local', personalError: '', requiresLogin: false },
  onLoad(options = {}) { this._categories = dataService.getCategories('favorites'); this._pageIndex = 0; this._categoryId = options.categoryId || ''; this._sourceFilter = options.source === 'classical' ? 'classical' : 'literature'; this._remoteRows = []; this._remoteLoaded = false; this._stateInFlight = Object.create(null); this._ready = true; this._setupCategories(); this._refreshFavorites(); },
  onShow() { if (this._ready) this._refreshFavorites(); },
  _setupCategories() {
    const localState = studyStore.getState(); const favorites = new Set(localState.favorites);
    if (this._categoryId && !this._categories.some((category) => category.id === this._categoryId)) this._categoryId = '';
    const literary = this._categories.filter((category) => category.id.indexOf('classical-') !== 0); const classical = this._categories.filter((category) => category.id.indexOf('classical-') === 0);
    this.setData({ categoryRows: [{ id: 'literature', items: literary }, { id: 'classical', items: classical }], categoryId: this._categoryId, activeCategoryElement: `category-${this._categoryId}`, activeCategoryRow: this._categoryId.indexOf('classical-') === 0 ? 'classical' : 'literature', sourceFilter: this._sourceFilter, mode: studyStore.getMode() });
  },
  async _refreshFavorites() {
    if (this._isLoading) return;
    this._isLoading = true;
    this.setData({ loading: true, hasError: false, errorMessage: '', requiresLogin: false });
    if (hasToken()) {
      const result = await settle(this._loadRemoteFavorites());
      this._isLoading = false;
      if (result.ok) { this._remoteLoaded = true; this._remoteRows = result.value.rows; this._renderRemote(result.value); return; }
      if (result.error && (result.error.status === 401 || result.error.code === 'INVALID_TOKEN')) { this.setData({ loading: false, hasError: true, errorMessage: errorText(result.error), requiresLogin: true, questions: [], hasQuestions: false, pageNumber: 0, pageCount: 0, totalFavorites: 0, dataSource: 'remote' }); return; }
      if (result.error && result.error.status === 403) { this.setData({ loading: false, hasError: true, errorMessage: errorText(result.error), questions: [], hasQuestions: false, pageNumber: 0, pageCount: 0, totalFavorites: 0, dataSource: 'remote' }); return; }
      if (result.error && result.error.code === 'NETWORK_ERROR') { this._renderLocal(result.error); return; }
      this.setData({ loading: false, hasError: true, errorMessage: errorText(result.error), questions: [], hasQuestions: false, dataSource: 'remote' }); return;
    }
    this._isLoading = false;
    this._renderLocal();
  },
  async _loadRemoteFavorites() {
    let response = await api.learning.favorites({ page: 1 });
    const rows = this._extractRows(response);
    let next = response && response.next;
    while (next) {
      response = await api.pagination.follow(next, { auth: true });
      rows.push(...this._extractRows(response));
      next = response && response.next;
    }
    return { rows, count: Number(response && response.count) || rows.length };
  },
  _extractRows(payload) { const rows = payload && Array.isArray(payload.results) ? payload.results : (Array.isArray(payload) ? payload : []); return rows.map(normalizeFavoriteRow).filter((item) => item.id); },
  _renderRemote(payload) {
    const filtered = this._remoteRows.filter((item) => this._matchesCategory(item)).map(decorateFavorite);
    // 原型在来源筛选下展示该分类的完整收藏列表，页面没有分页控件；不要截断超过 5 条的收藏。
    this._pageIndex = 0;
    this.setData({ loading: false, hasError: false, errorMessage: '', dataSource: 'remote', personalError: '', mode: studyStore.getMode(), questions: filtered, hasQuestions: filtered.length > 0, pageNumber: filtered.length ? 1 : 0, pageCount: filtered.length ? 1 : 0, totalFavorites: Number(payload && payload.count) || this._remoteRows.length, todayAdded: 0, nextLabel: '下一页' });
  },
  _matchesCategory(question) {
    if (question.source && question.source !== this._sourceFilter) return false;
    if (!this._categoryId) return true;
    const categoryId = question.categoryId || (question.category && question.category.id);
    if (categoryId === this._categoryId) return true;
    if (this._categoryId.indexOf('classical-') === 0) return question.source === 'classical' && question.type === this._categoryId.slice(10);
    return false;
  },
  _renderLocal(error) {
    const state = studyStore.getState(); const favoriteIds = new Set(state.favorites); const items = dataService.getQuestions({ source: this._sourceFilter }).filter((question) => favoriteIds.has(question.id)); const questions = dataService.decorateQuestions(items);
    this._pageIndex = 0;
    this.setData({ loading: false, dataSource: 'local', personalError: error ? errorText(error) : '', hasError: false, errorMessage: '', categoryId: this._categoryId, sourceFilter: this._sourceFilter, mode: state.mode, questions: questions.map(decorateFavorite), hasQuestions: questions.length > 0, pageNumber: questions.length ? 1 : 0, pageCount: questions.length ? 1 : 0, totalFavorites: favoriteIds.size, todayAdded: 0, nextLabel: '下一页' });
  },
  onRetry() { this._refreshFavorites(); },
  onLogin() { if (api.auth && api.auth.login) api.auth.login().then(() => this._refreshFavorites()).catch((error) => this.setData({ personalError: errorText(error) })); },
  onCategoryChange(event) { const categoryId = event.currentTarget.dataset.id; if (categoryId === this._categoryId) return; this._categoryId = categoryId; this._pageIndex = 0; this.setData({ categoryId, activeCategoryElement: `category-${categoryId}`, activeCategoryRow: categoryId.indexOf('classical-') === 0 ? 'classical' : 'literature' }); this._refreshFavorites(); },
  onModeChange(event) { const mode = event.detail.mode; if (mode !== 'writing' && mode !== 'reciting') return; studyStore.setMode(mode); this.setData({ mode }); },
  onSourceChange(event) { const source = event.currentTarget.dataset.source; if (source !== 'literature' && source !== 'classical') return; this._sourceFilter = source; this._categoryId = ''; this._pageIndex = 0; this.setData({ sourceFilter: source, categoryId: '', activeCategoryElement: '', activeCategoryRow: source }); this._refreshFavorites(); },
  onToggleAnswer(event) { const id = event.currentTarget.dataset.id; const questions = this.data.questions.map((item) => item.id === id ? Object.assign({}, item, { answerVisible: !item.answerVisible }) : item); this.setData({ questions, hasQuestions: questions.length > 0 }); },
  onManage() { if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: '点击星标可取消收藏', icon: 'none' }); },
  onTab(event) { const page = event.currentTarget.dataset.page; if (page === 'home') navigation.openPage('/pages/home/index'); if (page === 'mine') navigation.openPage('/pages/mine/index'); },
  async _updateState(id, field) {
    if (!id) return;
    const lockKey = `${field}:${id}`;
    if (!this._stateInFlight) this._stateInFlight = Object.create(null);
    if (this._stateInFlight[lockKey]) return;
    this._stateInFlight[lockKey] = true;
    try {
      if (!hasToken()) { studyStore[field === 'favorite' ? 'toggleFavorite' : 'toggleMastered'](id); this._renderLocal(); this.setData({ personalError: '当前未登录，已保存到本地；登录后可同步' }); return; }
      const currentResult = await settle(api.learning.questionState(id)); if (!currentResult.ok) { this.setData({ personalError: errorText(currentResult.error) }); return; }
      const current = normalizeState(currentResult.value); const next = !current[field];
      const createWriteOptions = () => {
        const idempotencyKey = api.createIdempotencyKey ? api.createIdempotencyKey() : '';
        return idempotencyKey ? { idempotencyKey } : undefined;
      };
      let result = await settle(api.learning.setQuestionState(id, { [field]: next, baseVersion: current.version }, createWriteOptions()));
      if (!result.ok && result.error && result.error.code === 'VERSION_CONFLICT') { const server = result.error.current || result.error.fields && result.error.fields.current; if (server) result = await settle(api.learning.setQuestionState(id, { [field]: next, baseVersion: normalizeState(server).version }, createWriteOptions())); }
      if (!result.ok) { this.setData({ personalError: errorText(result.error) }); return; }
      this.setData({ personalError: '' }); this._pageIndex = 0; this._refreshFavorites();
    } finally {
      delete this._stateInFlight[lockKey];
    }
  },
  onFavorite(event) { const id = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.id : event && event.detail && event.detail.id; return this._updateState(id, 'favorite'); },
  onMaster(event) { return this._updateState(event.detail.id, 'mastered'); },
  onGoStudy() { if (this._sourceFilter === 'classical' || this._categoryId.indexOf('classical-') === 0) navigation.openPage('/pages/classical/index'); else navigation.openPage('/pages/literature/index', this._categoryId ? { categoryId: this._categoryId } : undefined); }
});

const dataService = require('../../services/data-service');
const studyStore = require('../../utils/study-store');
const api = require('../../services/api');
const navigation = require('../../utils/navigation');

const PAGE_SIZE = 5;
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
  const state = normalizeState(item.state || item);
  if (!question) return { id: String(item.questionId || ''), unavailable: true, unavailableReason: item.unavailableReason || 'ENTITLEMENT_REQUIRED', favorite: state.favorite, mastered: state.mastered, version: state.version, title: '该考点暂不可访问', stem: '当前账号暂无查看此题内容的权限。' };
  return Object.assign({}, question, state, { id: String(question.id || item.questionId || '') });
}

function decorateFavorite(question) {
  const item = question || {};
  const answers = Array.isArray(item.answers) ? item.answers : (item.answer ? [item.answer] : []);
  return Object.assign({}, item, { answerText: answers.filter(Boolean).join('；'), answerVisible: false, title: item.title || item.stem || '收藏考点' });
}

Page({
  data: { categoryRows: [], categoryId: '', activeCategoryElement: '', activeCategoryRow: 'literature', sourceFilter: 'literature', mode: 'writing', questions: [], pageNumber: 0, pageCount: 0, totalFavorites: 0, todayAdded: 0, nextLabel: '下一页', loading: true, hasError: false, errorMessage: '', dataSource: 'local', personalError: '', requiresLogin: false },
  onLoad(options = {}) { this._categories = dataService.getCategories('favorites'); this._pageIndex = 0; this._categoryId = options.categoryId || ''; this._sourceFilter = options.source === 'classical' ? 'classical' : 'literature'; this._remoteRows = []; this._remoteLoaded = false; this._ready = true; this._setupCategories(); this._refreshFavorites(); },
  onShow() { if (this._ready) this._refreshFavorites(); },
  _setupCategories() {
    const localState = studyStore.getState(); const favorites = new Set(localState.favorites);
    if (!this._categories.some((category) => category.id === this._categoryId)) {
      const firstPopulated = this._categories.find((category) => dataService.getQuestions({ categoryId: category.id }).some((question) => favorites.has(question.id)));
      this._categoryId = firstPopulated ? firstPopulated.id : (this._categories[0] && this._categories[0].id) || '';
    }
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
      if (result.error && (result.error.status === 401 || result.error.code === 'INVALID_TOKEN')) { this.setData({ loading: false, hasError: true, errorMessage: errorText(result.error), requiresLogin: true, questions: [], pageNumber: 0, pageCount: 0, totalFavorites: 0, dataSource: 'remote' }); return; }
      if (result.error && result.error.status === 403) { this.setData({ loading: false, hasError: true, errorMessage: errorText(result.error), questions: [], pageNumber: 0, pageCount: 0, totalFavorites: 0, dataSource: 'remote' }); return; }
      if (result.error && result.error.code === 'NETWORK_ERROR') { this._renderLocal(result.error); return; }
      this.setData({ loading: false, hasError: true, errorMessage: errorText(result.error), questions: [], dataSource: 'remote' }); return;
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
    const filtered = this._remoteRows.filter((item) => this._matchesCategory(item)).map(decorateFavorite); const groups = [];
    for (let index = 0; index < filtered.length; index += PAGE_SIZE) groups.push(filtered.slice(index, index + PAGE_SIZE));
    this._pageIndex = Math.max(0, Math.min(this._pageIndex, Math.max(groups.length - 1, 0)));
    const questions = groups[this._pageIndex] || [];
    this.setData({ loading: false, hasError: false, errorMessage: '', dataSource: 'remote', personalError: '', mode: studyStore.getMode(), questions, pageNumber: groups.length ? this._pageIndex + 1 : 0, pageCount: groups.length, totalFavorites: Number(payload && payload.count) || this._remoteRows.length, todayAdded: 0, nextLabel: this._pageIndex >= groups.length - 1 && groups.length > 1 ? '回到第一页' : '下一页' });
  },
  _matchesCategory(question) { if (!this._categoryId) return true; const categoryId = question.categoryId || (question.category && question.category.id); if (categoryId === this._categoryId) return true; if (this._categoryId.indexOf('classical-') === 0) return question.source === 'classical' && question.type === this._categoryId.slice(10); return false; },
  _renderLocal(error) {
    const state = studyStore.getState(); const favoriteIds = new Set(state.favorites); const items = dataService.getQuestions({ source: this._sourceFilter }).filter((question) => favoriteIds.has(question.id)); const groups = [];
    for (let index = 0; index < items.length; index += PAGE_SIZE) groups.push(items.slice(index, index + PAGE_SIZE));
    this._pageIndex = Math.max(0, Math.min(this._pageIndex, Math.max(groups.length - 1, 0))); const questions = dataService.decorateQuestions(groups[this._pageIndex] || []);
    this.setData({ loading: false, dataSource: 'local', personalError: error ? errorText(error) : '', hasError: false, errorMessage: '', categoryId: this._categoryId, sourceFilter: this._sourceFilter, mode: state.mode, questions: questions.map(decorateFavorite), pageNumber: groups.length ? this._pageIndex + 1 : 0, pageCount: groups.length, totalFavorites: favoriteIds.size, todayAdded: 0, nextLabel: this._pageIndex >= groups.length - 1 && groups.length > 1 ? '回到第一页' : '下一页' });
  },
  onRetry() { this._refreshFavorites(); },
  onLogin() { if (api.auth && api.auth.login) api.auth.login().then(() => this._refreshFavorites()).catch((error) => this.setData({ personalError: errorText(error) })); },
  onCategoryChange(event) { const categoryId = event.currentTarget.dataset.id; if (categoryId === this._categoryId) return; this._categoryId = categoryId; this._pageIndex = 0; this.setData({ categoryId, activeCategoryElement: `category-${categoryId}`, activeCategoryRow: categoryId.indexOf('classical-') === 0 ? 'classical' : 'literature' }); this._refreshFavorites(); },
  onModeChange(event) { const mode = event.detail.mode; if (mode !== 'writing' && mode !== 'reciting') return; studyStore.setMode(mode); this.setData({ mode }); },
  onSourceChange(event) { const source = event.currentTarget.dataset.source; if (source !== 'literature' && source !== 'classical') return; this._sourceFilter = source; this._pageIndex = 0; this.setData({ sourceFilter: source }); this._refreshFavorites(); },
  onToggleAnswer(event) { const id = event.currentTarget.dataset.id; const questions = this.data.questions.map((item) => item.id === id ? Object.assign({}, item, { answerVisible: !item.answerVisible }) : item); this.setData({ questions }); },
  onTab(event) { const page = event.currentTarget.dataset.page; if (page === 'home') navigation.openPage('/pages/home/index'); if (page === 'mine') navigation.openPage('/pages/mine/index'); },
  async _updateState(id, field) {
    if (!id) return;
    if (!hasToken()) { studyStore[field === 'favorite' ? 'toggleFavorite' : 'toggleMastered'](id); this._renderLocal(); this.setData({ personalError: '当前未登录，已保存到本地；登录后可同步' }); return; }
    const currentResult = await settle(api.learning.questionState(id)); if (!currentResult.ok) { this.setData({ personalError: errorText(currentResult.error) }); return; }
    const current = normalizeState(currentResult.value); const next = !current[field]; let result = await settle(api.learning.setQuestionState(id, { [field]: next, baseVersion: current.version }));
    if (!result.ok && result.error && result.error.code === 'VERSION_CONFLICT') { const server = result.error.current || result.error.fields && result.error.fields.current; if (server) result = await settle(api.learning.setQuestionState(id, { [field]: next, baseVersion: normalizeState(server).version })); }
    if (!result.ok) { this.setData({ personalError: errorText(result.error) }); return; }
    this.setData({ personalError: '' }); this._pageIndex = 0; this._refreshFavorites();
  },
  onFavorite(event) { return this._updateState(event.detail.id, 'favorite'); },
  onMaster(event) { return this._updateState(event.detail.id, 'mastered'); },
  onNextPage() { if (this.data.pageCount <= 1) return; this._pageIndex = (this._pageIndex + 1) % this.data.pageCount; if (this.data.dataSource === 'remote') this._renderRemote({ count: this.data.totalFavorites }); else this._renderLocal(); if (typeof wx !== 'undefined' && wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 200 }); },
  onGoStudy() { if (this._categoryId.indexOf('classical-') === 0) navigation.openPage('/pages/classical/index'); else navigation.openPage('/pages/literature/index', { categoryId: this._categoryId }); }
});

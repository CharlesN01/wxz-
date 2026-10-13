const dataService = require('../../services/data-service');
const studyStore = require('../../utils/study-store');
const navigation = require('../../utils/navigation');
const api = require('../../services/api');

const GROUP_SIZE = 5;
const PAGE_PATH = '/pages/random/index';
function settle(promise) { return Promise.resolve(promise).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })); }
function hasToken() { try { return Boolean(api.auth && api.auth.getToken && api.auth.getToken()); } catch (_) { return false; } }
function errorText(error) {
  if (error && error.code === 'ENTITLEMENT_REQUIRED') return '随机练习需要先开通学习权益';
  if (error && (error.status === 401 || error.code === 'INVALID_TOKEN')) return '登录状态已失效，请重新登录';
  if (error && error.status === 403) return '当前账号暂无访问权限';
  if (error && error.code === 'NETWORK_ERROR') return '网络暂不可用，当前显示本地演示题目';
  return error && error.message ? String(error.message) : '随机练习加载失败';
}
function normalizeState(value) { return { favorite: Boolean(value && value.favorite), mastered: Boolean(value && value.mastered), version: Number(value && value.version) >= 0 ? Number(value.version) : 0 }; }

Page({
  data: { loading: true, hasError: false, errorMessage: '', dataSource: 'local', personalError: '', source: 'literature', mode: 'writing', sourceName: '文学常识', subtitle: '分组巩固 · 一轮不重复', questions: [], groupNumber: 0, groupCount: 0, roundQuestionCount: 0, groupPageSize: GROUP_SIZE, nextLabel: '下一组' },

  onLoad(options = {}) {
    this._source = options.source === 'classical' ? 'classical' : 'literature';
    this._type = options.type === 'word' || options.type === 'translation' || options.type === 'fact' ? options.type : null;
    this._articleId = options.articleId || null;
    this._groupIndex = 1;
    this._roundId = '';
    this._roundIds = [];
    this._stateMap = {};
    this._resumeVersion = 0;
    this._ready = false;
    const initialMode = options.mode === 'reciting' ? 'reciting' : options.mode === 'writing' ? 'writing' : studyStore.getMode();
    studyStore.setMode(initialMode);
    this.setData({ source: this._source, mode: initialMode, sourceName: this._source === 'classical' ? '文言文' : '文学常识' });
    if (typeof wx !== 'undefined' && typeof wx.request === 'function') this.startRemoteRound(options.resume === '1');
    else { this.startLocalRound(options.resume === '1'); this._ready = true; this.refreshLocalGroup(); }
  },

  onShow() { if (this._ready && this.data.dataSource === 'local') this.refreshLocalGroup(); },

  startLocalRound(restore) {
    const resume = restore ? studyStore.getResume() : null;
    if (resume && resume.path === PAGE_PATH && resume.options && resume.options.source === this._source && Array.isArray(resume.groupIds) && resume.groupIds.length) {
      this._roundIds = resume.groupIds.slice();
      this._groups = [];
      for (let i = 0; i < this._roundIds.length; i += GROUP_SIZE) this._groups.push(this._roundIds.slice(i, i + GROUP_SIZE));
      this._groupIndex = Math.max(1, Math.min(Number(resume.groupIndex) + 1 || 1, this._groups.length || 1));
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
    const questions = ids.map((id) => dataService.getQuestion(id)).filter(Boolean).map((item) => Object.assign({}, item, normalizeState(this._stateMap[item.id])));
    const count = this._groups ? this._groups.length : 0;
    this.setData({ loading: false, questions: dataService.decorateQuestions(questions), groupNumber: count ? this._groupIndex : 0, groupCount: count, roundQuestionCount: this._roundIds.length, nextLabel: this._groupIndex >= count ? '再练一轮' : '下一组' });
    if (count) this.saveResume();
  },

  async startRemoteRound(restore) {
    this.setData({ loading: true, hasError: false, errorMessage: '' });
    if (restore) {
      const savedResult = await settle(api.learning.resume());
      if (!savedResult.ok && savedResult.error && savedResult.error.code === 'NETWORK_ERROR') {
        this.startLocalRound(true); this._ready = true; this.setData({ loading: false, dataSource: 'local', personalError: errorText(savedResult.error) }); this.refreshLocalGroup(); return;
      }
      if (!savedResult.ok) { this.setData({ loading: false, hasError: true, errorMessage: errorText(savedResult.error), questions: [] }); return; }
      const snapshot = savedResult.value || {};
      const saved = snapshot.valid && snapshot.resume ? snapshot.resume : null;
      if (saved && saved.source === this._source && (!this._articleId || saved.articleId === this._articleId) && (!this._type || saved.type === this._type) && saved.roundId && Number(saved.groupIndex) > 0) {
        this._roundId = saved.roundId;
        this._groupIndex = Number(saved.groupIndex);
        this._resumeVersion = Number(snapshot.version) >= 0 ? Number(snapshot.version) : 0;
        if (saved.mode === 'writing' || saved.mode === 'reciting') { this.setData({ mode: saved.mode }); studyStore.setMode(saved.mode); }
        const restored = await this.loadRemoteGroup(this._groupIndex);
        if (restored) return;
        if (!this.data.errorMessage || !this.data.errorMessage.includes('网络')) return;
        this.startLocalRound(true); this.setData({ hasError: false, loading: false, dataSource: 'local', personalError: this.data.errorMessage }); this.refreshLocalGroup(); return;
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
    this.setData({ loading: true, hasError: false });
    const result = await settle(api.practice.group(this._roundId, index));
    if (!result.ok) { this.setData({ loading: false, hasError: true, errorMessage: errorText(result.error), questions: [] }); return false; }
    const payload = result.value || {};
    this._groupIndex = Number(payload.groupIndex) || index;
    this._roundCount = Number(payload.groupCount) || this._roundCount || 0;
    this._roundTotal = Number(payload.totalCount) || this._roundTotal || 0;
    this._groupPageSize = Number(payload.pageSize) > 0 ? Number(payload.pageSize) : this._groupPageSize || GROUP_SIZE;
    const rows = Array.isArray(payload.results) ? payload.results : [];
    await this.loadStates(rows);
    this._roundIds = this._roundIds.concat(rows.map((item) => item.id).filter(Boolean));
    const questions = rows.map((item) => Object.assign({}, item, this._stateMap[item.id] || normalizeState(null)));
    this.setData({ loading: false, dataSource: 'remote', questions, groupNumber: this._groupIndex, groupCount: this._roundCount, roundQuestionCount: this._roundTotal, groupPageSize: this._groupPageSize, nextLabel: this._groupIndex >= this._roundCount ? '再练一轮' : '下一组', personalError: '' });
    this.saveResume();
    return true;
  },

  async loadStates(rows) {
    if (!hasToken()) return;
    const results = await Promise.all(rows.map((item) => settle(api.learning.questionState(item.id))));
    results.forEach((item, index) => { if (item.ok) this._stateMap[rows[index].id] = normalizeState(item.value); });
  },

  saveResume() {
    studyStore.saveResume({ path: PAGE_PATH, options: { source: this._source }, groupIds: this._roundIds.slice(), groupIndex: Math.max(0, this._groupIndex - 1) });
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
          settle(api.learning.saveResume(Object.assign({}, body, { baseVersion: this._resumeVersion }))).then((retry) => { if (retry.ok && Number(retry.value && retry.value.version) >= 0) this._resumeVersion = Number(retry.value.version); });
        }
      }
    });
  },

  onRetry() { if (hasToken()) this.startRemoteRound(false); else { this.startLocalRound(false); this.refreshLocalGroup(); } },
  async onModeChange(event) { const mode = event.detail.mode; if (mode !== 'writing' && mode !== 'reciting' || mode === this.data.mode) return; studyStore.setMode(mode); this.setData({ mode }); if (this.data.dataSource === 'remote') { await this.loadRemoteGroup(this._groupIndex); this.saveResume(); } else this.refreshLocalGroup(); },
  async updateState(id, field) {
    if (!id || !hasToken()) { this.setData({ personalError: '请先登录后同步收藏和掌握状态' }); return; }
    const currentResult = await settle(api.learning.questionState(id)); if (!currentResult.ok) { this.setData({ personalError: errorText(currentResult.error) }); return; }
    const current = normalizeState(currentResult.value); const next = !current[field]; const result = await settle(api.learning.setQuestionState(id, { [field]: next, baseVersion: current.version }));
    if (result.ok) { this._stateMap[id] = normalizeState(result.value); if (this.data.dataSource === 'local') this.refreshLocalGroup(); else this.loadRemoteGroup(this._groupIndex); return; }
    const server = result.error && (result.error.current || result.error.fields && result.error.fields.current);
    if (result.error && result.error.code === 'VERSION_CONFLICT' && server) { const retry = await settle(api.learning.setQuestionState(id, { [field]: next, baseVersion: normalizeState(server).version })); if (retry.ok) { this._stateMap[id] = normalizeState(retry.value); this.loadRemoteGroup(this._groupIndex); return; } }
    this.setData({ personalError: errorText(result.error) });
  },
  onFavorite(event) { return this.updateState(event.detail.id, 'favorite'); },
  onMaster(event) { return this.updateState(event.detail.id, 'mastered'); },
  onNextGroup() {
    if (!this.data.groupCount) return;
    if (this.data.dataSource === 'remote') { if (this._groupIndex >= this._roundCount) { this.startRemoteRound(false); } else this.loadRemoteGroup(this._groupIndex + 1); }
    else { if (this._groupIndex >= this._groups.length) this.startLocalRound(false); else this._groupIndex += 1; this.refreshLocalGroup(); }
    if (typeof wx !== 'undefined' && wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },
  onGoStudy() { navigation.openPage(this._source === 'classical' ? '/pages/classical/index' : '/pages/literature/index'); }
});

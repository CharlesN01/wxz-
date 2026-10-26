const SHARE_TITLE = '文常记｜山东专升本语文';
const SHARE_PATH = '/pages/home/index';
const SHARE_IMAGE = '/assets/share-cover.jpg';
function shareAppMessage() { return { title: SHARE_TITLE, path: SHARE_PATH, imageUrl: SHARE_IMAGE }; }
function shareTimeline() { return { title: SHARE_TITLE, query: '', imageUrl: SHARE_IMAGE }; }
const { withStudyTime } = require('../../utils/study-timer');
const api = require('../../services/api');
const navigation = require('../../utils/navigation');
const { genreOf, genresFrom, readingContent } = require('./reader');

const kinds = [
  { id: 'template', label: '写作模板' },
  { id: 'example', label: '范文示例' },
  { id: 'past_exam', label: '历年真题' },
  { id: 'exercise', label: '专项练习' }
];
function readGlobalTheme() {
  try {
    const value = wx.getStorageSync('chinese-study.theme');
    return value === 'day' || value === 'night' ? value : '';
  } catch (_) { return ''; }
}

Page(withStudyTime({
  data: {
    kinds, items: [], genres: [], detailItems: [], selectedGenre: '', selectedKind: '', selectedKindLabel: '全部内容',
    selected: null, selectedIndex: 0, reader: null, mode: 'template', theme: 'warm', globalTheme: 'day', kindFilterVisible: false,
    originalVisible: false, detailVisible: false, detailLoading: false, detailError: '', loading: true, error: '', restrictedCount: 0
  },
  onLoad() {
    this.syncTheme(true);
    return this.load();
  },
  onShow() {
    this.syncTheme(true);
    if (!this._refreshOnShow) return;
    this._refreshOnShow = false;
    return this.load();
  },
  onHide() {
    this._refreshOnShow = true;
    this._resumeWritingId = this.data.selected && this.data.selected.id;
    this._listRequest = (this._listRequest || 0) + 1;
    this._detailRequest = (this._detailRequest || 0) + 1;
    this.setData({ items: [], genres: [], detailItems: [], selected: null, reader: null,
      loading: true, detailLoading: false, detailVisible: false, error: '', detailError: '', restrictedCount: 0 });
  },
  onUnload() {
    this._listRequest = (this._listRequest || 0) + 1;
    this._detailRequest = (this._detailRequest || 0) + 1;
  },
  syncTheme(allowLegacy) {
    const globalTheme = readGlobalTheme() || (allowLegacy && (() => {
      try { return wx.getStorageSync('application-reader-theme') === 'blue' ? 'night' : 'day'; } catch (_) { return 'day'; }
    })()) || 'day';
    const theme = globalTheme === 'day' ? 'warm' : 'blue';
    if (this.data.globalTheme !== globalTheme || this.data.theme !== theme) this.setData({ globalTheme, theme });
  },
  async loadWritings(params) {
    let response = await api.content.writings(params);
    const access = response && response.access || {};
    const entries = response && Array.isArray(response.results) ? response.results.slice() : [];
    let next = response && response.next;
    const seen = new Set();
    while (next && !seen.has(String(next))) {
      seen.add(String(next));
      response = await api.pagination.follow(next, { basePath: '/api/student/v1/writings/' });
      if (response && Array.isArray(response.results)) entries.push(...response.results);
      next = response && response.next;
    }
    return { entries, count: Number(response && response.count) || entries.length, access };
  },
  async load() {
    this._listRequest = (this._listRequest || 0) + 1;
    const request = this._listRequest;
    this._detailRequest = (this._detailRequest || 0) + 1;
    this.setData({ loading: true, error: '', detailError: '', detailLoading: false, selected: null, reader: null });
    try {
      const result = await this.loadWritings({ page: 1 });
      if (request !== this._listRequest) return;
      const genres = genresFrom(result.entries);
      this.setData({ items: result.entries, genres, loading: false,
        selectedGenre: genres.some((genre) => genre.id === this.data.selectedGenre) ? this.data.selectedGenre : '',
        restrictedCount: Math.max(0, Number(result.access.restrictedCount) || 0) });
      const preferredId = this._resumeWritingId;
      this._resumeWritingId = null;
      return this.filterItems(preferredId);
    } catch (error) {
      if (request === this._listRequest) this.setData({ loading: false, error: error.message || '应用文暂时无法加载' });
    }
  },
  filterItems(preferredId) {
    const entries = this.data.items.filter((item) => (!this.data.selectedGenre || genreOf(item).id === this.data.selectedGenre)
      && (!this.data.selectedKind || item.kind === this.data.selectedKind));
    const kind = kinds.find((item) => item.id === this.data.selectedKind);
    this._detailRequest = (this._detailRequest || 0) + 1;
    const selectedIndex = Math.max(0, entries.findIndex((item) => item.id === preferredId));
    this.setData({ detailItems: entries, selectedIndex, selectedKindLabel: kind ? kind.label : '全部内容',
      selected: null, reader: null, detailVisible: Boolean(entries.length), detailLoading: false, detailError: '', originalVisible: false });
    return entries[selectedIndex] ? this.loadDetail(entries[selectedIndex]) : Promise.resolve();
  },
  chooseGenre(event) {
    const id = event.currentTarget.dataset.id || '';
    if (id && !this.data.genres.some((genre) => genre.id === id)) return;
    this.setData({ selectedGenre: id, mode: 'template' });
    return this.filterItems();
  },
  async chooseKind(event) {
    const kind = event.currentTarget.dataset.kind || '';
    if (kind && !kinds.some((entry) => entry.id === kind)) return;
    this.setData({ selectedKind: kind, mode: 'template' });
    if (!kind || this.data.items.some((entry) => entry.kind === kind)) return this.filterItems();
    const request = this._listRequest;
    this._detailRequest = (this._detailRequest || 0) + 1;
    this.setData({ detailLoading: true, detailError: '', selected: null, reader: null });
    try {
      const result = await this.loadWritings({ page: 1, kind });
      if (request !== this._listRequest || kind !== this.data.selectedKind) return;
      const existing = new Set(this.data.items.map((item) => item.id));
      const items = this.data.items.concat(result.entries.filter((item) => !existing.has(item.id)));
      this.setData({ items, genres: genresFrom(items) });
      return this.filterItems();
    } catch (error) {
      if (request === this._listRequest && kind === this.data.selectedKind) this.setData({ detailLoading: false,
        detailError: error.message || '该类型暂时无法加载', selected: null, reader: null });
    }
  },
  async loadDetail(item) {
    if (!item || !item.id) return;
    this._detailRequest = (this._detailRequest || 0) + 1;
    const request = this._detailRequest;
    this.setData({ selected: item, reader: null, detailVisible: true, detailLoading: true, detailError: '', originalVisible: false });
    try {
      const response = await api.content.writing(item.id);
      if (request !== this._detailRequest) return;
      const detail = response && (response.writing || response) || item;
      this.setData({ selected: detail, reader: readingContent(detail), detailLoading: false });
    } catch (error) {
      if (request === this._detailRequest) this.setData({ detailLoading: false,
        detailError: error && error.message ? error.message : '正文暂时无法加载' });
    }
  },
  retryDetail() {
    return this.data.selected ? this.loadDetail(this.data.selected)
      : this.chooseKind({ currentTarget: { dataset: { kind: this.data.selectedKind } } });
  },
  openItem(event) {
    const id = event.currentTarget.dataset.id;
    const item = this.data.items.find((entry) => String(entry.id) === String(id));
    if (!item) return;
    const selectedIndex = this.data.detailItems.findIndex((entry) => String(entry.id) === String(id));
    if (selectedIndex >= 0) this.setData({ selectedIndex });
    return this.loadDetail(item);
  },
  changePage(event) {
    const next = this.data.selectedIndex + Number(event.currentTarget.dataset.direction);
    if (!Number.isInteger(next) || next < 0 || next >= this.data.detailItems.length) return;
    this.setData({ selectedIndex: next });
    return this.loadDetail(this.data.detailItems[next]);
  },
  changeMode(event) {
    const mode = event.currentTarget.dataset.mode;
    if (mode === 'template' || mode === 'points') this.setData({ mode, originalVisible: false });
  },
  changeTheme(event) {
    const theme = event.currentTarget.dataset.theme;
    if (theme !== 'blue' && theme !== 'warm') return;
    const globalTheme = theme === 'warm' ? 'day' : 'night';
    try { wx.setStorageSync('chinese-study.theme', globalTheme); } catch (_) { /* Theme still applies to this visit. */ }
    try { wx.setStorageSync('application-reader-theme', theme); } catch (_) { /* Theme still applies to this visit. */ }
    this.setData({ theme, globalTheme });
  },
  toggleKinds() { this.setData({ kindFilterVisible: !this.data.kindFilterVisible }); },
  toggleOriginal() { this.setData({ originalVisible: !this.data.originalVisible }); },
  openMembership() { this._refreshOnShow = true; navigation.openPage('/pages/mine/index'); },
  retry() { return this.load(); },
  back() { navigation.openPage('/pages/home/index'); },
  onShareAppMessage() { return shareAppMessage(); },
  onShareTimeline() { return shareTimeline(); }
}, (page) => Boolean(!page.data.loading && page.data.detailVisible && !page.data.detailLoading
  && !page.data.detailError && page.data.selected && page.data.selected.body && page.data.reader
  && (page.data.originalVisible || (page.data.mode === 'points' ? page.data.reader.points.length
    : page.data.reader.sample || page.data.reader.requirement)))));

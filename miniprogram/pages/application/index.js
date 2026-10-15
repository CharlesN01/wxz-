const api = require('../../services/api');
const navigation = require('../../utils/navigation');

const kinds = [
  { id: 'template', label: '写作模板', icon: '模', description: '常考文种结构与规范模板' },
  { id: 'example', label: '范文示例', icon: '例', description: '高频文种优秀范文拆解' },
  { id: 'past_exam', label: '历年真题', icon: '题', description: '精选历年考题与答题思路' },
  { id: 'exercise', label: '专项练习', icon: '练', description: '按文种完成写作训练' }
];

Page({
  data: { kinds, items: [], detailItems: [], selectedKind: '', selectedKindLabel: '', selected: null, detailIntro: '按模块练习，逐步掌握应用文写作。', detailFallback: false, detailVisible: false, detailLoading: false, detailError: '', loading: true, error: '' },
  onLoad() { this.load(); },
  async loadWritings(params) {
    let response = await api.content.writings(params);
    const entries = response && Array.isArray(response.results) ? response.results.slice() : [];
    let next = response && response.next;
    const seen = new Set();
    while (next && !seen.has(String(next))) {
      seen.add(String(next));
      response = await api.pagination.follow(next, { basePath: '/api/student/v1/writings/' });
      if (response && Array.isArray(response.results)) entries.push(...response.results);
      next = response && response.next;
    }
    return { entries, count: Number(response && response.count) || entries.length };
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await this.loadWritings({ page: 1 });
      this.setData({ items: result.entries, loading: false });
    } catch (error) {
      this.setData({ loading: false, error: error.message || '应用文暂时无法加载' });
    }
  },
  chooseKind(event) {
    const kind = event.currentTarget.dataset.kind;
    const kindInfo = kinds.find((entry) => entry.id === kind);
    const item = this.data.items.find((entry) => entry.kind === kind);
    if (item) {
      this.setData({ selectedKind: kind, selectedKindLabel: kindInfo ? kindInfo.label : '应用文', selected: item, detailItems: [item], detailIntro: '按模块练习，逐步掌握应用文写作。', detailFallback: false, detailError: '', detailVisible: true });
      this.loadDetail(item);
      return;
    }
    this.loadWritings({ page: 1, kind }).then((result) => {
      const entries = result.entries;
      this.setData({ selectedKind: kind, selectedKindLabel: entries.length ? (kindInfo ? kindInfo.label : '应用文') : '应用文', items: this.data.items.concat(entries), detailItems: entries, selected: entries[0] || null, detailIntro: entries.length ? '按模块练习，逐步掌握应用文写作。' : '山东专升本应用文学习', detailFallback: entries.length === 0, detailError: '', detailVisible: true });
    }).catch((error) => {
      const message = error && error.message ? error.message : '该模块暂时无法加载';
      this.setData({
        selectedKind: kind,
        selectedKindLabel: kindInfo ? kindInfo.label : '应用文',
        detailItems: [],
        selected: null,
        detailIntro: '山东专升本应用文学习',
        detailFallback: false,
        detailError: message,
        detailVisible: true
      });
    });
  },
  async loadDetail(item) {
    if (!item || !item.id) return;
    this.setData({ selected: item, detailVisible: true, detailLoading: true, detailError: '' });
    try {
      const detail = await api.content.writing(item.id);
      this.setData({ selected: detail && (detail.writing || detail) || item, detailLoading: false });
    } catch (error) {
      this.setData({ detailLoading: false, detailError: error && error.message ? error.message : '正文暂时无法加载' });
    }
  },
  retryDetail() {
    return this.data.selected ? this.loadDetail(this.data.selected) : Promise.resolve();
  },
  openItem(event) {
    const id = event.currentTarget.dataset.id;
    const item = this.data.items.find((entry) => String(entry.id) === String(id));
    if (!item) return;
    this.loadDetail(item);
  },
  openStudy() { this.chooseKind({ currentTarget: { dataset: { kind: 'exercise' } } }); },
  closeDetail() { this.setData({ selected: null, detailFallback: false, detailVisible: false }); },
  retry() { this.load(); },
  back() { navigation.openPage('/pages/home/index'); }
});

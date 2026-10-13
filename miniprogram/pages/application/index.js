const api = require('../../services/api');
const navigation = require('../../utils/navigation');

const kinds = [
  { id: 'template', label: '写作模板', icon: '模', description: '常考文种结构与规范模板' },
  { id: 'example', label: '范文示例', icon: '例', description: '高频文种优秀范文拆解' },
  { id: 'past_exam', label: '历年真题', icon: '题', description: '精选历年考题与答题思路' },
  { id: 'exercise', label: '专项练习', icon: '练', description: '按文种完成写作训练' }
];

Page({
  data: { kinds, items: [], selectedKind: '', selected: null, loading: true, error: '' },
  onLoad() { this.load(); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await api.content.writings({ page: 1 });
      this.setData({ items: result && Array.isArray(result.results) ? result.results : [], loading: false });
    } catch (error) {
      this.setData({ loading: false, error: error.message || '应用文暂时无法加载' });
    }
  },
  chooseKind(event) {
    const kind = event.currentTarget.dataset.kind;
    const item = this.data.items.find((entry) => entry.kind === kind);
    if (item) { this.setData({ selectedKind: kind, selected: item }); return; }
    api.content.writings({ page: 1, kind }).then((result) => {
      const entries = result && Array.isArray(result.results) ? result.results : [];
      this.setData({ selectedKind: kind, items: this.data.items.concat(entries), selected: entries[0] || null });
    }).catch((error) => wx.showToast({ title: error.message || '加载失败', icon: 'none' }));
  },
  openItem(event) {
    const id = event.currentTarget.dataset.id;
    const item = this.data.items.find((entry) => String(entry.id) === String(id));
    if (item) this.setData({ selected: item });
  },
  closeDetail() { this.setData({ selected: null }); },
  retry() { this.load(); },
  back() { navigation.openPage('/pages/home/index'); }
});

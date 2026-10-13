const api = require('../../services/api');

Page({
  data: { resource: null, loading: true, error: '', copied: false },
  onLoad() { this.load(); },
  async load() {
    this.setData({ loading: true, error: '' });
    try { this.setData({ resource: await api.resources.group(), loading: false }); }
    catch (error) { this.setData({ loading: false, error: error.message || '资料群配置暂时无法加载' }); }
  },
  copyCode() {
    const code = this.data.resource && this.data.resource.claimCode;
    if (!code) { wx.showToast({ title: '暂无领取口令', icon: 'none' }); return; }
    wx.setClipboardData({ data: code, success: () => this.setData({ copied: true }) });
  },
  previewQr() {
    const url = this.data.resource && this.data.resource.groupQrCode;
    if (url) wx.previewImage({ urls: [url] });
    else wx.showToast({ title: '二维码暂未配置', icon: 'none' });
  },
  retry() { this.load(); }
});

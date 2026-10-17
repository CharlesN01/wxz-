const api = require('../../services/api');

Page({
  data: {
    resource: null,
    loading: true,
    error: '',
    copied: false,
    qrCode: '',
    wechatId: '',
    announcement: '',
    qrDescription: '资料领取配置完成后，将在这里显示领取方式。',
    heroCopy: '资料领取配置完成后，将在这里显示领取方式。',
    canCopy: false,
    copyButtonText: '领取口令暂未配置',
    copiedText: '领取口令已复制'
  },
  onLoad() {},
  onShow() { this.load(); },
  onPullDownRefresh() { this.load(); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const resource = await api.resources.group();
      const claimCode = resource && resource.enabled && resource.claimCode ? resource.claimCode : '';
      const qrDescription = resource && resource.enabled
        ? resource.description || (claimCode ? '添加后回复“' + claimCode + '”，即可获取资料' : '添加微信后按页面提示领取资料')
        : '资料领取配置完成后，将在这里显示领取方式。';
      const heroCopy = resource && resource.enabled
        ? (claimCode ? '添加微信好友，发送“' + claimCode + '”，领取学习资料与备考提醒。' : '添加微信好友，按页面提示领取学习资料与备考提醒。')
        : '资料领取配置完成后，将在这里显示领取方式。';
      this.setData({
        resource: resource || null,
        loading: false,
        qrCode: resource && resource.enabled && resource.groupQrCode ? resource.groupQrCode : '',
        wechatId: resource && resource.enabled ? resource.wechatId || '' : '',
        announcement: resource && resource.enabled ? resource.announcement || '' : '',
        qrDescription,
        heroCopy,
        canCopy: Boolean(claimCode),
        copyButtonText: claimCode ? '复制领取口令：' + claimCode : '领取口令暂未配置',
        copiedText: claimCode ? '口令“' + claimCode + '”已复制' : '领取口令已复制',
        copied: false
      });
    }
    catch (error) { this.setData({ loading: false, error: error.message || '资料群配置暂时无法加载' }); }
    finally {
      if (typeof wx !== 'undefined' && typeof wx.stopPullDownRefresh === 'function') wx.stopPullDownRefresh();
    }
  },
  copyCode() {
    const resource = this.data.resource;
    const code = resource && resource.enabled && resource.claimCode;
    if (!code) { wx.showToast({ title: '暂无领取口令', icon: 'none' }); return; }
    wx.setClipboardData({ data: code, success: () => this.setData({ copied: true }) });
  },
  previewQr() {
    const url = this.data.qrCode;
    if (url) wx.previewImage({ urls: [url] });
    else wx.showToast({ title: '二维码暂未配置', icon: 'none' });
  },
  retry() { this.load(); }
});

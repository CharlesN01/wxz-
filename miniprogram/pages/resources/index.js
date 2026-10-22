const api = require('../../services/api');
const { resourceImageUrl, retryImageUrl } = require('../../utils/resource-image');
function currentTheme() { try { return wx.getStorageSync('chinese-study.theme') === 'night' ? 'night' : 'day'; } catch (_) { return 'day'; } }

Page({
  data: {
    theme: 'day',
    resource: null,
    loading: true,
    error: '',
    copied: false,
    qrCode: '',
    qrLoading: false,
    qrError: '',
    wechatId: '',
    announcement: '',
    qrDescription: '资料领取配置完成后，将在这里显示领取方式。',
    heroCopy: '资料领取配置完成后，将在这里显示领取方式。',
    canCopy: false,
    copyButtonText: '领取口令暂未配置',
    copiedText: '领取口令已复制'
  },
  onLoad() {},
  onShow() { this.setData({ theme: currentTheme() }); this.load(); },
  onPullDownRefresh() { this.load(); },
  async load(options) {
    this.setData({ loading: true, error: '', qrCode: '', qrLoading: false, qrError: '' });
    try {
      const resource = await api.resources.group();
      const claimCode = resource && resource.enabled && resource.claimCode ? resource.claimCode : '';
      const qrDescription = resource && resource.enabled
        ? resource.description || (claimCode ? '添加后回复“' + claimCode + '”，即可获取资料' : '添加微信后按页面提示领取资料')
        : '资料领取配置完成后，将在这里显示领取方式。';
      const heroCopy = resource && resource.enabled
        ? (claimCode ? '添加微信好友，发送“' + claimCode + '”，领取学习资料与备考提醒。' : '添加微信好友，按页面提示领取学习资料与备考提醒。')
        : '资料领取配置完成后，将在这里显示领取方式。';
      const configuredQr = resource && resource.enabled ? resource.groupQrCode : '';
      const qrCode = options && options.retryQr ? retryImageUrl(configuredQr) : resourceImageUrl(configuredQr);
      this.setData({
        resource: resource || null,
        loading: false,
        qrCode,
        qrLoading: Boolean(qrCode),
        qrError: configuredQr && !qrCode ? '二维码地址不可用，请联系管理员检查图片配置。' : '',
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
    if (this.data.qrError) { this.retryQr(); return; }
    if (url) wx.previewImage({ urls: [url] });
    else wx.showToast({ title: '二维码暂未配置', icon: 'none' });
  },
  onQrLoad(event) {
    const source = event && event.currentTarget && event.currentTarget.dataset.source;
    if (source && source !== this.data.qrCode) return;
    this.setData({ qrLoading: false, qrError: '' });
  },
  onQrError(event) {
    const source = event && event.currentTarget && event.currentTarget.dataset.source;
    if (source && source !== this.data.qrCode) return;
    this.setData({ qrLoading: false, qrError: '二维码图片加载失败，点击重试；如仍失败，请联系管理员重新上传。' });
  },
  retryQr() { return this.load({ retryQr: true }); },
  retry() { this.load(); }
});

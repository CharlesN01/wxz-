const api = require('../../services/api');
const navigation = require('../../utils/navigation');

const feedbackTypes = [
  { id: 'feature', label: '功能建议' },
  { id: 'question', label: '题目反馈' },
  { id: 'payment', label: '支付问题' },
  { id: 'account', label: '账号问题' },
  { id: 'other', label: '其他' }
];

function showToast(title) { wx.showToast({ title: String(title || '操作未完成').slice(0, 28), icon: 'none' }); }
function apiMessage(error, fallback) {
  if (error && error.code === 'ALREADY_ACTIVATED') return '已激活';
  if (error && error.code === 'PURCHASE_IN_PROGRESS') return '购买处理中，请查看原订单';
  return error && error.message ? error.message : fallback;
}

Page({
  data: {
    loggedIn: false, userId: '', entitlement: null, stats: null, product: null,
    orders: [], loading: false, feedbackTypes, feedbackType: 'feature',
    activationVisible: false, feedbackVisible: false, ordersVisible: false,
    infoVisible: false, infoTitle: '', infoText: '', activationCode: '',
    feedbackContent: '', feedbackContact: '', busy: false
  },

  onShow() { this.refresh(); },

  async refresh() {
    const session = api.auth.getSession();
    this.setData({ loggedIn: Boolean(session && session.token), userId: session && session.user ? String(session.user.id || '') : '', loading: true });
    const productTask = api.products.list().catch(() => null);
    if (!session || !session.token) {
      const products = await productTask;
      this.setData({ product: products && products.results && products.results[0] || null, loading: false });
      return;
    }
    const results = await Promise.allSettled([
      api.entitlements.current(), api.learning.statistics(), api.learning.preferences(), api.orders.list({ page: 1 })
    ]);
    const products = await productTask;
    const product = products && products.results && products.results[0] || null;
    this.setData({
      entitlement: results[0].status === 'fulfilled' ? results[0].value : null,
      stats: results[1].status === 'fulfilled' ? results[1].value : null,
      preferences: results[2].status === 'fulfilled' ? results[2].value : null,
      orders: results[3].status === 'fulfilled' && results[3].value && Array.isArray(results[3].value.results) ? results[3].value.results : [],
      product, loading: false
    });
  },

  async login() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try { await api.auth.login(); await this.refresh(); showToast('登录成功'); }
    catch (error) { showToast(apiMessage(error, '登录失败，请稍后重试')); }
    finally { this.setData({ busy: false }); }
  },

  async logout() {
    this.setData({ busy: true });
    try { await api.auth.logout(); }
    catch (_) { /* 本地会话仍由 logout finally 清理。 */ }
    this.setData({ entitlement: null, stats: null, orders: [], loggedIn: false, userId: '' });
    this.refresh();
    this.setData({ busy: false });
  },

  openFavorites() { navigation.openPage('/pages/favorites/index'); },
  openTab(event) {
    const page = event.currentTarget.dataset.page;
    if (page === 'home') wx.reLaunch({ url: '/pages/home/index' });
    if (page === 'favorites') navigation.openPage('/pages/favorites/index');
  },
  openOrders() {
    if (!this.data.loggedIn) { showToast('请先登录'); return; }
    this.setData({ ordersVisible: true });
  },
  closeOrders() { this.setData({ ordersVisible: false }); },
  openActivation() {
    if (!this.data.loggedIn) { showToast('请先登录'); return; }
    this.setData({ activationVisible: true, activationCode: '' });
  },
  closeActivation() { this.setData({ activationVisible: false }); },
  onActivationInput(event) { this.setData({ activationCode: event.detail.value || '' }); },

  async redeem() {
    const code = String(this.data.activationCode || '').trim();
    if (!code || this.data.busy) { if (!code) showToast('请输入激活码'); return; }
    this.setData({ busy: true });
    try {
      const result = await api.activation.redeem(code);
      this.setData({ entitlement: result.entitlement || this.data.entitlement, activationVisible: false });
      await this.refresh();
      showToast('兑换成功，权益已更新');
    } catch (error) {
      if (error && error.code === 'ALREADY_ACTIVATED') { this.setData({ activationVisible: false }); await this.refresh(); }
      showToast(apiMessage(error, '兑换失败，请检查激活码'));
    } finally { this.setData({ busy: false, activationCode: '' }); }
  },

  channelForDevice() {
    let platform = '';
    try {
      const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
      platform = String(info.platform || '').toLowerCase();
    } catch (_) {}
    return platform === 'android' || platform === 'ios' ? platform : '';
  },

  async purchase() {
    if (this.data.busy) return;
    if (!this.data.loggedIn) { await this.login(); if (!api.auth.getToken()) return; }
    const product = this.data.product;
    if (this.data.entitlement && this.data.entitlement.active) { showToast('已激活'); return; }
    const channel = this.channelForDevice();
    if (!channel) { showToast('请在支持的微信设备上购买'); return; }
    if (!product || !product.purchaseAvailable || !product.paymentChannels || !product.paymentChannels[channel]) {
      showToast(product && product.unavailableReason ? product.unavailableReason : '当前支付渠道暂不可用');
      return;
    }
    this.setData({ busy: true });
    try {
      const created = await api.orders.create({ productId: product.id, channel });
      const order = created && created.order;
      if (!order || !order.id) throw new Error('订单创建结果无效');
      const prepared = await api.orders.preparePayment(order.id);
      if (!prepared || !prepared.payment) {
        await this.refresh();
        showToast('订单处理中，请查看订单状态');
        return;
      }
      if (typeof wx.requestVirtualPayment !== 'function') throw new Error('当前微信环境不支持虚拟支付');
      await new Promise((resolve, reject) => wx.requestVirtualPayment({
        ...api.payment.toVirtualPaymentArgs(prepared.payment),
        success: resolve,
        fail: reject
      }));
      await api.orders.queryPayment(order.id);
      await this.refresh();
      showToast(this.data.entitlement && this.data.entitlement.active ? '权益已开通' : '支付已提交，正在确认');
    } catch (error) {
      await this.refresh();
      showToast(apiMessage(error, '购买未完成，可在订单中查看状态'));
    } finally { this.setData({ busy: false }); }
  },

  openFeedback() {
    if (!this.data.loggedIn) { showToast('请先登录'); return; }
    this.setData({ feedbackVisible: true, feedbackContent: '', feedbackContact: '', feedbackType: 'feature' });
  },
  closeFeedback() { this.setData({ feedbackVisible: false }); },
  onFeedbackType(event) { this.setData({ feedbackType: event.currentTarget.dataset.type }); },
  onFeedbackContent(event) { this.setData({ feedbackContent: event.detail.value || '' }); },
  onFeedbackContact(event) { this.setData({ feedbackContact: event.detail.value || '' }); },
  async submitFeedback() {
    const content = String(this.data.feedbackContent || '').trim();
    if (!content || this.data.busy) { if (!content) showToast('请填写反馈内容'); return; }
    this.setData({ busy: true });
    try {
      await api.feedback.submit({ type: this.data.feedbackType, content, contact: String(this.data.feedbackContact || '').trim() });
      this.setData({ feedbackVisible: false });
      showToast('反馈已提交');
    } catch (error) { showToast(apiMessage(error, '提交失败，请稍后重试')); }
    finally { this.setData({ busy: false }); }
  },

  openInfo(event) {
    const kind = event.currentTarget.dataset.kind;
    const info = {
      refund: ['退费规则', '退费规则尚未由服务端发布，请在购买前确认官方渠道已公布的规则。'],
      agreement: ['服务协议与隐私', '服务协议与隐私政策尚未配置。正式上线前应展示经确认的完整文本。'],
      customer: ['联系客服', '客服入口暂未配置，请通过已公布的官方渠道联系。']
    }[kind];
    this.setData({ infoTitle: info[0], infoText: info[1], infoVisible: true });
  },
  closeInfo() { this.setData({ infoVisible: false }); },
  onMaskTap() {},
  retry() { this.refresh(); }
});

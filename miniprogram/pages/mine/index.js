const api = require('../../services/api');
const navigation = require('../../utils/navigation');
const agentAttribution = require('../../utils/agent-attribution');
const { orderView } = require('../../utils/order-view');

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
  if (error && error.code === 'PURCHASE_IN_PROGRESS') return '订单待支付，2分钟超时自动取消';
  return error && error.message ? error.message : fallback;
}

Page({
  data: {
    loggedIn: false, userId: '', entitlement: null, stats: null, product: null,
    orders: [], loading: false, error: '', feedbackTypes, feedbackType: 'feature',
    activationVisible: false, feedbackVisible: false, ordersVisible: false,
    infoVisible: false, infoTitle: '', infoText: '', infoKind: '', memberVisible: false, activationCode: '', activationError: '',
    selectedOrder: null, orderDetailVisible: false, orderDetailLoading: false, orderDetailError: '',
    voucherVisible: false, voucherCode: '', voucherMask: '', voucherOrderId: '', voucherError: '',
    feedbackContent: '', feedbackContact: '', busy: false
  },

  onShow() { this.refresh(); },
  onHide() { this.clearOrderExpiryTimer(); },
  onUnload() { this.clearOrderExpiryTimer(); },

  clearOrderExpiryTimer() {
    if (this._orderExpiryTimer && typeof clearTimeout === 'function') clearTimeout(this._orderExpiryTimer);
    this._orderExpiryTimer = null;
  },

  scheduleOrderExpiry() {
    this.clearOrderExpiryTimer();
    if (typeof setTimeout !== 'function') return;
    const deadlines = this.data.orders.filter(order => ['created', 'preparing'].includes(order.status))
      .map(order => Date.parse(order.expiresAt)).filter(Number.isFinite);
    if (!deadlines.length) return;
    this._orderExpiryTimer = setTimeout(() => {
      this._orderExpiryTimer = null;
      this.refresh();
    }, Math.max(1000, Math.min(...deadlines) - Date.now() + 250));
  },

  async loadOrders() {
    let response = await api.orders.list({ page: 1 });
    const orders = response && Array.isArray(response.results) ? response.results.slice() : [];
    let next = response && response.next;
    const seen = new Set();
    while (next && !seen.has(String(next))) {
      seen.add(String(next));
      response = await api.pagination.follow(next, { auth: true, basePath: '/api/student/v1/orders/' });
      if (response && Array.isArray(response.results)) orders.push(...response.results);
      next = response && response.next;
    }
    return orders;
  },

  async refresh() {
    const session = api.auth.getSession();
    this.setData({ loggedIn: Boolean(session && session.token), userId: session && session.user ? String(session.user.id || '') : '', loading: true, error: '' });
    const productTask = api.products.list().catch(() => null);
    if (!session || !session.token) {
      this.clearOrderExpiryTimer();
      const products = await productTask;
      this.setData({ product: products && products.results && products.results[0] || null, loading: false });
      return;
    }
    const results = await Promise.allSettled([
      api.entitlements.current(), api.learning.statistics(), api.learning.preferences(), this.loadOrders()
    ]);
    const products = await productTask;
    const product = products && products.results && products.results[0] || null;
    const failed = results.filter((result) => result.status === 'rejected');
    const authFailure = failed.some((result) => result.reason && (result.reason.status === 401 || result.reason.code === 'INVALID_TOKEN'));
    if (authFailure) {
      this.clearOrderExpiryTimer();
      this.setData({ loggedIn: false, userId: '', entitlement: null, stats: null, preferences: null, orders: [], product, loading: false, error: '登录状态已失效，请重新登录' });
      return;
    }
    this.setData({
      entitlement: results[0].status === 'fulfilled' ? results[0].value : null,
      stats: results[1].status === 'fulfilled' ? results[1].value : null,
      preferences: results[2].status === 'fulfilled' ? results[2].value : null,
      orders: results[3].status === 'fulfilled' && Array.isArray(results[3].value) ? results[3].value.map(orderView) : [],
      product, loading: false, error: failed.length ? '部分账户数据暂时无法加载' : ''
    });
    if (this.data.selectedOrder) {
      const currentOrder = this.data.orders.find(order => order.id === this.data.selectedOrder.id);
      if (currentOrder) this.setData({ selectedOrder: currentOrder });
    }
    this.scheduleOrderExpiry();
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

  goBack() {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    if (pages.length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/home/index' });
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
  async openOrder(event) {
    const id = event.currentTarget.dataset.id;
    if (!id || this.data.orderDetailLoading) return;
    this.setData({ selectedOrder: this.data.orders.find((order) => String(order.id) === String(id)) || null, ordersVisible: false, orderDetailVisible: true, orderDetailLoading: true, orderDetailError: '' });
    try {
      const detail = await api.orders.detail(id);
      this.setData({ selectedOrder: orderView(detail && (detail.order || detail) || this.data.selectedOrder), orderDetailLoading: false });
    } catch (error) {
      this.setData({ orderDetailLoading: false, orderDetailError: error && error.message ? error.message : '订单详情暂时无法加载' });
    }
  },
  closeOrderDetail() { this.setData({ orderDetailVisible: false, selectedOrder: null, orderDetailError: '' }); },
  closeVoucher() { this.setData({ voucherVisible: false, voucherCode: '', voucherMask: '', voucherOrderId: '', voucherError: '' }); },
  copyVoucher() {
    if (!this.data.voucherCode || typeof wx.setClipboardData !== 'function') return;
    wx.setClipboardData({ data: this.data.voucherCode, success: () => showToast('激活码已复制') });
  },
  redeemVoucher() {
    if (!this.data.voucherCode) { showToast('原激活码仅展示一次，请先复制'); return; }
    this.setData({ activationVisible: true, activationCode: this.data.voucherCode, activationError: '', voucherVisible: false });
  },
  openActivation() {
    if (!this.data.loggedIn) { showToast('请先登录'); return; }
    this.setData({ activationVisible: true, activationCode: '', activationError: '' });
  },
  closeActivation() { this.setData({ activationVisible: false, activationCode: '', activationError: '' }); },
  openMembership() { this.setData({ memberVisible: true }); },
  closeMembership() { this.setData({ memberVisible: false }); },
  chooseMembership() { this.setData({ memberVisible: false }); return this.purchase(); },
  onActivationInput(event) { this.setData({ activationCode: event.detail.value || '', activationError: '' }); },

  async redeem() {
    const code = String(this.data.activationCode || '').trim();
    if (!code || this.data.busy) { if (!code) showToast('请输入激活码'); return; }
    this.setData({ busy: true, activationError: '' });
    try {
      const result = await api.activation.redeem(code);
      if (!result.entitlement || !result.entitlement.active) {
        this.setData({ entitlement: result.entitlement || this.data.entitlement, activationError: '服务端尚未确认权益生效，请刷新后重试。' });
        return;
      }
      this.setData({ entitlement: result.entitlement, activationVisible: false, activationCode: '', voucherCode: '' });
      await this.refresh();
      showToast('兑换成功，权益已更新');
    } catch (error) {
      if (error && error.code === 'ALREADY_ACTIVATED') { this.setData({ activationVisible: false, activationCode: '' }); await this.refresh(); }
      const message = apiMessage(error, '兑换失败，请检查激活码');
      this.setData({ activationError: message });
      showToast(message);
    } finally { this.setData({ busy: false }); }
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
      const created = await api.orders.create({ productId: product.id, channel, agentScene: agentAttribution.read() });
      const order = created && created.order;
      if (!order || !order.id) throw new Error('订单创建结果无效');
      const prepared = await api.orders.preparePayment(order.id);
      if (!prepared || !prepared.payment) {
        await this.refresh();
        showToast(prepared && prepared.order && prepared.order.status === 'expired'
          ? '订单已超时取消，请重新下单' : '请查看订单状态');
        return;
      }
      if (typeof wx.requestVirtualPayment !== 'function') throw new Error('当前微信环境不支持虚拟支付');
      await new Promise((resolve, reject) => wx.requestVirtualPayment({
        ...api.payment.toVirtualPaymentArgs(prepared.payment),
        success: resolve,
        fail: reject
      }));
      const queried = await api.orders.queryPayment(order.id);
      const queriedOrder = queried && (queried.order || queried);
      if (queriedOrder && ['code_pending', 'code_issued'].indexOf(queriedOrder.status) >= 0) {
        if (queriedOrder.status === 'code_pending') {
          const revealed = await api.orders.revealActivationCode(order.id);
          this.setData({ voucherVisible: true, voucherCode: revealed.activationCode || '', voucherMask: revealed.mask || '', voucherOrderId: order.id, voucherError: '' });
        } else {
          this.setData({ voucherVisible: true, voucherCode: '', voucherMask: queriedOrder.activationCode && queriedOrder.activationCode.mask || '', voucherOrderId: order.id, voucherError: '激活码已展示过，服务端只保留掩码，请使用已复制的原码兑换。' });
        }
      }
      await this.refresh();
      showToast(this.data.entitlement && this.data.entitlement.active ? '权益已开通'
        : queriedOrder && queriedOrder.status === 'expired' ? '订单已超时取消，扣款结果将自动同步' : '支付已提交，正在确认');
    } catch (error) {
      await this.refresh();
      const cancelled = error && /cancel/i.test(error.errMsg || '');
      showToast(cancelled ? '已取消支付，订单2分钟超时自动取消' : apiMessage(error, '购买未完成，可在订单中查看状态'));
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
    if (kind === 'agreement') {
      if (typeof wx.openPrivacyContract === 'function') {
        wx.openPrivacyContract({
          fail: (error) => {
            const message = error && error.errMsg ? String(error.errMsg) : '';
            if (!/cancel/i.test(message)) showToast('隐私协议暂时无法打开，请稍后重试');
          }
        });
        return;
      }
      showToast('当前微信版本不支持查看隐私协议');
      return;
    }
    const info = {
      refund: ['退费规则', '具体退费规则待公布，请在购买前阅读完整说明。'],
      customer: ['联系客服', '如有使用问题，请通过本小程序公布的官方渠道联系我们，我们会尽快处理。']
    }[kind];
    this.setData({ infoTitle: info[0], infoText: info[1], infoKind: kind, infoVisible: true });
  },
  closeInfo() { this.setData({ infoVisible: false, infoKind: '' }); },
  onMaskTap() {},
  retry() { this.refresh(); }
});

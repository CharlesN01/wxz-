const SHARE_TITLE = '文常记｜山东专升本语文';
const SHARE_PATH = '/pages/home/index';
const SHARE_IMAGE = '/assets/share-cover.png';
function shareAppMessage() { return { title: SHARE_TITLE, path: SHARE_PATH, imageUrl: SHARE_IMAGE }; }
function shareTimeline() { return { title: SHARE_TITLE, query: '', imageUrl: SHARE_IMAGE }; }
const api = require('../../services/api');
const { orderView } = require('../../utils/order-view');

function toast(title) { wx.showToast({ title: String(title || '操作未完成').slice(0, 28), icon: 'none' }); }
function message(error, fallback) { return error && error.message ? error.message : fallback; }
function paymentCode(error) {
  const code = error && Number(error.errCode);
  return Number.isFinite(code) ? code : Number(error && error.code);
}
function paymentMessage(error) {
  const code = paymentCode(error);
  const labels = { '-15005': '微信登录状态已失效，请重新登录', '-15007': '微信支付会话已过期，请重新登录', '-15010': '微信平台商品尚未发布，请联系管理员', '-15013': '商品价格与微信平台不一致，请联系管理员' };
  return labels[String(code)] || message(error, '支付未完成，请稍后重试');
}

Page({
  data: { loggedIn: false, loading: true, error: '', orders: [], detailVisible: false, detailLoading: false, detailError: '', selectedOrder: null, busy: false },

  onShow() { this.refresh(); },

  async refresh() {
    const session = api.auth.getSession();
    this.setData({ loggedIn: Boolean(session && session.token), loading: true, error: '' });
    if (!session || !session.token) { this.setData({ loading: false }); return; }
    try {
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
      this.setData({ orders: orders.map(orderView), loading: false });
      if (this.data.selectedOrder) {
        const current = orders.find((item) => String(item.id) === String(this.data.selectedOrder.id));
        if (current) this.setData({ selectedOrder: orderView(current) });
      }
    } catch (error) {
      const authError = error && (error.status === 401 || error.code === 'INVALID_TOKEN');
      this.setData({ loading: false, loggedIn: !authError, error: authError ? '登录状态已失效，请重新登录' : message(error, '订单暂时无法加载') });
    }
  },

  async login() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try { await api.auth.login(); await this.refresh(); toast('登录成功'); }
    catch (error) { toast(message(error, '登录失败，请稍后重试')); }
    finally { this.setData({ busy: false }); }
  },

  async openOrder(event) {
    const id = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id;
    const selected = id ? this.data.orders.find((item) => String(item.id) === String(id)) : this.data.selectedOrder;
    if (!selected || this.data.detailLoading) return;
    this.setData({ selectedOrder: selected, detailVisible: true, detailLoading: true, detailError: '' });
    try {
      const detail = await api.orders.detail(selected.id);
      this.setData({ selectedOrder: orderView(detail && (detail.order || detail) || selected), detailLoading: false });
    } catch (error) { this.setData({ detailLoading: false, detailError: message(error, '订单详情暂时无法加载') }); }
  },

  backToList() { this.setData({ detailVisible: false, detailLoading: false, detailError: '', selectedOrder: null }); },

  async continuePayment() {
    const order = this.data.selectedOrder;
    if (!order || this.data.busy) return;
    this.setData({ busy: true, detailError: '' });
    try {
      if (api.auth.ensureFreshSession) await api.auth.ensureFreshSession();
      let prepared;
      try { prepared = await api.orders.preparePayment(order.id); }
      catch (error) {
        const code = paymentCode(error);
        if (code !== -15005 && code !== -15007) throw error;
        await api.auth.login();
        prepared = await api.orders.preparePayment(order.id);
      }
      if (!prepared || !prepared.payment) { await this.refresh(); toast('订单暂时不能支付，请刷新订单状态'); return; }
      if (typeof wx.requestVirtualPayment !== 'function') throw new Error('当前微信环境不支持虚拟支付');
      const paymentArgs = api.payment && api.payment.toVirtualPaymentArgs ? api.payment.toVirtualPaymentArgs(prepared.payment) : prepared.payment;
      try {
        await new Promise((resolve, reject) => wx.requestVirtualPayment({ ...paymentArgs, success: resolve, fail: reject }));
      } catch (error) {
        const code = paymentCode(error);
        if (code !== -15005 && code !== -15007) throw error;
        await api.auth.login();
        const retry = await api.orders.preparePayment(order.id);
        if (!retry || !retry.payment) throw error;
        const retryArgs = api.payment && api.payment.toVirtualPaymentArgs ? api.payment.toVirtualPaymentArgs(retry.payment) : retry.payment;
        await new Promise((resolve, reject) => wx.requestVirtualPayment({ ...retryArgs, success: resolve, fail: reject }));
      }
      await api.orders.queryPayment(order.id);
      await this.refresh();
      toast('支付已提交，正在确认');
    } catch (error) { toast(paymentMessage(error)); }
    finally { this.setData({ busy: false }); }
  },
  onShareAppMessage() { return shareAppMessage(); },
  onShareTimeline() { return shareTimeline(); }
});

const labels = {
  created: '待支付', preparing: '待支付', paid: '付款已确认',
  code_pending: '待领取激活码', code_issued: '激活码已生成', code_redeemed: '激活码已兑换',
  fulfilled: '已开通', closed: '已取消', expired: '超时已取消', refunded: '已退款', review: '待核查'
};

function orderView(order) {
  if (!order) return order;
  return { ...order, statusLabel: order.statusLabel || labels[order.status] || '状态待确认' };
}

module.exports = { orderView };

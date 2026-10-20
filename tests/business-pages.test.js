const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');

function load(relativePath, api, navigation = {}, runtime = {}) {
  const filename = path.join(root, 'miniprogram', relativePath);
  const localRequire = createRequire(filename);
  let definition;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(request) {
      if (request === '../../utils/study-timer') return { withStudyTime: (definition) => definition };
      if (request === '../../services/api') return api;
      if (request === '../../utils/navigation') return navigation;
      return localRequire(request);
    },
    Page(value) { definition = value; },
    wx: { showToast() {}, getSystemInfoSync() { return { platform: 'devtools' }; } },
    getCurrentPages() { return []; },
    ...runtime
  }, { filename });
  return { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(value) { Object.assign(this.data, value); } };
}

test('我的页面提供登录入口并按订单 ID 请求详情', async () => {
  const calls = [];
  const api = {
    auth: {
      getSession() { return null; },
      login() { calls.push('login'); return Promise.resolve(); },
      logout() { return Promise.resolve(); }
    },
    products: { list() { return Promise.resolve({ results: [] }); } },
    orders: { detail(id) { calls.push(['order', id]); return Promise.resolve({ id, status: 'PENDING' }); } },
    entitlements: { current() { return Promise.resolve({ active: false }); } },
    learning: { statistics() { return Promise.resolve({}); }, preferences() { return Promise.resolve({}); } }
  };
  const page = load('pages/mine/index.js', api);
  await page.login();
  assert.deepEqual(calls, ['login']);
  page.data.orders = [{ id: 'order-1', productName: '全题库' }];
  await page.openOrder({ currentTarget: { dataset: { id: 'order-1' } } });
  assert.deepEqual(calls, ['login', ['order', 'order-1']]);
  assert.equal(page.data.selectedOrder.status, 'PENDING');
  assert.equal(page.data.orderDetailVisible, true);
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/mine/index.wxml'), 'utf8');
  assert.match(template, /bindtap="login"/);
  assert.match(template, /bindtap="openOrder"/);
});

test('超时订单不再弹起支付，显示重新下单提示', async () => {
  const messages = [];
  let paymentCalls = 0;
  const page = load('pages/mine/index.js', {
    orders: {
      create: async () => ({ order: { id: 'expired-order' } }),
      preparePayment: async () => ({ order: { id: 'expired-order', status: 'expired' }, payment: null })
    }
  }, {}, { wx: { showToast: ({ title }) => messages.push(title), requestVirtualPayment: () => { paymentCalls += 1; } } });
  page.data.loggedIn = true;
  page.data.product = { id: 'all-chinese', purchaseAvailable: true, paymentChannels: { android: true } };
  page.channelForDevice = () => 'android';
  page.refresh = async () => {};
  await page.purchase();
  assert.equal(paymentCalls, 0);
  assert.match(messages.at(-1), /超时取消.*重新下单/);
});

test('取消支付只提示两分钟自动取消，不发起平台查单', async () => {
  const messages = [];
  let queries = 0;
  const page = load('pages/mine/index.js', {
    orders: {
      create: async () => ({ order: { id: 'cancelled-order' } }),
      preparePayment: async () => ({ payment: {} }),
      queryPayment: async () => { queries += 1; }
    }, payment: { toVirtualPaymentArgs: () => ({}) }
  }, {}, { wx: { showToast: ({ title }) => messages.push(title), requestVirtualPayment: ({ fail }) => fail({ errMsg: 'requestVirtualPayment:fail cancel' }) } });
  page.data.loggedIn = true;
  page.data.product = { id: 'all-chinese', purchaseAvailable: true, paymentChannels: { android: true } };
  page.channelForDevice = () => 'android';
  page.refresh = async () => {};
  await page.purchase();
  assert.equal(queries, 0);
  assert.match(messages.at(-1), /已取消支付.*2分钟/);
  assert.equal(page.data.busy, false);
});

test('订单到期自动刷新，隐藏页面时清理计时器', async () => {
  let callback;
  let delay;
  let cleared;
  let refreshed = 0;
  const page = load('pages/mine/index.js', {}, {}, {
    setTimeout(fn, ms) { callback = fn; delay = ms; return 7; },
    clearTimeout(id) { cleared = id; }
  });
  page.data.orders = [{ id: 'pending-order', status: 'preparing', expiresAt: new Date(Date.now() + 120000).toISOString() }];
  page.refresh = async () => { refreshed += 1; };
  page.scheduleOrderExpiry();
  assert.ok(delay > 119000 && delay < 121000);
  callback();
  assert.equal(refreshed, 1);
  page.scheduleOrderExpiry();
  page.onHide();
  assert.equal(cleared, 7);
  assert.equal(page._orderExpiryTimer, null);
});

test('激活码兑换失败保留输入并显示完整原因，重试成功后清除原码', async () => {
  const message = '激活码批次尚未启用，请联系发码管理员启用后重试。';
  let succeed = false;
  const page = load('pages/mine/index.js', {
    activation: { redeem() {
      return succeed ? Promise.resolve({ entitlement: { active: true, permanent: true } })
        : Promise.reject({ code: 'CODE_UNAVAILABLE', message });
    } }
  });
  let refreshed = 0;
  page.refresh = async () => { refreshed += 1; };
  page.data.activationVisible = true;
  page.data.activationCode = 'disposable-code';
  await page.redeem();
  assert.equal(page.data.activationCode, 'disposable-code');
  assert.equal(page.data.activationVisible, true);
  assert.equal(page.data.activationError, message);
  assert.equal(page.data.busy, false);
  assert.equal(refreshed, 0);
  succeed = true;
  await page.redeem();
  assert.equal(page.data.activationCode, '');
  assert.equal(page.data.activationError, '');
  assert.equal(page.data.activationVisible, false);
  assert.equal(page.data.entitlement.active, true);
  assert.equal(refreshed, 1);
});

test('服务端权益未生效时兑换页不显示成功或关闭输入', async () => {
  const page = load('pages/mine/index.js', {
    activation: { redeem: async () => ({ entitlement: { active: false } }) }
  });
  page.data.activationVisible = true;
  page.data.activationCode = 'disposable-code';
  await page.redeem();
  assert.equal(page.data.entitlement.active, false);
  assert.equal(page.data.activationVisible, true);
  assert.equal(page.data.activationCode, 'disposable-code');
  assert.match(page.data.activationError, /尚未确认权益生效/);
  assert.equal(page.data.busy, false);
  page.closeActivation();
  assert.equal(page.data.activationCode, '');
});

test('收藏返回页面会重读服务端，开通后恢复原来受限题的正文', async () => {
  let activated = false;
  const page = load('pages/favorites/index.js', {
    auth: { getToken: () => 'favorite-learner' },
    learning: { favorites: async () => ({ count: 1, next: null, results: [{
      questionId: 'paid-favorite', source: 'literature',
      state: { favorite: true, version: 1 },
      question: activated ? { id: 'paid-favorite', source: 'literature', stem: '完整题干', answers: ['完整答案'] } : null,
      unavailableReason: activated ? null : 'ENTITLEMENT_REQUIRED'
    }] }) }
  });
  page._ready = true;
  page._sourceFilter = 'literature';
  page._categoryId = '';
  await page._refreshFavorites();
  assert.equal(page.data.questions[0].unavailable, true);
  activated = true;
  page.onShow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.questions[0].unavailable, undefined);
  assert.equal(page.data.questions[0].stem, '完整题干');
  assert.match(page.data.questions[0].answerText, /完整答案/);
});

test('应用文条目打开时请求单条详情并保留错误态', async () => {
  const ids = [];
  const api = {
    content: {
      writing(id) { ids.push(id); return Promise.reject(new Error('详情不可用')); },
      writings() { return Promise.resolve({ results: [] }); }
    }
  };
  const page = load('pages/application/index.js', api);
  page.data.items = [{ id: 'writing-1', title: '通知' }];
  page.openItem({ currentTarget: { dataset: { id: 'writing-1' } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(ids, ['writing-1']);
  assert.equal(page.data.detailError, '详情不可用');
  assert.equal(page.data.detailLoading, false);
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/application/index.wxml'), 'utf8');
  assert.match(template, /detailError/);
});

test('应用文列表和分类查询会跟随 next 分页', async () => {
  const calls = [];
  const api = {
    content: {
      writings(params) {
        calls.push(['writings', params]);
        return Promise.resolve(params.kind
          ? { results: [{ id: 'kind-1', kind: params.kind }], next: 'kind-next' }
          : { results: [{ id: 'base-1', kind: 'exercise' }], next: 'base-next' });
      }
    },
    pagination: {
      follow(next, options) {
        calls.push(['follow', next, options]);
        return Promise.resolve(next === 'base-next'
          ? { results: [{ id: 'base-2', kind: 'example' }], next: null }
          : { results: [{ id: 'kind-2', kind: 'template' }], next: null });
      }
    }
  };
  const page = load('pages/application/index.js', api);
  await page.load();
  assert.deepEqual(page.data.items.map((item) => item.id), ['base-1', 'base-2']);
  page.chooseKind({ currentTarget: { dataset: { kind: 'template' } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(page.data.detailItems.map((item) => item.id), ['kind-1', 'kind-2']);
  assert.deepEqual(calls.filter((call) => call[0] === 'follow').map((call) => call[1]), ['base-next', 'kind-next']);
  assert.equal(calls[1][2].basePath, '/api/student/v1/writings/');
});

test('应用文分类已在首屏出现时仍展示该分类的全部条目', async () => {
  const api = {
    content: {
      writings() {
        return Promise.resolve({
          results: [
            { id: 'template-1', kind: 'template' },
            { id: 'template-2', kind: 'template' },
            { id: 'example-1', kind: 'example' }
          ],
          next: null
        });
      },
      writing(id) { return Promise.resolve({ id, title: id, body: '正文' }); }
    },
    pagination: { follow() { throw new Error('首屏完整时不应再次分页'); } }
  };
  const page = load('pages/application/index.js', api);
  await page.load();
  page.chooseKind({ currentTarget: { dataset: { kind: 'template' } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(page.data.detailItems.map((item) => item.id), ['template-1', 'template-2']);
});

test('应用文详情错误支持独立重试', async () => {
  let attempts = 0;
  const api = {
    content: {
      writing(id) {
        assert.equal(id, 'writing-1');
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error('详情不可用')) : Promise.resolve({ id, title: '通知', body: '正文' });
      }
    }
  };
  const page = load('pages/application/index.js', api);
  page.data.items = [{ id: 'writing-1', title: '通知' }];
  page.openItem({ currentTarget: { dataset: { id: 'writing-1' } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(page.data.detailError, '详情不可用');
  page.retryDetail();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 2);
  assert.equal(page.data.detailError, '');
  assert.equal(page.data.selected.body, '正文');
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/application/index.wxml'), 'utf8');
  assert.match(template, /bindtap="retryDetail"/);
});

test('我的订单会跟随 next 分页，401 刷新失败后进入登录态', async () => {
  const calls = [];
  const api = {
    auth: {
      getSession() { return { token: 'expired-token', user: { id: 7 } }; },
      login() { return Promise.resolve(); },
      logout() { return Promise.resolve(); }
    },
    products: { list() { return Promise.resolve({ results: [] }); } },
    orders: {
      list(params) { calls.push(['orders', params]); return Promise.resolve({ results: [{ id: 'order-1' }], next: 'orders-next' }); },
      detail() { return Promise.resolve({}); }
    },
    pagination: {
      follow(next, options) { calls.push(['follow', next, options]); return Promise.resolve({ results: [{ id: 'order-2' }], next: null }); }
    },
    entitlements: { current() { return Promise.resolve({ active: false }); } },
    learning: { statistics() { return Promise.resolve({}); }, preferences() { return Promise.resolve({}); } }
  };
  const page = load('pages/mine/index.js', api);
  assert.deepEqual(await page.loadOrders(), [{ id: 'order-1' }, { id: 'order-2' }]);
  assert.equal(calls[1][2].basePath, '/api/student/v1/orders/');

  api.orders.list = () => Promise.reject({ status: 401, code: 'INVALID_TOKEN' });
  await page.refresh();
  assert.equal(page.data.loggedIn, false);
  assert.equal(page.data.userId, '');
  assert.equal(page.data.error, '登录状态已失效，请重新登录');
});

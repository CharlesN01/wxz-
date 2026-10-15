const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');

function load(relativePath, api, navigation = {}) {
  const filename = path.join(root, 'miniprogram', relativePath);
  const localRequire = createRequire(filename);
  let definition;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(request) {
      if (request === '../../services/api') return api;
      if (request === '../../utils/navigation') return navigation;
      return localRequire(request);
    },
    Page(value) { definition = value; },
    wx: { showToast() {}, getSystemInfoSync() { return { platform: 'devtools' }; } },
    getCurrentPages() { return []; }
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

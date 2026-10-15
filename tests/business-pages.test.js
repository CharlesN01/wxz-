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

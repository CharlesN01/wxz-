const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const pageFile = path.resolve(__dirname, '../miniprogram/pages/mine/index.js');

function loadPage(wx) {
  let definition;
  const localRequire = createRequire(pageFile);
  vm.runInNewContext(fs.readFileSync(pageFile, 'utf8'), {
    require(name) {
      if (name === '../../services/api') return {};
      if (name === '../../utils/navigation') return {};
      return localRequire(name);
    },
    Page(value) { definition = value; },
    wx
  }, { filename: pageFile });
  return { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(update) { Object.assign(this.data, update); } };
}

test('服务协议入口打开微信平台已配置的隐私协议', () => {
  let opened = 0;
  const page = loadPage({
    openPrivacyContract() { opened += 1; },
    showToast() {},
    getStorageSync() { return ''; }
  });

  page.openInfo({ currentTarget: { dataset: { kind: 'agreement' } } });

  assert.equal(opened, 1);
  assert.equal(page.data.infoVisible, false);
});

test('不支持官方隐私协议接口时给出明确提示', () => {
  const toasts = [];
  const page = loadPage({
    showToast(value) { toasts.push(value); },
    getStorageSync() { return ''; }
  });

  page.openInfo({ currentTarget: { dataset: { kind: 'agreement' } } });

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, '当前微信版本不支持查看隐私协议');
  assert.equal(toasts[0].icon, 'none');
  assert.equal(page.data.infoVisible, false);
});

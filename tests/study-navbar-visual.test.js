const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getNavigationMetrics } = require('../miniprogram/utils/safe-top');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('导航标题与副标题分行布局并避开返回按钮及微信胶囊', () => {
  const template = read('miniprogram/components/study-navbar/index.wxml');
  const styles = read('miniprogram/components/study-navbar/index.wxss');
  const homePage = read('miniprogram/pages/home/index.wxml');
  const centeredPage = read('miniprogram/pages/mine/index.wxml');

  assert.match(template, /padding-left: \{\{centered \? rightSpace : \(back \? 56 : 17\)\}\}px; padding-right: \{\{rightSpace\}\}px;/);
  assert.match(template, /header-copy-centered/);
  assert.match(homePage, /<study-navbar[^>]*back="\{\{false\}\}"/);
  assert.match(centeredPage, /<study-navbar[^>]*centered="\{\{true\}\}"/);
  assert.match(styles, /\.back-hit \{[^}]*left: 8rpx;[^}]*width: 88rpx;/);
  assert.match(styles, /\.header-copy \{[^}]*flex-direction: column;/);
  assert.match(styles, /\.brand-title \{[^}]*display: block;[^}]*word-break: break-all;/);
  assert.match(styles, /\.brand-subtitle \{[^}]*display: block;/);
  assert.doesNotMatch(template, /more-button|onMore/);
  assert.doesNotMatch(styles, /\.brand-title[^}]*white-space: nowrap/);
});

for (const width of [375, 390, 430]) {
  test(`${width}px 导航内容低于刘海并完整避开胶囊`, () => {
    const statusHeight = width === 375 ? 44 : 47;
    const menu = { left: width - 97, top: statusHeight + 6, height: 32, bottom: statusHeight + 38 };
    const metrics = getNavigationMetrics({
      getWindowInfo: () => ({ windowWidth: width, statusBarHeight: statusHeight }),
      getMenuButtonBoundingClientRect: () => menu
    });
    assert.equal(metrics.statusHeight, statusHeight);
    assert.ok(metrics.statusHeight + metrics.barHeight > menu.bottom);
    const titleRight = width - metrics.rightSpace;
    assert.ok(titleRight <= menu.left - 12);
    assert.ok(titleRight - 56 >= 200, '非居中学习标题保留足够宽度');
    assert.ok(width - metrics.rightSpace * 2 >= 150, '居中标题可分行显示');
  });
}

test('窗口 API 或胶囊数据缺失仍保留独立导航行', () => {
  const metrics = getNavigationMetrics({
    getWindowInfo() { throw new Error('unsupported'); },
    getSystemInfoSync() { return { windowWidth: 390, statusBarHeight: 30 }; },
    getMenuButtonBoundingClientRect() { return { top: 0, height: 0 }; }
  });
  assert.deepEqual(metrics, { statusHeight: 30, barHeight: 58, rightSpace: 100 });
});

test('9 个页面都有导航，文学与两类随机页不再依赖空白占位', () => {
  const pages = JSON.parse(read('miniprogram/app.json')).pages;
  for (const route of pages) {
    const template = read(`miniprogram/${route}.wxml`);
    assert.match(template, /<study-navbar/);
    assert.doesNotMatch(template, /more="|more-plain="|bind:more="/);
  }
  assert.doesNotMatch(read('miniprogram/pages/literature/index.wxml'), /literature-safe-top/);
  assert.doesNotMatch(read('miniprogram/pages/random/index.wxml'), /random-safe-top|study-navbar wx:if/);
});

test('应用文详情使用同一导航与分行正文，返回只关闭详情', () => {
  const styles = read('miniprogram/pages/application/index.wxss');
  const template = read('miniprogram/pages/application/index.wxml');
  assert.match(template, /study-navbar[^>]*custom-back="\{\{true\}\}"[^>]*bind:back="closeDetail"/);
  assert.match(styles, /\.detail-heading \{[^}]*display: block;/);
  assert.match(styles, /\.detail-intro \{[^}]*display: block;/);
  assert.match(styles, /\.detail-item-copy \{[^}]*white-space: pre-wrap;/);
  let definition;
  vm.runInNewContext(read('miniprogram/components/study-navbar/index.js'), {
    require: () => ({ getNavigationMetrics }),
    Component(value) { definition = value; },
    getCurrentPages() { throw new Error('详情返回不应改变页面栈'); }
  });
  const events = [];
  definition.methods.goBack.call({ data: { customBack: true }, triggerEvent: (event) => events.push(event) });
  assert.deepEqual(events, ['back']);
});

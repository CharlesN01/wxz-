const test = require('node:test');
const assert = require('node:assert/strict');
const { getSafeTop } = require('../miniprogram/utils/safe-top');

test('安全顶部至少越过状态栏，并为胶囊底部保留 8px', () => {
  const value = getSafeTop({
    getWindowInfo: () => ({ statusBarHeight: 28 }),
    getMenuButtonBoundingClientRect: () => ({ bottom: 72 })
  });
  assert.equal(value, 63);
});

test('缺少胶囊信息时使用状态栏高度加间距', () => {
  const value = getSafeTop({ getWindowInfo: () => ({ statusBarHeight: 30 }) });
  assert.equal(value, 21);
});

test('新窗口 API 不可用时回退到 getSystemInfoSync', () => {
  const value = getSafeTop({
    getWindowInfo: () => { throw new Error('unsupported'); },
    getSystemInfoSync: () => ({ statusBarHeight: 24 }),
    getMenuButtonBoundingClientRect: () => ({ bottom: 0 })
  });
  assert.equal(value, 15);
});

test('Node 环境没有微信 API 时回退为 0，不影响既有 CSS 间距', () => {
  assert.equal(getSafeTop(null), 0);
});

test('小数设备坐标向上取整，避免内容落入胶囊安全区', () => {
  const value = getSafeTop({
    getWindowInfo: () => ({ statusBarHeight: 24.5 }),
    getMenuButtonBoundingClientRect: () => ({ bottom: 60.25 })
  });
  assert.equal(value, 52);
});

test('可按页面原有顶部内边距计算额外 spacer，不重复叠加', () => {
  const value = getSafeTop({
    getWindowInfo: () => ({ statusBarHeight: 28 }),
    getMenuButtonBoundingClientRect: () => ({ bottom: 72 })
  }, 12);
  assert.equal(value + 12, 80);
});

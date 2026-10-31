const test = require('node:test');
const assert = require('node:assert/strict');
const pageSwipe = require('../miniprogram/utils/page-swipe');

function event(x, y, dataset = {}) {
  return { touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }], target: { dataset } };
}

test('水平向左滑到下一页、向右滑到上一页', () => {
  const page = {};
  const calls = [];
  pageSwipe.start.call(page, event(220, 120));
  pageSwipe.end.call(page, event(140, 130), () => calls.push('previous'), () => calls.push('next'));
  pageSwipe.start.call(page, event(100, 120));
  pageSwipe.end.call(page, event(190, 126), () => calls.push('previous'), () => calls.push('next'));
  assert.deepEqual(calls, ['next', 'previous']);
});

test('忽略纵向滚动、短距离拖动和答案输入控件触发的手势', () => {
  const page = {};
  let changes = 0;
  const change = () => { changes += 1; };
  pageSwipe.start.call(page, event(100, 100));
  pageSwipe.end.call(page, event(180, 170), change, change);
  pageSwipe.start.call(page, event(100, 100));
  pageSwipe.end.call(page, event(140, 100), change, change);
  pageSwipe.start.call(page, event(100, 100, { id: 'question-1' }));
  pageSwipe.end.call(page, event(190, 100), change, change);
  assert.equal(changes, 0);
});

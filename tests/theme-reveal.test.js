const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { revealGeometry } = require('../miniprogram/utils/theme-reveal');

test('圆形展开从真实触摸点开始，包含触摸坐标为零的边缘情况', () => {
  const result = revealGeometry({ changedTouches: [{ clientX: 0, clientY: 0 }] }, { windowWidth: 390, windowHeight: 844 }, 0);
  assert.deepEqual(result, { x: 0, y: 0, radius: 930 });
});

test('页面滚动后使用视口坐标，并确保半径覆盖最远屏幕角', () => {
  const result = revealGeometry({ changedTouches: [{ pageX: 370, pageY: 1600 }] }, { windowWidth: 390, windowHeight: 844 }, 800);
  assert.deepEqual(result, { x: 370, y: 800, radius: 882 });
});

test('圆形切换保留两份相同页面，只裁切新主题的上层', () => {
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/home/index.wxml'), 'utf8');
  assert.equal((template.match(/template is="home-content"/g) || []).length, 2);
  assert.match(template, /class="theme-reveal" style="\{\{themeRevealStyle\}\}"/);
  assert.doesNotMatch(template, /themeRevealStyle\}\}"[^>]*class="home-page/);
});

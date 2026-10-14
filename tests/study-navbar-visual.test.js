const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('带返回的非居中 paper 标题避开返回触控区，不改变无返回或居中导航', () => {
  const template = read('miniprogram/components/study-navbar/index.wxml');
  const styles = read('miniprogram/components/study-navbar/index.wxss');
  const homePage = read('miniprogram/pages/home/index.wxml');
  const centeredPage = read('miniprogram/pages/mine/index.wxml');

  assert.match(template, /class="home-brand home-brand-with-subtitle \{\{back && !centered \? 'home-brand-has-back' : ''\}\}"/);
  assert.match(template, /class="home-brand \{\{back && !centered \? 'home-brand-has-back' : ''\}\}"/);
  assert.match(template, /class="centered-title-wrap"/);
  assert.match(homePage, /<study-navbar[^>]*back="\{\{false\}\}"/);
  assert.match(centeredPage, /<study-navbar[^>]*centered="\{\{true\}\}"/);
  assert.match(styles, /\.back-hit \{[^}]*left: 8rpx;[^}]*width: 88rpx;/);
  assert.match(styles, /\.home-brand \{[^}]*padding-left: 32rpx;/);
  assert.match(styles, /\.home-brand-with-subtitle \{[^}]*padding-left: 34rpx;/);
  assert.match(styles, /\.home-brand\.home-brand-has-back, \.home-brand-with-subtitle\.home-brand-has-back \{ padding-left: 112rpx; \}/);
});

test('应用文详情标题按 375px 原型尺寸设置为 23px', () => {
  const styles = read('miniprogram/pages/application/index.wxss');
  assert.match(styles, /\.detail-heading \{[^}]*font-size: 46rpx;/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'miniprogram');

test('所有答题与背诵页码文案和输入数字字号一致，输入框保持正方形', () => {
  for (const page of ['literature', 'practice', 'random', 'application']) {
    const styles = fs.readFileSync(path.join(root, 'pages', page, 'index.wxss'), 'utf8');
    const editor = styles.match(/\.page-number-editor\s*\{([^}]*)\}/);
    const rule = styles.match(/\.page-number-input\s*\{([^}]*)\}/);
    assert.ok(editor, `${page}: page number labels have an explicit font size`);
    assert.ok(rule, `${page}: page number input style exists`);
    assert.match(editor[1], /font-size:\s*var\(--study-rpx-24\)/);
    assert.match(rule[1], /width:\s*24px/);
    assert.match(rule[1], /height:\s*24px/);
    assert.match(rule[1], /min-height:\s*24px/);
    assert.match(rule[1], /font-size:\s*var\(--study-rpx-24\)/);
    if (page === 'application') {
      assert.match(styles, /\.page-no-prefix, \.page-no-suffix\s*\{[^}]*font-size:\s*var\(--study-rpx-24\)/s);
    } else if (page === 'random') {
      assert.match(styles, /\.random-page \.page-number\s*\{[^}]*font-size:\s*var\(--study-rpx-24\)/s);
    } else {
      assert.match(styles, /\.page-number\s*\{[^}]*font-size:\s*var\(--study-rpx-24\)/s);
    }
  }
});

test('所有含分页的答题/背诵页绑定横向滑动翻页', () => {
  for (const page of ['literature', 'practice', 'random']) {
    const template = fs.readFileSync(path.join(root, 'pages', page, 'index.wxml'), 'utf8');
    assert.match(template, /bindtouchstart="onQuestionTouchStart"/);
    assert.match(template, /bindtouchend="onQuestionTouchEnd"/);
  }
  const application = fs.readFileSync(path.join(root, 'pages', 'application', 'index.wxml'), 'utf8');
  assert.match(application, /bindtouchstart="onPageTouchStart"/);
  assert.match(application, /bindtouchend="onPageTouchEnd"/);
});

test('收藏页输入不显示“填写答案/填写译文”占位文字', () => {
  const template = fs.readFileSync(path.join(root, 'pages', 'favorites', 'index.wxml'), 'utf8');
  assert.doesNotMatch(template, /placeholder\s*=\s*"[^"]*(填写答案|填写译文)/);
});

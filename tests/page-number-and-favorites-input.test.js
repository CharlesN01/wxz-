const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'miniprogram');

test('所有答题与背诵页码输入保持紧凑正方形，页码文案字号沿用原值', () => {
  for (const page of ['literature', 'practice', 'random', 'application']) {
    const styles = fs.readFileSync(path.join(root, 'pages', page, 'index.wxss'), 'utf8');
    const rule = styles.match(/\.page-number-input\s*\{([^}]*)\}/);
    assert.ok(rule, `${page}: page number input style exists`);
    assert.match(rule[1], /width:\s*24px/);
    assert.match(rule[1], /height:\s*24px/);
    assert.match(rule[1], /min-height:\s*24px/);
    const expectedInputFont = page === 'application' ? 22 : 24;
    assert.match(rule[1], new RegExp(`font-size:\\s*var\\(--study-rpx-${expectedInputFont}\\)`));
    if (page === 'application') {
      assert.match(styles, /\.page-no-prefix, \.page-no-suffix\s*\{[^}]*font-size:\s*var\(--study-rpx-20\)/s);
    } else if (page === 'random') {
      assert.match(styles, /\.random-page \.page-number\s*\{[^}]*font-size:\s*var\(--study-rpx-24\)/s);
    } else {
      assert.match(styles, /\.page-number\s*\{[^}]*font-size:\s*var\(--study-rpx-24\)/s);
    }
  }
});

test('收藏页输入不显示“填写答案/填写译文”占位文字', () => {
  const template = fs.readFileSync(path.join(root, 'pages', 'favorites', 'index.wxml'), 'utf8');
  assert.doesNotMatch(template, /placeholder\s*=\s*"[^"]*(填写答案|填写译文)/);
});

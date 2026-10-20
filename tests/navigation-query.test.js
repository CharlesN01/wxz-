const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeQueryValue } = require('../miniprogram/utils/navigation');

test('篇目中文参数支持原文、一次编码和旧记录双重编码', () => {
  const title = '劝学 · 字词（第一组）';
  assert.equal(decodeQueryValue(title), title);
  assert.equal(decodeQueryValue(encodeURIComponent(title)), title);
  assert.equal(decodeQueryValue(encodeURIComponent(encodeURIComponent(title))), title);
});

test('空标题和损坏的百分号编码保持可显示且不抛错', () => {
  assert.equal(decodeQueryValue(undefined), '');
  assert.equal(decodeQueryValue(null), '');
  assert.equal(decodeQueryValue('完成100%'), '完成100%');
  assert.equal(decodeQueryValue('%E4%broken'), '%E4%broken');
});

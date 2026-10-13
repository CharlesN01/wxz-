const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'miniprogram');
function read(relativePath) { return fs.readFileSync(path.join(root, relativePath), 'utf8'); }

test('16 个设计状态的关键入口和模式参数已覆盖', () => {
  const home = read('pages/home/index.wxml');
  const classical = read('pages/classical/index.js');
  const practice = read('pages/practice/index.js');
  const random = read('pages/random/index.js');
  assert.match(home, /data-page="resources"/);
  assert.match(classical, /mode: this\.data\.mode/);
  assert.match(practice, /options\.mode === 'reciting'/);
  assert.match(random, /options\.mode === 'reciting'/);
});

test('自测题卡提供查看答案控件，背诵模式显示完整答案', () => {
  const card = read('components/question-card/index.wxml');
  const script = read('components/question-card/index.js');
  assert.match(card, /查看答案/);
  assert.match(card, /answerVisible/);
  assert.match(script, /toggleAnswer/);
  assert.match(script, /mode === 'reciting'/);
});

test('本地降级状态在练习、随机和收藏页面显式标识', () => {
  assert.match(read('pages/practice/index.wxml'), /dataSource === 'local'/);
  assert.match(read('pages/random/index.wxml'), /dataSource === 'local'/);
  assert.match(read('pages/favorites/index.wxml'), /dataSource === 'local'/);
});

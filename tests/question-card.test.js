const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const mock = require('../miniprogram/data/mock');

function createCard() {
  const filename = path.join(__dirname, '../miniprogram/components/question-card/index.js');
  let definition;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: createRequire(filename), Component(value) { definition = value; }
  }, { filename });
  const card = { events: [], data: { ...definition.data, mode: 'writing' }, setData(value) { Object.assign(this.data, value); }, triggerEvent(name, detail) { this.events.push({ name, detail }); } };
  card.render = (question, mode) => {
    card.data.question = question;
    card.data.mode = mode;
    definition.observers['question, mode'].call(card, question, mode);
  };
  card.toggleAnswer = () => definition.methods.toggleAnswer.call(card);
  card.master = () => definition.methods.master.call(card);
  return card;
}

test('翻译背诵保留完整原句与译文，不修改题库', () => {
  const card = createCard();
  const question = mock.questions.find((item) => item.id === 'translation-qing');
  const original = JSON.stringify(question);
  card.render(question, 'reciting');
  assert.equal(card.data.isTranslation, true);
  assert.equal(card.data.translationStem, '青，取之于蓝，而青于蓝。');
  assert.equal(card.data.translationAnswer, question.answers[0]);
  assert.equal(JSON.stringify(question), original);
});

test('从背诵切回默写会清空翻译答案和可见答案片段', () => {
  const card = createCard();
  const question = mock.questions.find((item) => item.type === 'translation');
  card.render(question, 'reciting');
  card.render(question, 'writing');
  assert.equal(card.data.translationAnswer, '');
  assert.ok(card.data.segments.every((part) => !part.isAnswer));
  assert.ok(!card.data.segments.map((part) => part.text).join('').includes(question.answers[0]));
});

test('默写占位片段标记为蓝色填写线，背诵有答案时不保留空线', () => {
  const card = createCard();
  const question = mock.questions.find((item) => item.id === 'word-rou');
  card.render(question, 'writing');
  assert.ok(card.data.segments.some((part) => part.isBlank && part.text === '____'));
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/components/question-card/index.wxml'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../miniprogram/components/question-card/index.wxss'), 'utf8');
  assert.match(template, /item\.isBlank \? 'answer-blank'/);
  assert.match(styles, /\.answer-blank\s*\{[^}]*border-bottom:\s*1px solid #86B8F4/s);
  card.render(question, 'reciting');
  assert.ok(card.data.segments.some((part) => part.isAnswer));
  assert.ok(card.data.segments.every((part) => !part.isBlank));
});

test('随机题卡复用为普通题时清理翻译状态并保留全部答案', () => {
  const card = createCard();
  card.render(mock.questions.find((item) => item.type === 'translation'), 'reciting');
  const question = mock.questions.find((item) => item.id === 'lit-shijing-six');
  card.render(question, 'reciting');
  assert.equal(card.data.isTranslation, false);
  assert.equal(card.data.translationStem, '');
  assert.equal(card.data.translationAnswer, '');
  const answers = card.data.segments.filter((part) => part.isAnswer).map((part) => part.text);
  assert.equal(JSON.stringify(answers), JSON.stringify(question.answers));
});

test('查看与收起答案不自动更新掌握状态', () => {
  const cases = [
    ['random', mock.questions.find((item) => item.id === 'lit-shijing-six')],
    ['practice-word', mock.questions.find((item) => item.id === 'word-rou')],
    ['practice-translation', mock.questions.find((item) => item.id === 'translation-qing')]
  ];
  for (const [variant, question] of cases) {
    const card = createCard();
    card.data.variant = variant;
    card.render(question, 'writing');
    card.toggleAnswer();
    assert.equal(card.data.answerVisible, true);
    card.toggleAnswer();
    assert.equal(card.data.answerVisible, false);
    assert.deepEqual(card.events, []);
  }
});

test('显式掌握操作仍触发掌握事件', () => {
  const card = createCard();
  const question = mock.questions.find((item) => item.id === 'word-rou');
  card.render(question, 'writing');
  card.master();
  assert.equal(card.events.length, 1);
  assert.equal(card.events[0].name, 'master');
  assert.equal(card.events[0].detail.id, question.id);
  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/components/question-card/index.wxml'), 'utf8');
  assert.match(template, /class="master-hit" bindtap="master"/);
});

test('重点字词专项自测提供可输入填空，背诵以独立答案行展示', () => {
  const card = createCard();
  const question = mock.questions.find((item) => item.id === 'word-rou');
  card.data.variant = 'practice-word';

  card.render(question, 'writing');
  assert.equal(card.data.wordStem, '“（輮）以为轮”');

  card.render(question, 'reciting');
  assert.equal(card.data.answerText, question.answers[0]);

  const template = fs.readFileSync(path.join(__dirname, '../miniprogram/components/question-card/index.wxml'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../miniprogram/components/question-card/index.wxss'), 'utf8');
  assert.match(template, /variant === 'practice-word'.*<input[^>]*class="blank"/s);
  assert.match(template, /variant === 'practice-word' && mode === 'reciting'.*class="answer-line"/s);
  assert.match(template, /bindinput="onDraftInput"/);
  assert.match(styles, /\.blank\s*\{[^}]*border-bottom:\s*1px solid #86B8F4/s);
});

test('劝学第3题只标记自得的得，保留积善成德的德', () => {
  const card = createCard();
  const question = mock.questions.find((item) => item.id === 'word-de');
  const original = JSON.stringify(question);
  card.data.variant = 'practice-word';

  for (const mode of ['writing', 'reciting']) {
    card.render(question, mode);
    assert.equal(card.data.wordStem, '“积善成德，而神明自（得）”');
    assert.equal(card.data.answerText, '获得');
  }

  assert.equal(JSON.stringify(question), original);
});

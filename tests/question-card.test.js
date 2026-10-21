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
  const card = {
    events: [], updates: [], data: JSON.parse(JSON.stringify({ ...definition.data, mode: 'writing' })),
    setData(value) {
      this.updates.push(value);
      for (const [key, content] of Object.entries(value)) {
        const item = /^draftAnswers\[(\d+)\]$/.exec(key);
        if (item) this.data.draftAnswers[Number(item[1])] = content;
        else this.data[key] = content;
      }
    },
    triggerEvent(name, detail) { this.events.push({ name, detail: JSON.parse(JSON.stringify(detail)) }); }
  };
  card.render = (question, mode) => {
    card.data.question = question;
    card.data.mode = mode;
    definition.observers['question, mode'].call(card, question, mode);
  };
  card.toggleAnswer = () => definition.methods.toggleAnswer.call(card);
  card.master = () => definition.methods.master.call(card);
  card.input = (index, value) => definition.methods.onDraftInput.call(card, { currentTarget: { dataset: { answerIndex: index } }, detail: { value } });
  return card;
}

function templateText() { return fs.readFileSync(path.join(__dirname, '../miniprogram/components/question-card/index.wxml'), 'utf8'); }

test('翻译背诵保留完整原句与译文，不修改题库', () => {
  const card = createCard();
  const question = mock.questions.find((item) => item.id === 'translation-qing');
  const original = JSON.stringify(question);
  card.render(question, 'reciting');
  assert.equal(card.data.isTranslation, true);
  assert.equal(card.data.translationStem, '“青，取之于蓝，而青于蓝。”');
  assert.equal(card.data.translationAnswer, question.answers[0]);
  assert.equal(JSON.stringify(question), original);
});

test('翻译原文保留嵌套引号、多句和末尾原句，不按第一个闭引号截断', () => {
  const card = createCard();
  const passage = '“子曰：“学而时习之，不亦说乎？”又曰：‘温故而知新，可以为师矣。’\n有朋自远方来，不亦乐乎？人不知而不愠，不亦君子乎？”';
  const question = { id: 'translation-quotes', type: 'translation', stem: passage + '翻译为{{0}}。', answers: ['完整译文'] };
  for (const mode of ['writing', 'reciting']) {
    card.render(question, mode);
    assert.equal(card.data.translationStem, passage);
    assert.ok(card.data.translationStem.endsWith('不亦君子乎？”'));
  }
});

test('翻译原文多个独立引号、占位后续句和无包装句子均完整保留', () => {
  const cases = [
    ['“第一句。”又引“第二句。”译为{{0}}。', '“第一句。”又引“第二句。”'],
    ['“甲”{{0}}，其后还有“乙”，以及最后一整句。', '“甲”，其后还有“乙”，以及最后一整句。'],
    ['君子曰：学不可以已。青，取之于蓝，而青于蓝。翻译为{{0}}。', '君子曰：学不可以已。青，取之于蓝，而青于蓝。'],
    ['“原句一。”\n“原句二。”翻译为：', '“原句一。”\n“原句二。”']
  ];
  for (const [stem, expected] of cases) {
    const card = createCard();
    card.render({ id: stem, type: 'translation', stem, answers: ['译文'] }, 'writing');
    assert.equal(card.data.translationStem, expected);
  }
});

test('从背诵切回默写会隐藏标准答案，不丢失用户自己的译文', () => {
  const card = createCard();
  const question = mock.questions.find((item) => item.type === 'translation');
  card.render(question, 'writing');
  card.input(0, '我的译文');
  card.render(question, 'reciting');
  card.render(question, 'writing');
  assert.equal(card.data.translationAnswer, '');
  assert.equal(card.data.draftAnswers[0], '我的译文');
  assert.ok(card.data.segments.every((part) => !part.isAnswer));
});

test('两个实际空位各有可输入片段，乱序空位仍对应原答案索引', () => {
  const card = createCard();
  const question = { id: 'multi', type: 'word', stem: '先{{1}}，再{{0}}。', answers: ['甲', '乙'] };
  card.data.variant = 'practice-word';
  card.render(question, 'writing');
  assert.equal(card.data.isWordExplanation, false);
  assert.equal(JSON.stringify(card.data.segments.filter((part) => part.isBlank).map((part) => part.answerIndex)), '[1,0]');
  card.input(1, '先写乙');
  assert.deepEqual(card.events.at(-1), { name: 'answerinput', detail: { id: 'multi', values: ['', '先写乙'], completed: false, filledCount: 1, totalCount: 2 } });
  card.input(0, '再写甲');
  assert.equal(card.events.at(-1).detail.completed, true);
  assert.equal(card.events.at(-1).detail.filledCount, 2);
  card.input(1, '  ');
  assert.equal(card.events.at(-1).detail.completed, false);
  assert.match(templateText(), /input wx:if="\{\{mode === 'writing' && item\.isBlank\}\}"[^>]*data-answer-index="\{\{item\.answerIndex\}\}"/);
});

test('无效索引输入不改变草稿或发送答题进度', () => {
  const card = createCard();
  card.render({ id: 'one', stem: '第一空{{0}}', answers: ['答'] }, 'writing');
  card.input(4, '错误');
  assert.equal(card.data.draftAnswers.length, 1);
  assert.equal(card.events.length, 0);
});

test('随机题卡复用为普通题时清理翻译状态并保留全部答案', () => {
  const card = createCard();
  card.render(mock.questions.find((item) => item.type === 'translation'), 'reciting');
  const question = mock.questions.find((item) => item.id === 'lit-shijing-six');
  card.render(question, 'reciting');
  assert.equal(card.data.isTranslation, false);
  assert.equal(card.data.translationStem, '');
  assert.equal(card.data.translationAnswer, '');
  assert.equal(JSON.stringify(card.data.segments.filter((part) => part.isAnswer).map((part) => part.text)), JSON.stringify(question.answers));
});

test('查看长答案使用独立可换行文本，不填入输入框或增加进度', () => {
  const card = createCard();
  const longAnswer = '这是一段不能被单行输入框截断的完整答案。\n第二行保留。'.repeat(12);
  const question = { id: 'long', type: 'word', stem: '填空{{0}}', answers: [longAnswer] };
  card.data.variant = 'practice-word';
  card.render(question, 'writing');
  card.input(0, '自己的答案');
  const count = card.events.length;
  card.toggleAnswer();
  assert.equal(card.data.answerVisible, true);
  assert.equal(card.data.answerText, longAnswer);
  assert.equal(card.data.draftAnswers[0], '自己的答案');
  card.toggleAnswer();
  assert.equal(card.events.length, count);
  assert.match(templateText(), /class="answer-text" selectable="\{\{true\}\}">\{\{answerText\}\}/);
  const styles = fs.readFileSync(path.join(__dirname, '../miniprogram/components/question-card/index.wxss'), 'utf8');
  assert.match(styles, /\.answer-text\s*\{[^}]*white-space:\s*pre-wrap/);
});

test('翻译自测使用自适应textarea并发送输入进度', () => {
  const card = createCard();
  const question = mock.questions.find((item) => item.type === 'translation');
  card.render(question, 'writing');
  const draft = '译文第一行\n译文第二行';
  card.input(0, draft);
  assert.equal(card.events.at(-1).detail.values[0], draft);
  assert.equal(card.events.at(-1).detail.completed, true);
  assert.match(templateText(), /textarea[^>]*data-answer-index="0"[^>]*auto-height="\{\{true\}\}"/);
  assert.doesNotMatch(templateText(), /class="write-line"|class="recall-line/);
});

test('同题收藏或掌握更新不重建输入片段或覆盖当前草稿', () => {
  const card = createCard();
  const question = { id: 'keep', stem: '{{0}}和{{1}}', answers: ['甲', '乙'], draftAnswers: ['', ''] };
  card.render(question, 'writing');
  card.input(0, '正在输入');
  card.updates.length = 0;
  card.render({ ...question, favorite: true, mastered: true }, 'writing');
  assert.equal(card.data.draftAnswers[0], '正在输入');
  assert.equal(card.updates.length, 0);
  card.render({ ...question, favorite: true, draftAnswers: ['正在输入', ''] }, 'writing');
  assert.equal(card.updates.length, 0);
});

test('不同题目不串草稿，翻回题目从页面draftAnswers恢复', () => {
  const card = createCard();
  const question = { id: 'first', stem: '{{0}}和{{1}}', answers: ['甲', '乙'] };
  card.render(question, 'writing');
  card.input(1, '乙');
  card.toggleAnswer();
  card.render({ id: 'second', stem: '{{0}}', answers: ['丙'] }, 'writing');
  assert.equal(JSON.stringify(card.data.draftAnswers), '[""]');
  assert.equal(card.data.answerVisible, false);
  card.render({ ...question, draftAnswers: ['', '乙'] }, 'writing');
  assert.equal(JSON.stringify(card.data.draftAnswers), '["","乙"]');
});

test('相同题目切换发布修订会清空未同步草稿和答案展示状态', () => {
  const card = createCard();
  const original = { id: 'republished-card', revision: 1, stem: '{{0}}', answers: ['答案'] };
  card.render(original, 'writing');
  card.input(0, '旧版未同步输入');
  card.toggleAnswer();
  card.render({ ...original, revision: 2 }, 'writing');
  assert.equal(JSON.stringify(card.data.draftAnswers), '[""]');
  assert.equal(card.data.answerVisible, false);
});

test('显式掌握操作仍触发掌握事件', () => {
  const card = createCard();
  const question = mock.questions.find((item) => item.id === 'word-rou');
  card.render(question, 'writing');
  card.master();
  assert.equal(card.events[0].name, 'master');
  assert.equal(card.events[0].detail.id, question.id);
  assert.match(templateText(), /class="master-hit" bindtap="master"/);
});

test('解释型字词专项保留括号原句，单个释义框而非把多空题统一变成一个框', () => {
  const card = createCard();
  const question = mock.questions.find((item) => item.id === 'word-rou');
  card.data.variant = 'practice-word';
  card.render(question, 'writing');
  assert.equal(card.data.isWordExplanation, true);
  assert.equal(card.data.wordStem, '“（輮）以为轮”');
  card.render(question, 'reciting');
  assert.equal(card.data.answerText, question.answers[0]);
  assert.match(templateText(), /isWordExplanation.*standaloneAnswer/);
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

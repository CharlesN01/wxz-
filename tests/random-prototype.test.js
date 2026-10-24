const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pageFile = path.join(__dirname, '../miniprogram/pages/random/index.js');
const templateFile = path.join(__dirname, '../miniprogram/pages/random/index.wxml');
const styleFile = path.join(__dirname, '../miniprogram/pages/random/index.wxss');
const questionCardStyleFile = path.join(__dirname, '../miniprogram/components/question-card/index.wxss');

function createPage() {
  let definition;
  const questions = [
    ...Array.from({ length: 13 }, (_, index) => ({ id: `literature-${index + 1}`, source: 'literature', type: 'fact', tag: '先秦', stem: '文常题目 ____', answers: ['答案'] })),
    ...Array.from({ length: 8 }, (_, index) => ({ id: `classical-word-${index + 1}`, source: 'classical', type: 'word', tag: '重点字词', stem: '“（輮）以为轮”', answers: ['使弯曲'] })),
    ...Array.from({ length: 7 }, (_, index) => ({ id: `classical-translation-${index + 1}`, source: 'classical', type: 'translation', tag: '重点翻译', stem: '青，取之于蓝，而青于蓝。', answers: ['靛青是从蓝草中提取的'] }))
  ];
  const dataService = {
    getQuestions({ source }) { return questions.filter((question) => question.source === source); },
    getQuestion(id) { return questions.find((question) => question.id === id); },
    decorateQuestions(rows) { return rows; }
  };
  const studyStore = {
    getMode() { return 'writing'; }, setMode() {}, getResume() { return null; }, saveResume() {},
    getState() { return { favorites: [], mastered: {} }; }, toggleFavorite() {}, toggleMastered() {}
  };
  const dependencies = {
    '../../utils/study-timer': { withStudyTime: (definition) => definition },
    '../../services/data-service': dataService,
    '../../utils/study-store': studyStore,
    '../../utils/safe-top': require('../miniprogram/utils/safe-top'),
    '../../utils/navigation': { openPage() {} },
    '../../utils/answer-drafts': require('../miniprogram/utils/answer-drafts'),
    '../../services/api': { auth: { getToken() { return null; } } }
  };
  vm.runInNewContext(fs.readFileSync(pageFile, 'utf8'), {
    require(name) { return dependencies[name]; },
    Page(value) { definition = value; },
    wx: {}
  }, { filename: pageFile });
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(value) { Object.assign(this.data, value); }
  };
}

test('随机页按实际轮次数动态更新进度，不固定使用原型示例百分比', () => {
  const page = createPage();
  page.onLoad({ source: 'literature', mode: 'reciting' });
  assert.equal(page.data.groupCount, 3);
  assert.equal(page.data.progressPercent, Math.round(page.data.groupNumber / page.data.groupCount * 100));

  page.onNextGroup();
  assert.equal(page.data.groupNumber, 2);
  assert.equal(page.data.progressPercent, Math.round(page.data.groupNumber / page.data.groupCount * 100));

  page.onNextGroup();
  assert.equal(page.data.groupNumber, 3);
  assert.equal(page.data.progressPercent, 100);
});

test('文常和文言随机输入独立更新本页已答，末组分母用实际题数且切模式不虚增', async () => {
  for (const source of ['literature', 'classical']) {
    const page = createPage();
    page.onLoad({ source, type: source === 'classical' ? 'word' : 'fact', mode: 'writing' });
    page.saveResume = () => { throw new Error('typing must not write resume'); };
    const firstId = page.data.questions[0].id;
    page.onAnswerInput({ detail: { id: firstId, values: ['已填写'] } });
    assert.equal(page.data.answeredCount, 1);
    assert.equal(page.data.answerProgressPercent, 17);
    assert.equal(page.data.questions[0].mastered, false);
    page.saveResume = () => {};
    page.onNextGroup();
    assert.equal(page.data.answeredCount, 0);
    page.onPreviousGroup();
    assert.equal(page.data.questions[0].draftAnswers[0], '已填写');
    assert.equal(page.data.answeredCount, 1);
    await page.onModeChange({ detail: { mode: 'reciting' } });
    assert.equal(page.data.answeredCount, 1);
    await page.onModeChange({ detail: { mode: 'writing' } });
    while (page.data.groupNumber < page.data.groupCount) page.onNextGroup();
    const lastRows = page.data.questions;
    assert.equal(page.data.pageQuestionCount, lastRows.length);
    for (const row of lastRows) page.onAnswerInput({ detail: { id: row.id, values: ['答案'] } });
    assert.equal(page.data.answerProgressPercent, 100);
  }
});

test('文常自测与背诵概览、二级标题、进度条和页码符合原型状态', () => {
  const template = fs.readFileSync(templateFile, 'utf8');
  const styles = fs.readFileSync(styleFile, 'utf8');
  assert.match(template, /mode === 'reciting' \? '文常答案背诵' : '文常随机测试'/);
  assert.match(template, /mode === 'reciting' \? '答案版' : \(mode === 'reciting' \? '背诵版' : '自测版'\)/);
  assert.match(template, /mode === 'reciting' \? '答案核对' : '全库混合'/);
  assert.match(template, /class="page-progress-fill" style="width: \{\{answerProgressPercent\}\}%;"/);
  assert.match(template, /第 \{\{groupNumber \|\| 1\}\} \/ \{\{groupCount \|\| 1\}\} 页/);
  assert.doesNotMatch(styles, /width:\s*34%/);
});

test('随机题号按当前组从 01 开始，演示状态不额外占据顶部布局', () => {
  const template = fs.readFileSync(templateFile, 'utf8');
  const styles = fs.readFileSync(styleFile, 'utf8');
  assert.match(template, /number="\{\{index \+ 1\}\}"/);
  assert.match(template, /class="overview-status">演示数据<\/text>/);
  assert.doesNotMatch(template, /class="random-notice offline-notice"/);
  assert.match(styles, /\.overview-heading\s*\{[^}]*display:\s*flex/s);
  assert.match(styles, /\.overview-status\s*\{[^}]*flex:\s*0 0 auto/s);
});

test('文言随机字词与翻译筛选仍可切换且进度随筛选题量重算', () => {
  const page = createPage();
  page.onLoad({ source: 'classical', type: 'word', mode: 'writing' });
  assert.equal(page.data.typeFilter, 'word');
  assert.equal(page.data.groupCount, 2);

  page.onTypeChange({ currentTarget: { dataset: { type: 'translation' } } });
  assert.equal(page.data.typeFilter, 'translation');
  assert.equal(page.data.questions.length, 6);
  assert.equal(page.data.groupCount, 2);
  assert.equal(page.data.progressPercent, 50);

  page.onNextGroup();
  assert.equal(page.data.questions.length, 1);
  assert.equal(page.data.progressPercent, 100);
});

test('文言随机页不显示原型中不存在的顶部进度条', () => {
  const template = fs.readFileSync(templateFile, 'utf8');
  assert.match(template, /source === 'literature' && !loading && !hasError && questions\.length/);
});

test('文言随机题卡字号对齐原型 11/12，且不缩小文常随机题卡', () => {
  const styles = fs.readFileSync(questionCardStyleFile, 'utf8');
  assert.match(styles, /\.classical-random-card \.question-index\s*\{[^}]*font-size:\s*18rpx/s);
  assert.match(styles, /\.classical-random-card \.stem\s*\{[^}]*font-size:\s*22rpx/s);
  assert.match(styles, /\.classical-random-card \.answer-toggle\s*\{[^}]*font-size:\s*18rpx/s);
  assert.match(styles, /\.classical-random-card \.answer-box\s*\{[^}]*font-size:\s*18rpx/s);
  assert.match(styles, /\.variant-random \.stem[^}]*font-size:\s*26rpx/);
});

test('文言随机题卡模板保留后端篇名出处展示', () => {
  const card = fs.readFileSync(path.join(__dirname, '../miniprogram/components/question-card/index.wxml'), 'utf8');
  assert.match(card, /question\.articleTitle \? ' · 《' \+ question\.articleTitle \+ '》'/);
});

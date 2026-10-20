const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const pagePath = path.join(__dirname, '..', 'miniprogram', 'pages', 'literature', 'index.js');

function createPage(questionCount, apiPageSize) {
  let definition;
  const calls = [];
  const questions = Array.from({ length: questionCount }, (_value, index) => ({
    id: 'q' + (index + 1),
    source: 'literature',
    stem: '题目 ' + (index + 1) + ' {{0}}',
    answers: ['答案 ' + (index + 1)]
  }));
  const api = {
    auth: { getToken: () => null },
    content: {
      categories: () => Promise.resolve({ results: [{ id: 'pre-qin', name: '先秦文学' }] }),
      questions: ({ page }) => {
        calls.push(page);
        const start = (page - 1) * apiPageSize;
        return Promise.resolve({
          count: questionCount,
          results: questions.slice(start, start + apiPageSize),
          access: { pageSize: apiPageSize, restrictedCount: 0 }
        });
      }
    },
    learning: {}
  };
  const navigation = { openPage() {} };
  const wx = { pageScrollTo() {}, showToast() {} };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require(name) {
      if (name === '../../services/api') return api;
      if (name === '../../utils/navigation') return navigation;
      if (name === '../../utils/safe-top') return { getSafeTop: () => 0 };
      if (name === '../../utils/question-utils') return require('../miniprogram/utils/question-utils');
      if (name === '../../utils/answer-drafts') return require('../miniprogram/utils/answer-drafts');
      throw new Error('Unexpected module: ' + name);
    },
    Page(value) { definition = value; },
    wx
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: Object.assign({}, definition.data, { categoryId: 'pre-qin' }),
    setData(value) { Object.assign(this.data, value); }
  };
  page._options = {};
  page._questionRequest = 0;
  page._questionPages = {};
  page._questionRows = [];
  page._stateMap = {};
  page._pendingState = {};
  page._answerVisible = {};
  page._resumeQuestionId = '';
  return { page, calls, api };
}

test('文学常识页面固定每组 6 题，适配后端 20 题分页并正确跨页', async () => {
  const { page, calls } = createPage(26, 20);

  await page.loadPage(1);
  assert.equal(page.data.pageSize, 6);
  assert.equal(page.data.pageCount, 5);
  assert.equal(page.data.questionProgressLabel, '01 / 26');
  assert.deepEqual(Array.from(page.data.questions, (item) => item.id), ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);

  await page.loadPage(4);
  assert.equal(page.data.questionProgressLabel, '19 / 26');
  assert.deepEqual(Array.from(page.data.questions, (item) => item.id), ['q19', 'q20', 'q21', 'q22', 'q23', 'q24']);
  assert.deepEqual(calls, [1, 2]);
});

test('文学常识首次加载完成后退出 loading 并显示首组题目', async () => {
  const { page } = createPage(8, 20);

  await page.bootstrap();

  assert.equal(page.data.loading, false);
  assert.equal(page.data.hasError, false);
  assert.equal(page.data.categoryId, 'pre-qin');
  assert.equal(page.data.questions.length, 6);
  assert.equal(page.data.questionProgressLabel, '01 / 08');
});

test('文学本页答题进度随真实输入和清空变化，翻页与查看答案不增加已答', async () => {
  const { page } = createPage(8, 20);
  await page.loadPage(1);
  assert.equal(page.data.answeredCount, 0);
  assert.equal(page.data.answerProgressPercent, 0);
  page.toggleAnswer({ currentTarget: { dataset: { id: 'q1' } } });
  assert.equal(page.data.answeredCount, 0);
  page.onBlankInput({ currentTarget: { dataset: { id: 'q1', index: 0 } }, detail: { value: '自填答案' } });
  assert.equal(page.data.answeredCount, 1);
  assert.equal(page.data.answerProgressPercent, 17);
  assert.equal(page.data.questions[0].mastered, false);
  await page.loadPage(2);
  assert.equal(page.data.pageQuestionCount, 2);
  assert.equal(page.data.answeredCount, 0);
  page.onAnswerInput({ detail: { id: 'q7', values: ['回答'] } });
  assert.equal(page.data.answerProgressPercent, 50);
  await page.loadPage(1);
  assert.equal(page.data.questions[0].draftAnswers[0], '自填答案');
  assert.equal(page.data.answeredCount, 1);
  page.onBlankInput({ currentTarget: { dataset: { id: 'q1', index: 0 } }, detail: { value: '  ' } });
  assert.equal(page.data.answeredCount, 0);
});

test('文学乱序多空严格按placeholder索引展示input，不用答案数追加无关输入', async () => {
  const { page, api } = createPage(1, 20);
  api.content.questions = async () => ({ count: 1, results: [{ id: 'ordered-blank', stem: '先{{1}}后{{0}}再{{1}}', answers: ['甲', '乙', '额外说明'] }], access: { pageSize: 20 } });
  await page.loadPage(1);
  assert.deepEqual(Array.from(page.data.questions[0].parts.filter(part => part.isBlank), part => part.answerIndex), [1, 0, 1]);
  page.onAnswerInput({ detail: { id: 'ordered-blank', values: ['甲', ''] } });
  assert.equal(page.data.answeredCount, 0);
  page.onAnswerInput({ detail: { id: 'ordered-blank', values: ['甲', '乙'] } });
  assert.equal(page.data.answeredCount, 1);
  assert.equal(page.data.answerProgressPercent, 100);
});

test('文学切换背诵立即显示答案，切回自测保留草稿且不把答案算作输入', async () => {
  const { page } = createPage(2, 20);
  await page.loadPage(1);
  page.ensureLogin = async () => false;
  page.onAnswerInput({ detail: { id: 'q1', values: ['我的答案'] } });
  await page.changeMode({ detail: { mode: 'reciting' } });
  assert.equal(page.data.questions[0].parts.some(part => part.isFilled), true);
  assert.equal(page.data.questions[0].parts.some(part => part.isBlank), false);
  assert.equal(page.data.answeredCount, 1);
  await page.changeMode({ detail: { mode: 'writing' } });
  assert.equal(page.data.questions[0].parts.some(part => part.isBlank), true);
  assert.equal(page.data.questions[0].draftAnswers[0], '我的答案');
  assert.equal(page.data.answeredCount, 1);
});

test('已登录文学首屏使用题目附带的状态，不再逐题请求状态接口', async () => {
  const { page, api, calls } = createPage(287, 20);
  api.auth.getToken = () => 'learner';
  const readQuestions = api.content.questions;
  api.content.questions = async (params) => {
    const response = await readQuestions(params);
    response.results.forEach((row, index) => { row.state = { questionId: row.id, favorite: index === 0, mastered: index === 1, version: index + 2 }; });
    return response;
  };
  api.learning.questionState = () => { throw new Error('unexpected per-question state read'); };
  page.queueResume = () => {};
  await page.loadPage(1);
  assert.equal(page.data.loading, false);
  assert.deepEqual(calls, [1]);
  assert.equal(page.data.questions.length, 6);
  assert.equal(page.data.questions[0].favorite, true);
  assert.equal(page.data.questions[1].mastered, true);
  assert.equal(page.data.questions[1].version, 3);
});

test('文学常识最后一组只显示剩余题目并可恢复到包含续学题的六题组', async () => {
  const { page } = createPage(14, 20);
  page._resumeQuestionId = 'q14';

  await page.loadPage(1, { findResume: true });

  assert.equal(page.data.page, 3);
  assert.equal(page.data.pageCount, 3);
  assert.equal(page.data.questionProgressLabel, '13 / 14');
  assert.deepEqual(Array.from(page.data.questions, (item) => item.id), ['q13', 'q14']);
});

test('文学深页续学直接定位目标题页，不扫描此前所有API分页', async () => {
  const { page, api, calls } = createPage(287, 20);
  page._resumeQuestionId = 'q281';
  api.content.question = async () => ({ id: 'q281', source: 'literature', categoryId: 'pre-qin', scopeIndex: 280 });
  await page.loadPage(1, { findResume: true });
  assert.deepEqual(calls, [1, 14, 15]);
  assert.equal(page.data.page, 47);
  assert.equal(page.data.questions[4].id, 'q281');
});

test('文学分页缓存中的旧状态不会覆盖本页已保存的新收藏状态', async () => {
  const { page, api } = createPage(25, 20);
  api.auth.getToken = () => 'learner';
  page._stateMap.q1 = { favorite: true, mastered: false, version: 8 };
  await page.loadStates([{ id: 'q1', state: { favorite: false, mastered: false, version: 0 } }], 0);
  assert.equal(page._stateMap.q1.favorite, true);
  assert.equal(page._stateMap.q1.version, 8);
});

test('开通权益返回文学页面重新获取完整题量并清除免费分页缓存', async () => {
  const { page, api } = createPage(30, 20);
  let activated = false;
  let reads = 0;
  api.auth.getToken = () => 'same-learner-session';
  api.learning.questionState = async () => ({ version: 0 });
  api.content.questions = async ({ page: number }) => {
    reads += 1;
    const count = activated ? 30 : 20;
    return { count, access: { pageSize: 20, restrictedCount: activated ? 0 : 10 },
      results: Array.from({ length: Math.min(20, count - (number - 1) * 20) }, (_, index) => ({ id: 'q' + ((number - 1) * 20 + index + 1), stem: '题干', answers: [] })) };
  };
  page.queueResume = () => {};
  page._loaded = true;
  await page.loadPage(1);
  assert.equal(page.data.restrictedCount, 10);
  assert.equal(page.data.totalQuestions, 20);
  activated = true;
  await page.onShow();
  assert.equal(reads, 2);
  assert.equal(page.data.restrictedCount, 0);
  assert.equal(page.data.totalQuestions, 30);
  await page.loadPage(5);
  assert.deepEqual(Array.from(page.data.questions, row => row.id), ['q25', 'q26', 'q27', 'q28', 'q29', 'q30']);
  activated = false;
  await page.onShow();
  assert.equal(page.data.page, 4);
  assert.equal(page.data.totalQuestions, 20);
  assert.equal(page.data.questions.length, 2);
  assert.equal(page.data.restrictedCount, 10);
});

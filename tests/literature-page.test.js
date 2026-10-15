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
  return { page, calls };
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

test('文学常识最后一组只显示剩余题目并可恢复到包含续学题的六题组', async () => {
  const { page } = createPage(14, 20);
  page._resumeQuestionId = 'q14';

  await page.loadPage(1, { findResume: true });

  assert.equal(page.data.page, 3);
  assert.equal(page.data.pageCount, 3);
  assert.equal(page.data.questionProgressLabel, '13 / 14');
  assert.deepEqual(Array.from(page.data.questions, (item) => item.id), ['q13', 'q14']);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const pagePath = path.join(__dirname, '..', 'miniprogram', 'pages', 'practice', 'index.js');

function createPage(resume, questionPayload) {
  let definition;
  let savedBody;
  const questionCalls = [];
  const routes = [];
  const questions = Array.from({ length: 12 }, (_value, index) => ({ id: 'question-' + (index + 1) }));
  const api = {
    auth: { getToken: () => 'qa-session' },
    content: {
      questions: async (params, options) => {
        questionCalls.push({ params, options });
        return questionPayload || { results: [{ id: 'question-1', source: 'classical', articleId: 'quanxue', type: 'word', stem: '题干', answers: ['答案'] }], next: null };
      }
    },
    learning: {
      questionState: async (id) => ({ questionId: id, favorite: false, mastered: false, version: 0 }),
      resume: async () => ({ valid: true, resume, version: 3 }),
      saveResume: async (body) => { savedBody = body; return { version: 4 }; }
    }
  };
  const studyStore = {
    getMode: () => 'writing',
    getState: () => ({ favorites: [], mastered: {} }),
    saveResume() {}
  };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require(name) {
      if (name === '../../services/data-service') return { getArticles: () => [] };
      if (name === '../../utils/study-store') return studyStore;
      if (name === '../../utils/navigation') return { openPage: (url) => routes.push(url) };
      if (name === '../../services/api') return api;
      throw new Error('Unexpected module: ' + name);
    },
    Page(value) { definition = value; },
    wx: { pageScrollTo() {}, request() {} }
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: Object.assign({}, definition.data),
    setData(value) { Object.assign(this.data, value); }
  };
  page.articleId = 'quanxue';
  page.questionType = 'word';
  page.allQuestions = questions;
  page._stateMap = {};
  page._groupCache = {};
  page._resumeVersion = 0;
  return { page, api, routes, questions, getSavedBody: () => savedBody, questionCalls };
}

test('专项练习按 API 约定只用 questionId 恢复顺序题组', async () => {
  const { page } = createPage({
    source: 'classical', articleId: 'quanxue', type: 'word', mode: 'writing',
    questionId: 'question-8', roundId: null, groupIndex: null
  });

  await page.restoreResume();

  assert.equal(page.data.groupIndex, 1);
});

test('专项练习续学请求不向非随机位置提交 groupIndex', async () => {
  const { page, questions, getSavedBody } = createPage(null);
  page.data.groupIndex = 1;
  page.data.mode = 'reciting';
  page.allQuestions = questions;

  page.savePosition();
  await Promise.resolve();

  assert.equal(getSavedBody().questionId, 'question-7');
  assert.equal(getSavedBody().roundId, null);
  assert.equal(getSavedBody().groupIndex, null);
});

test('字词和翻译有部分免费题时，开通权益返回也会重新加载受限题', async () => {
  for (const type of ['word', 'translation']) {
    const { page, api, questionCalls } = createPage(null, {
      count: 1, results: [{ id: 'free-q', stem: '免费题', answers: [] }], next: null,
      access: { restrictedCount: 2 }
    });
    page.questionType = type;
    page.savePosition = () => {};
    await page.loadRemote(false);
    assert.equal(page.data.requiresEntitlement, false);
    assert.equal(page.data.restrictedCount, 2);
    assert.equal(page.data.total, 1);
    api.content.questions = async () => ({ count: 3, results: [
      { id: 'free-q', stem: '免费题', answers: [] },
      { id: 'paid-q1', stem: '付费题1', answers: [] },
      { id: 'paid-q2', stem: '付费题2', answers: [] }
    ], next: null, access: { restrictedCount: 0 } });
    await page.onShow();
    assert.equal(questionCalls[0].options.auth, true);
    assert.equal(page.data.total, 3);
    assert.equal(page.data.restrictedCount, 0);
    assert.equal(page.data.questions.length, 3);
  }
});

test('专项练习首个题目分页请求在已有会话时携带 Bearer 认证选项', async () => {
  const { page, questionCalls } = createPage(null);
  await page.loadRemote(false);
  assert.equal(questionCalls.length, 1);
  assert.equal(questionCalls[0].options.auth, true);
});

test('专项有已发布题但无免费题时显示权益入口，开通后重读题目', async () => {
  const { page, api, routes } = createPage(null, {
    results: [], next: null, access: { totalCount: 30, restrictedCount: 30, freeCount: 0 }
  });
  await page.loadRemote(false);
  assert.equal(page.data.requiresEntitlement, true);
  assert.equal(page.data.restrictedCount, 30);
  assert.equal(page.data.dataSource, 'remote');
  assert.equal(page.data.hasError, false);
  assert.equal(page.data.questions.length, 0);
  page.onEmptyAction();
  assert.deepEqual(routes, ['/pages/mine/index']);

  api.content.questions = async () => ({
    results: [{ id: 'paid-word', source: 'classical', type: 'word', stem: '{{0}}', answers: ['答案'] }],
    access: { restrictedCount: 0 }, next: null
  });
  await page.loadRemote(false);
  assert.equal(page.data.requiresEntitlement, false);
  assert.equal(page.data.questions[0].id, 'paid-word');
});

test('专项真正无已发布题时保留空态', async () => {
  const { page } = createPage(null, {
    results: [], next: null, access: { totalCount: 0, restrictedCount: 0, freeCount: 0 }
  });
  await page.loadRemote(false);
  assert.equal(page.data.requiresEntitlement, false);
  assert.equal(page.data.restrictedCount, 0);
  assert.equal(page.data.total, 0);
});

test('跨篇目专项保留每篇的受限题数量', async () => {
  const { page, api } = createPage(null, {
    results: [], next: null, access: { totalCount: 30, restrictedCount: 30, freeCount: 0 }
  });
  page.articleId = '';
  api.content.articles = async () => ({ results: [{ id: 'quanxue' }, { id: 'liuguo' }], next: null });
  await page.loadRemote(false);
  assert.equal(page.data.requiresEntitlement, true);
  assert.equal(page.data.restrictedCount, 60);
});

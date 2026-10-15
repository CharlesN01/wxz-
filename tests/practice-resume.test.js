const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const pagePath = path.join(__dirname, '..', 'miniprogram', 'pages', 'practice', 'index.js');

function createPage(resume) {
  let definition;
  let savedBody;
  const questionCalls = [];
  const questions = Array.from({ length: 12 }, (_value, index) => ({ id: 'question-' + (index + 1) }));
  const api = {
    auth: { getToken: () => 'qa-session' },
    content: {
      questions: async (params, options) => {
        questionCalls.push({ params, options });
        return { results: [{ id: 'question-1', source: 'classical', articleId: 'quanxue', type: 'word', stem: '题干', answers: ['答案'] }], next: null };
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
      if (name === '../../utils/navigation') return {};
      if (name === '../../services/api') return api;
      throw new Error('Unexpected module: ' + name);
    },
    Page(value) { definition = value; },
    wx: { pageScrollTo() {} }
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
  return { page, questions, getSavedBody: () => savedBody, questionCalls };
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

test('专项练习首个题目分页请求在已有会话时携带 Bearer 认证选项', async () => {
  const { page, questionCalls } = createPage(null);
  await page.loadRemote(false);
  assert.equal(questionCalls.length, 1);
  assert.equal(questionCalls[0].options.auth, true);
});

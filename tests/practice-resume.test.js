const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const pagePath = path.join(__dirname, '..', 'miniprogram', 'pages', 'practice', 'index.js');

function createPage(resume) {
  let definition;
  let savedBody;
  const questions = Array.from({ length: 12 }, (_value, index) => ({ id: 'question-' + (index + 1) }));
  const api = {
    auth: { getToken: () => 'qa-session' },
    learning: {
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
  return { page, questions, getSavedBody: () => savedBody };
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

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const pagePath = path.join(__dirname, '..', 'miniprogram', 'pages', 'favorites', 'index.js');
const templatePath = path.join(__dirname, '..', 'miniprogram', 'pages', 'favorites', 'index.wxml');

test('今日新增采用服务端跨分页总数，取消收藏后重新加载立即更新', async () => {
  let count = 3;
  let todayAdded = 2;
  const { page } = createPage('writing', {
    auth: { getToken: () => 'learner' },
    createIdempotencyKey: () => 'favorite-counter-test',
    learning: {
      favorites: async () => ({ count, todayAdded, next: '/next', results: [{ question: { id: 'l1', source: 'literature' }, state: { favorite: true } }] }),
      questionState: async () => ({ favorite: true, version: 1 }),
      setQuestionState: async () => { count = 2; todayAdded = 1; return { favorite: false, version: 2 }; }
    },
    pagination: { follow: async () => ({ count, todayAdded: 0, next: null, results: [] }) }
  });
  page._categoryId = '';
  page._sourceFilter = 'literature';
  await page._refreshFavorites();
  assert.equal(page.data.todayAdded, 2);
  assert.equal(page.data.totalFavorites, 3);
  await page.onFavorite({ detail: { id: 'l1' } });
  assert.equal(page.data.todayAdded, 1);
  assert.equal(page.data.totalFavorites, 2);
  page._sourceFilter = 'classical';
  await page._refreshFavorites();
  assert.equal(page.data.todayAdded, 1);
  assert.equal(page.data.questions.length, 0);
});

function createPage(mode = 'writing', apiOverrides = {}) {
  let definition;
  const api = Object.assign({ auth: { getToken: () => null } }, apiOverrides);
  const currentMode = mode || 'writing';
  const studyStore = { getMode: () => currentMode, getState: () => ({ favorites: [], mode: currentMode }), todayKey: () => '2026-10-21' };
  const questionUtils = require('../miniprogram/utils/question-utils');
  const dataService = { getQuestions: () => [], decorateQuestions: (questions) => questions };
  const navigation = { openPage() {} };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require(name) {
      if (name === '../../utils/study-timer') return { withStudyTime: (definition) => definition };
      if (name === '../../services/data-service') return dataService;
      if (name === '../../utils/study-store') return studyStore;
      if (name === '../../utils/question-utils') return questionUtils;
      if (name === '../../services/api') return api;
      if (name === '../../utils/navigation') return navigation;
      if (name === '../../utils/answer-drafts') return require('../miniprogram/utils/answer-drafts');
      if (name === '../../utils/agent-attribution') return { read: () => '', sharePath: (value) => value, shareQuery: () => '' };
      throw new Error('Unexpected module: ' + name);
    },
    Page(value) { definition = value; },
    wx: { showToast() {} }
  }, { filename: pagePath });
  return {
    page: {
      ...definition,
      data: Object.assign({}, definition.data),
      setData(value) { Object.assign(this.data, value); }
    }
  };
}

test('收藏页来源筛选显示该来源的完整列表，6 条混合收藏不会被截成 5 条', () => {
  const { page } = createPage();
  page._categoryId = '';
  page._sourceFilter = 'literature';
  page._remoteRows = [
    { id: 'l1', source: 'literature', stem: '文常 1' },
    { id: 'c1', source: 'classical', stem: '文言 1' },
    { id: 'l2', source: 'literature', stem: '文常 2' },
    { id: 'c2', source: 'classical', stem: '文言 2' },
    { id: 'l3', source: 'literature', stem: '文常 3' },
    { id: 'c3', source: 'classical', stem: '文言 3' }
  ];

  page._renderRemote({ count: 6 });
  assert.deepEqual(Array.from(page.data.questions, (item) => item.id), ['l1', 'l2', 'l3']);
  assert.equal(page.data.hasQuestions, true);

  page._sourceFilter = 'classical';
  page._renderRemote({ count: 6 });
  assert.deepEqual(Array.from(page.data.questions, (item) => item.id), ['c1', 'c2', 'c3']);
  assert.equal(page.data.hasQuestions, true);
});

test('收藏页远端列表超过 5 条时在无分页控件的原型布局中仍全部可见', () => {
  const { page } = createPage();
  page._categoryId = '';
  page._sourceFilter = 'literature';
  page._remoteRows = Array.from({ length: 7 }, (_value, index) => ({
    id: 'l' + (index + 1),
    source: 'literature',
    stem: '文常 ' + (index + 1)
  }));

  page._renderRemote({ count: 7 });
  assert.equal(page.data.questions.length, 7);
  assert.equal(page.data.hasQuestions, true);
});

test('收藏翻译题即使带placeholder也用独立多行输入，保留完整原句和长答案', () => {
  const { page } = createPage();
  const answer = '这是需要完整展示的译文。'.repeat(35);
  page._categoryId = '';
  page._sourceFilter = 'classical';
  page._remoteRows = [{ id: 'translation-draft-favorite', source: 'classical', type: 'translation', stem: '青，取之于蓝，而青于蓝。{{0}}', answers: [answer] }];
  page._renderRemote({ count: 1 });
  assert.equal(page.data.questions[0].hasInlineBlanks, false);
  assert.equal(page.data.questions[0].parts.map(part => part.text).join(''), '青，取之于蓝，而青于蓝。');
  assert.equal(page.data.questions[0].answerText, '译文：' + answer);
  page.onBlankInput({ currentTarget: { dataset: { id: 'translation-draft-favorite', index: 0 } }, detail: { value: '我的长译文'.repeat(100) } });
  assert.equal(page.data.answeredCount, 1);
  assert.equal(page.data.questions[0].draftAnswers[0].length, 500);
  const template = fs.readFileSync(templatePath, 'utf8');
  assert.match(template, /<textarea[^>]*auto-height="\{\{true\}\}"/);
  assert.match(template, /mode === 'reciting' && item\.type === 'translation'/);
});

test('收藏页 hasQuestions 与远端和本地列表是否为空保持同步', () => {
  const { page } = createPage();
  page._categoryId = '';
  page._sourceFilter = 'literature';

  page._remoteRows = [{ id: 'l1', source: 'literature', stem: '文常 1' }];
  page._renderRemote({ count: 1 });
  assert.equal(page.data.hasQuestions, true);

  page._remoteRows = [];
  page._renderRemote({ count: 0 });
  assert.equal(page.data.hasQuestions, false);

  page._renderLocal();
  assert.equal(page.data.hasQuestions, false);

  const template = fs.readFileSync(templatePath, 'utf8');
  assert.match(template, /favorites-questions" wx:if="\{\{hasQuestions\}\}"/);
  assert.match(template, /!loading && !hasError && !hasQuestions/);
});

test('收藏卡片格式化后端填空题干，答案按文常与文言翻译显示原型前缀', () => {
  const { page } = createPage();
  page._categoryId = '';
  page._sourceFilter = 'literature';
  page._remoteRows = [{
    id: 'l1', source: 'literature', title: '《诗经》',
    stem: '《诗经》是我国最早的一部{{0}}诗歌总集，共收录{{1}}篇？', answers: ['风雅颂', '305']
  }];
  page._renderRemote({ count: 1 });
  assert.equal(page.data.questions[0].answerText, '答案：风雅颂；305');
  assert.equal(page.data.questions[0].parts.map((part) => part.text).join(''), '《诗经》是我国最早的一部____诗歌总集，共收录____篇？');
  assert.equal(page.data.hasQuestions, true);

  page._sourceFilter = 'classical';
  page._remoteRows = [{
    id: 'c1', source: 'classical', type: 'translation', title: '句子翻译',
    stem: '秦王还柱而走，卒惶急不知所为。', answers: ['秦王绕着柱子逃跑。']
  }];
  page._renderRemote({ count: 1 });
  assert.equal(page.data.questions[0].answerText, '译文：秦王绕着柱子逃跑。');
  assert.equal(page.data.hasQuestions, true);

  const template = fs.readFileSync(templatePath, 'utf8');
  assert.match(template, /wx:for="\{\{item\.parts\}\}"/);
});

test('收藏页背诵模式展开答案并移除后端占位符', () => {
  const { page } = createPage('reciting');
  page._categoryId = '';
  page._sourceFilter = 'literature';
  page._remoteRows = [{
    id: 'l1', source: 'literature',
    stem: '体例为{{0}}、{{1}}。', answers: ['风', '雅']
  }];

  page._renderRemote({ count: 1 });

  assert.equal(page.data.questions[0].parts.map((part) => part.text).join(''), '体例为风、雅。');
  assert.equal(page.data.questions[0].parts.filter((part) => part.isFilled).length, 2);
  assert.doesNotMatch(page.data.questions[0].parts.map((part) => part.text).join(''), /\{\{\d+\}\}/);
});

test('收藏页保留带安全元数据的受限收藏并按来源展示', () => {
  const { page } = createPage();
  page._categoryId = '';
  page._sourceFilter = 'literature';
  page._remoteRows = [{ id: 'paid-lit', state: { questionId: 'paid-lit', favorite: true }, source: 'literature', categoryId: 'pre-qin', type: 'fact', unavailable: true, unavailableReason: 'ENTITLEMENT_REQUIRED', title: '该考点暂不可访问', stem: '当前账号暂无查看此题内容的权限。' }];
  page._renderRemote({ count: 1 });
  assert.equal(page.data.questions.length, 1);
  assert.equal(page.data.questions[0].unavailable, true);
  assert.equal(page.data.questions[0].source, 'literature');
  assert.equal(page.data.questions[0].parts.map((part) => part.text).join(''), '当前账号暂无查看此题内容的权限。');

  page._sourceFilter = 'classical';
  page._renderRemote({ count: 1 });
  assert.equal(page.data.questions.length, 0);
});

test('收藏页从 question=null 的原始接口行保留来源并展示受限占位', () => {
  const { page } = createPage();
  page._categoryId = '';
  page._sourceFilter = 'classical';

  page._remoteRows = page._extractRows({
    count: 1,
    results: [{
      state: { questionId: 'paid-classical', favorite: true, mastered: false, version: 2 },
      question: null,
      source: 'classical',
      categoryId: null,
      articleId: 'quanxue',
      type: 'word',
      unavailableReason: 'ENTITLEMENT_REQUIRED'
    }]
  });
  page._renderRemote({ count: 1 });

  assert.equal(page.data.questions.length, 1);
  assert.equal(page.data.questions[0].id, 'paid-classical');
  assert.equal(page.data.questions[0].source, 'classical');
  assert.equal(page.data.questions[0].unavailable, true);
  assert.equal(page.data.questions[0].unavailableReason, 'ENTITLEMENT_REQUIRED');
});

test('收藏空态与原型一致，只显示简短提示而不显示插画或去学习按钮', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  assert.match(template, /class="favorites-empty"[^>]*>这里还没有收藏内容<\/view>/);
  assert.doesNotMatch(template, /<empty-state/);
});

test('受限收藏不显示查看答案操作，避免误导用户请求受保护答案', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  assert.match(template, /wx:if="\{\{!item\.unavailable\}\}" class="answer-button"/);
});

test('收藏切换读取 baseVersion，并为写入传递幂等键', async () => {
  const calls = [];
  const { page } = createPage('writing', {
    auth: { getToken: () => 'token' },
    createIdempotencyKey: () => 'favorites-key-1',
    learning: {
      questionState: async () => ({ favorite: true, mastered: false, version: 7 }),
      setQuestionState: async (...args) => { calls.push(args); return { favorite: false, version: 8 }; }
    }
  });

  await page._updateState('q-1', 'favorite');
  assert.equal(calls[0][1].favorite, false);
  assert.equal(calls[0][1].baseVersion, 7);
  assert.equal(calls[0][2].idempotencyKey, 'favorites-key-1');
});

test('收藏状态 409 重试使用服务端版本和新的幂等键', async () => {
  const calls = [];
  let keyIndex = 0;
  const { page } = createPage('writing', {
    auth: { getToken: () => 'token' },
    createIdempotencyKey: () => `favorites-key-${++keyIndex}`,
    learning: {
      questionState: async () => ({ favorite: false, mastered: false, version: 3 }),
      setQuestionState: async (...args) => {
        calls.push(args);
        if (calls.length === 1) {
          const error = new Error('conflict');
          error.code = 'VERSION_CONFLICT';
          error.current = { favorite: true, mastered: false, version: 4 };
          throw error;
        }
        return { favorite: true, version: 5 };
      }
    }
  });

  await page._updateState('q-1', 'favorite');
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].baseVersion, 3);
  assert.equal(calls[1][1].baseVersion, 4);
  assert.equal(calls[0][2].idempotencyKey, 'favorites-key-1');
  assert.equal(calls[1][2].idempotencyKey, 'favorites-key-2');
});

test('收藏快速重复点击只提交一次状态写入', async () => {
  const calls = [];
  let resolveWrite;
  const writeDone = new Promise((resolve) => { resolveWrite = resolve; });
  const { page } = createPage('writing', {
    auth: { getToken: () => 'token' },
    createIdempotencyKey: () => 'favorites-key-1',
    learning: {
      questionState: async () => ({ favorite: true, mastered: false, version: 1 }),
      setQuestionState: async (...args) => { calls.push(args); await writeDone; return { favorite: false, version: 2 }; }
    }
  });

  const first = page._updateState('q-1', 'favorite');
  const second = page._updateState('q-1', 'favorite');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  resolveWrite();
  await Promise.all([first, second]);
});

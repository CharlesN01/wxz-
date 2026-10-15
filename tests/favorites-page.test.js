const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const pagePath = path.join(__dirname, '..', 'miniprogram', 'pages', 'favorites', 'index.js');
const templatePath = path.join(__dirname, '..', 'miniprogram', 'pages', 'favorites', 'index.wxml');

function createPage(mode = 'writing') {
  let definition;
  const api = { auth: { getToken: () => null } };
  const currentMode = mode || 'writing';
  const studyStore = { getMode: () => currentMode, getState: () => ({ favorites: [], mode: currentMode }) };
  const questionUtils = require('../miniprogram/utils/question-utils');
  const dataService = { getQuestions: () => [], decorateQuestions: (questions) => questions };
  const navigation = { openPage() {} };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require(name) {
      if (name === '../../services/data-service') return dataService;
      if (name === '../../utils/study-store') return studyStore;
      if (name === '../../utils/question-utils') return questionUtils;
      if (name === '../../services/api') return api;
      if (name === '../../utils/navigation') return navigation;
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

test('收藏空态与原型一致，只显示简短提示而不显示插画或去学习按钮', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  assert.match(template, /class="favorites-empty"[^>]*>这里还没有收藏内容<\/view>/);
  assert.doesNotMatch(template, /<empty-state/);
});

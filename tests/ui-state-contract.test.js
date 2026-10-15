const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');

function loadPage(relativePath, overrides = {}, globals = {}) {
  const filename = path.join(root, 'miniprogram', relativePath);
  const localRequire = createRequire(filename);
  let definition;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(request) {
      return Object.prototype.hasOwnProperty.call(overrides, request) ? overrides[request] : localRequire(request);
    },
    Page(value) { definition = value; },
    wx: globals.wx,
    getCurrentPages: globals.getCurrentPages || (() => [])
  }, { filename });
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(value) { Object.assign(this.data, value); }
  };
  return page;
}

function jsonCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

test('9 个原生路由承载 16 个原型状态所需页面均已注册', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
  assert.deepEqual(config.pages, [
    'pages/home/index', 'pages/literature/index', 'pages/classical/index',
    'pages/practice/index', 'pages/random/index', 'pages/favorites/index',
    'pages/application/index', 'pages/mine/index', 'pages/resources/index'
  ]);
});

test('自测题卡提供查看答案控件，背诵模式显示完整答案', () => {
  const card = fs.readFileSync(path.join(root, 'miniprogram/components/question-card/index.wxml'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'miniprogram/components/question-card/index.js'), 'utf8');
  assert.match(card, /查看答案/);
  assert.match(card, /answerVisible/);
  assert.match(script, /toggleAnswer/);
  assert.match(script, /mode === 'reciting'/);
});

test('本地降级状态在练习、随机和收藏页面显式标识', () => {
  for (const page of ['practice', 'random', 'favorites']) {
    const template = fs.readFileSync(path.join(root, `miniprogram/pages/${page}/index.wxml`), 'utf8');
    assert.match(template, /dataSource === 'local'/);
  }
});

test('文常随机使用原型底栏，文言随机保留顶部自定义导航', () => {
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/random/index.wxml'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'miniprogram/pages/random/index.js'), 'utf8');
  assert.match(template, /study-navbar wx:if="\{\{source === 'classical'\}\}"/);
  assert.match(template, /wx:if="\{\{source === 'literature'\}\}" class="bottom-nav"/);
  assert.match(script, /openHome\(\)/);
  assert.match(script, /openFavorites\(\)/);
  assert.match(script, /openProfile\(\)/);
});

test('首页入口固定进入自测；随机续学保留上下文；资料群按钮打开首页弹窗', () => {
  const routes = [];
  const navigation = { openPage(path, params) { routes.push({ path, params: jsonCopy(params || {}) }); } };
  const toasts = [];
  const page = loadPage('pages/home/index.js', {
    '../../services/api': {},
    '../../utils/navigation': navigation
  }, { wx: { showToast(value) { toasts.push(value); } } });

  page.data.resume = {
    roundId: 'round-3', groupIndex: 2, source: 'classical', type: 'translation',
    articleId: 'article-9', mode: 'reciting'
  };
  page.continueLearning();
  assert.deepEqual(routes.pop(), {
    path: '/pages/random/index',
    params: {
      source: 'classical', type: 'translation', articleId: 'article-9',
      roundId: 'round-3', groupIndex: 2, mode: 'reciting', resume: 1
    }
  });

  page.openGroupModal();
  assert.equal(page.data.groupModalVisible, true);
  page.openModule({ currentTarget: { dataset: { page: 'random', source: 'literature' } } });
  assert.deepEqual(routes.pop(), { path: '/pages/random/index', params: { source: 'literature', mode: 'writing' } });
  page.moreSettings();
  assert.equal(toasts[0].title, '更多设置');
  const homeTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/home/index.wxml'), 'utf8');
  assert.match(homeTemplate, /study-navbar[^>]*bind:more="moreSettings"/);
});

test('首页内容顺序与原型保持一致，学习趋势排在资料群之后', () => {
  const styles = fs.readFileSync(path.join(root, 'miniprogram/pages/home/index.wxss'), 'utf8');
  assert.match(styles, /\.home-body\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column/s);
  assert.match(styles, /\.section-title\s*\{\s*order:\s*2;/);
  assert.match(styles, /\.module-grid\s*\{\s*order:\s*3;/);
  assert.match(styles, /\.continue-card\s*\{\s*order:\s*4;/);
  assert.match(styles, /\.group-card\s*\{\s*order:\s*5;/);
  assert.match(styles, /\.growth-card\s*\{\s*order:\s*6;/);
});

test('文言目录接收首页续学模式和篇目，并保留 questionId 进入对应专项', () => {
  const routes = [];
  const modes = [];
  const navigation = { openPage(path, params) { routes.push({ path, params: jsonCopy(params || {}) }); } };
  const store = { getMode() { return 'writing'; }, setMode(mode) { modes.push(mode); } };
  const toasts = [];
  const page = loadPage('pages/classical/index.js', {
    '../../services/data-service': { getArticleProgress() { return []; } },
    '../../utils/study-store': store,
    '../../utils/navigation': navigation,
    '../../services/api': {}
  }, { wx: { showToast(value) { toasts.push(value); } } });

  page.onLoad({ articleId: 'article-9', questionId: 'question-4', mode: 'reciting' });
  page.articles = [{ id: 'article-9', title: '示例篇目' }];
  page.restoreRequestedArticle();
  assert.equal(page.data.mode, 'reciting');
  assert.deepEqual(modes, ['reciting']);
  assert.equal(page.data.modalVisible, true);
  assert.equal(page.data.selectedArticle.id, 'article-9');

  page.onChooseType({ currentTarget: { dataset: { type: 'translation' } } });
  assert.deepEqual(routes.pop(), {
    path: '/pages/practice/index',
    params: {
      articleId: 'article-9', articleTitle: '示例篇目', type: 'translation',
      mode: 'reciting', questionId: 'question-4', resume: 1
    }
  });
  page.moreSettings();
  assert.equal(toasts[0].title, '更多设置');
  const classicalTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/classical/index.wxml'), 'utf8');
  assert.match(classicalTemplate, /study-navbar[^>]*bind:more="moreSettings"/);
});

test('随机练习保存并恢复 source/type/articleId/mode 上下文', () => {
  const questions = [{ id: 'translation-1', source: 'classical', type: 'translation', articleId: 'article-9' }];
  let resume = null;
  let storedMode = 'writing';
  const store = {
    getMode() { return storedMode; },
    setMode(mode) { storedMode = mode; },
    getResume() { return resume; },
    saveResume(value) { resume = jsonCopy(value); },
    getState() { return { favorites: [], mastered: {} }; }
  };
  const service = {
    getQuestions({ source }) { return questions.filter((item) => item.source === source); },
    getQuestion(id) { return questions.find((item) => item.id === id); },
    decorateQuestions(rows) { return rows; }
  };
  const api = { auth: { getToken() { return ''; } } };
  const createPage = () => loadPage('pages/random/index.js', {
    '../../services/data-service': service,
    '../../utils/study-store': store,
    '../../utils/navigation': {},
    '../../services/api': api
  }, { wx: undefined });

  const firstPage = createPage();
  firstPage.onLoad({ source: 'classical', type: 'translation', articleId: 'article-9', mode: 'reciting' });
  assert.deepEqual(resume.options, {
    source: 'classical', type: 'translation', articleId: 'article-9', mode: 'reciting'
  });

  resume = {
    path: '/pages/random/index',
    options: { source: 'classical', type: 'translation', articleId: 'article-9', mode: 'reciting' },
    groupIds: ['translation-1'],
    groupIndex: 0
  };
  const restoredPage = createPage();
  restoredPage.onLoad({ source: 'classical', resume: '1' });
  assert.equal(restoredPage._type, 'translation');
  assert.equal(restoredPage._articleId, 'article-9');
  assert.equal(restoredPage.data.typeFilter, 'translation');
  assert.equal(restoredPage.data.mode, 'reciting');
  assert.deepEqual(resume.options, {
    source: 'classical', type: 'translation', articleId: 'article-9', mode: 'reciting'
  });
});

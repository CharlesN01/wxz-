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
      if (request === '../../utils/study-timer') return { withStudyTime: (definition) => definition, clock: { async settled() {} } };
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

test('10 个原生路由承载 16 个原型状态所需页面均已注册', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
  assert.deepEqual(config.pages, [
    'pages/home/index', 'pages/literature/index', 'pages/classical/index',
    'pages/practice/index', 'pages/random/index', 'pages/favorites/index', 'pages/orders/index',
    'pages/application/index', 'pages/mine/index', 'pages/resources/index'
  ]);
});

test('订单中心登记为无参数主路径并从我的订单入口直达', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
  assert.ok(config.pages.includes('pages/orders/index'));
  const mine = fs.readFileSync(path.join(root, 'miniprogram/pages/mine/index.js'), 'utf8');
  assert.match(mine, /openOrders\(\)\s*\{\s*navigation\.openPage\('\/pages\/orders\/index'\);\s*\}/);
});

test('订单中心直接进入时，未登录留在订单路径并可原地登录', async () => {
  let session = null;
  const api = {
    auth: { getSession: () => session, async login() { session = { token: 'test-session' }; } },
    orders: { async list() { return { results: [], next: null }; } }
  };
  const page = loadPage('pages/orders/index.js', { '../../services/api': api, '../../utils/order-view': { orderView: (order) => order } }, {
    wx: { showToast() {} }
  });
  await page.onShow();
  assert.equal(page.data.loggedIn, false);
  assert.equal(page.data.loading, false);
  assert.match(fs.readFileSync(path.join(root, 'miniprogram/pages/orders/index.wxml'), 'utf8'), /bindtap="login"/);
  assert.equal(page.data.detailVisible, false);
  await page.login();
  assert.equal(page.data.loggedIn, true);
  assert.equal(page.data.detailVisible, false);
});

test('订单详情有明确返回列表操作，返回后仍处于订单中心', () => {
  const page = loadPage('pages/orders/index.js', { '../../services/api': { auth: {}, orders: {} } }, { wx: {} });
  page.data.detailVisible = true;
  page.data.selectedOrder = { id: 'order-1' };
  page.backToList();
  assert.equal(page.data.detailVisible, false);
  assert.equal(page.data.selectedOrder, null);
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/orders/index.wxml'), 'utf8');
  assert.match(template, /bindtap="backToList"/);
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

test('文常随机使用原型底栏，两类随机均保留顶部自定义导航', () => {
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/random/index.wxml'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'miniprogram/pages/random/index.js'), 'utf8');
  assert.match(template, /study-navbar title="\{\{source === 'classical' \? '文言文随机测试' : '文常随机测试'\}\}"/);
  assert.match(template, /wx:if="\{\{source === 'literature'\}\}" class="bottom-nav(?: [^"]*)?"/);
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
  const homeTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/home/index.wxml'), 'utf8');
  assert.doesNotMatch(homeTemplate, /study-navbar[^>]*bind:more=/);
});

test('首页备考资料入口只打开弹窗，不再跳转资料页', () => {
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/home/index.wxml'), 'utf8');
  assert.match(template, /class="group-card"\s+bindtap="openGroupModal"/);
  assert.doesNotMatch(template, /class="group-card"[^>]*data-page="resources"/);
  assert.match(template, /class="group-action"[^>]*catchtap="openGroupModal"/);
});

test('首页红圈主文字字号按视觉要求放大，说明文字保持独立字号', () => {
  const styles = fs.readFileSync(path.join(root, 'miniprogram/pages/home/index.wxss'), 'utf8');
  assert.match(styles, /\.dashboard-head\s*\{[^}]*font-size:\s*24rpx;/);
  assert.match(styles, /\.countdown-number\s*\{[^}]*font-size:\s*64rpx;/);
  assert.match(styles, /\.module-name\s*\{[^}]*font-size:\s*26rpx;/);
  assert.match(styles, /\.module-desc\s*\{[^}]*font-size:\s*18rpx;/);
});

test('退费规则和客服联系弹窗使用已确认文案与二维码', () => {
  const script = fs.readFileSync(path.join(root, 'miniprogram/pages/mine/index.js'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/mine/index.wxml'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'miniprogram/pages/mine/index.wxss'), 'utf8');
  assert.match(script, /本产品为刷题题库（线上虚拟权限），开通后即可使用，不支持退款。使用中遇到问题，可联系客服处理。/);
  assert.match(template, /wx:if="\{\{infoKind === 'customer'\}\}" class="customer-qr"/);
  assert.match(template, /src="\/assets\/contact-qr\.jpg"/);
  assert.match(styles, /\.customer-qr\s*\{[^}]*width:\s*240px;[^}]*height:\s*240px;/s);
});

test('首页内容顺序与原型保持一致，学习趋势排在资料群之后', () => {
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/home/index.wxml'), 'utf8');
  assert.ok(template.indexOf('class="dashboard-card"') < template.indexOf('class="section-title"'));
  assert.ok(template.indexOf('class="section-title"') < template.indexOf('class="module-grid"'));
  assert.ok(template.indexOf('class="module-grid"') < template.indexOf('class="continue-card"'));
  assert.ok(template.indexOf('class="continue-card"') < template.indexOf('class="group-card"'));
  assert.ok(template.indexOf('class="group-card"') < template.indexOf('class="growth-card"'));
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
  const classicalTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/classical/index.wxml'), 'utf8');
  assert.doesNotMatch(classicalTemplate, /study-navbar[^>]*bind:more=/);
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

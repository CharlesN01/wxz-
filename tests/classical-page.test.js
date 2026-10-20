const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const pagePath = require.resolve('../miniprogram/pages/classical/index');
const storePath = require.resolve('../miniprogram/utils/study-store');
const servicePath = require.resolve('../miniprogram/services/data-service');
const navigationPath = require.resolve('../miniprogram/utils/navigation');
const session = require('../miniprogram/utils/session');

function createClassicalPage() {
  const storage = new Map();
  let definition;
  const routes = [];
  global.wx = {
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
    removeStorageSync(key) { storage.delete(key); },
    navigateTo(options) { routes.push(options.url); },
    redirectTo(options) { routes.push(options.url); },
    showToast() {},
    nextTick(callback) { callback(); }
  };
  global.getCurrentPages = () => [{}, {}];
  [storePath, servicePath, navigationPath].forEach((path) => { delete require.cache[path]; });
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require: createRequire(pagePath),
    Page(value) { definition = value; },
    wx: global.wx
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(value) { Object.assign(this.data, value); }
  };
  return { page, store: require(storePath), service: require(servicePath), routes };
}

test('文言目录返回时刷新服务端进度和访问范围，切换账号也清除旧范围', async () => {
  const { page } = createClassicalPage();
  session.saveSession({ token: 'directory-learner', expiresAt: '' });
  global.wx.request = () => {};
  page._remoteLoaded = true;
  page._contentToken = 'directory-learner';
  page.data.loading = false;
  page.data.dataSource = 'remote';
  let reloads = 0;
  page.loadRemote = async () => { reloads += 1; };
  page.onHide();
  await page.onShow();
  assert.equal(reloads, 1);
  page._needsRemoteRefresh = false;
  await page.onShow();
  assert.equal(reloads, 1);
  session.clearSession();
  await page.onShow();
  assert.equal(reloads, 2);
});

test('目录专项入口透传当前背诵模式', () => {
  const { page, routes } = createClassicalPage();
  page.data.mode = 'reciting';
  page.selectedArticle = { id: 'quanxue', title: '劝学' };
  page.data.selectedArticle = page.selectedArticle;
  page.data.modalVisible = true;
  page.onChooseType({ currentTarget: { dataset: { type: 'translation' } } });
  assert.deepEqual(routes, ['/pages/practice/index?articleId=quanxue&articleTitle=%E5%8A%9D%E5%AD%A6&type=translation&mode=reciting']);
});

test('没有题目的篇目保持未学状态，不因 0/0 被标为已学', () => {
  const { page } = createClassicalPage();
  page.onShow();
  const article = page.articles.find((item) => item.id === 'guaren');
  assert.equal(article.total, 0);
  assert.equal(article.status, 'unlearned');
  assert.equal(article.statusLabel, '未学');
});

test('目录顶部专项卡先开原型选择弹窗，确认后进入不限定篇目的题型', () => {
  const { page, routes } = createClassicalPage();
  page.data.mode = 'writing';
  page.onSpecialty({ currentTarget: { dataset: { type: 'translation' } } });
  assert.equal(page.data.modalVisible, true);
  assert.equal(page.data.selectedArticle.title, '重点翻译');
  page.onChooseType({ currentTarget: { dataset: { type: 'word' } } });
  assert.deepEqual(routes, ['/pages/practice/index?type=word&mode=writing']);
});

test('目录续学在字词翻译全掌握后回到可练习篇目，跳过只有常识题的师说', () => {
  const { page, store, service, routes } = createClassicalPage();
  service.getQuestions({ articleId: 'quanxue' }).forEach((question) => store.toggleMastered(question.id));
  assert.equal(service.getQuestions({ articleId: 'shishuo', type: 'fact' }).length, 1);
  assert.equal(service.getQuestions({ articleId: 'shishuo', type: 'word' }).length, 0);
  assert.equal(service.getQuestions({ articleId: 'shishuo', type: 'translation' }).length, 0);
  page.onShow();
  page.onContinue();
  assert.deepEqual(routes, ['/pages/practice/index?articleId=quanxue&articleTitle=%E5%8A%9D%E5%AD%A6&type=word']);
});

test('目录续学在字词已掌握而翻译未掌握时进入翻译练习', () => {
  const { page, store, service, routes } = createClassicalPage();
  service.getQuestions({ articleId: 'quanxue', type: 'word' }).forEach((question) => store.toggleMastered(question.id));
  store.saveResume({ path: '/pages/literature/index', options: { categoryId: 'pre-qin' }, groupIds: [], groupIndex: 0 });
  page.onShow();
  page.onContinue();
  assert.deepEqual(routes, ['/pages/practice/index?articleId=quanxue&articleTitle=%E5%8A%9D%E5%AD%A6&type=translation']);
});

test('目录续学优先恢复已有练习断点，保留其题型及题序', () => {
  const { page, store, service, routes } = createClassicalPage();
  const words = service.getQuestions({ articleId: 'quanxue', type: 'word' });
  words.forEach((question) => store.toggleMastered(question.id));
  const resume = {
    path: '/pages/practice/index',
    options: { articleId: 'quanxue', type: 'word' },
    groupIds: words.map((question) => question.id).reverse(),
    groupIndex: 0
  };
  store.saveResume(resume);
  page.onShow();
  page.onContinue();
  assert.deepEqual(routes, ['/pages/practice/index?articleId=quanxue&type=word&resume=1']);
  assert.deepEqual(store.getResume(), resume);
});

test('目录远端续学按服务端掌握状态选题，不读取本地演示断点', () => {
  const { page, store, routes } = createClassicalPage();
  store.saveResume({ path: '/pages/practice/index', options: { articleId: 'quanxue', type: 'word' }, groupIds: [], groupIndex: 0 });
  page.data.dataSource = 'remote';
  page.data.mode = 'reciting';
  page.articles = [
    { id: 'remote-a', title: '远端篇一', total: 2, status: 'learning', nextQuestion: { id: 'remote-q2', type: 'translation' } },
    { id: 'remote-b', title: '远端篇二', total: 1, status: 'unlearned', nextQuestion: { id: 'remote-q3', type: 'word' } }
  ];
  page.onContinue();
  assert.deepEqual(routes, ['/pages/practice/index?articleId=remote-a&articleTitle=%E8%BF%9C%E7%AB%AF%E7%AF%87%E4%B8%80&type=translation&mode=reciting&questionId=remote-q2&resume=1']);
});

test('文言目录聚合进度携带 Bearer，大题库也不读取题目和逐题状态', async () => {
  const { page } = createClassicalPage();
  session.saveSession({ token: 'activated-token', expiresAt: '' });
  const calls = [];
  global.wx.request = (options) => {
    calls.push(options);
    assert.ok(options.url.includes('/articles/'));
    options.success({ statusCode: 200, data: {
      count: 1,
      next: null,
      previous: null,
      results: [{ id: 'remote-a', title: '远端篇一', publishedCount: 1999, wordCount: 1005, translationCount: 994,
        progress: { masteredCount: 120, nextQuestion: { id: 'remote-q1', type: 'word' } } }]
    }, header: {} });
  };
  await page.loadRemote();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].header.Authorization, 'Bearer activated-token');
  assert.equal(page.data.visibleCount, 1);
  assert.equal(page.data.visibleArticles[0].completed, 120);
  assert.equal(page.data.visibleArticles[0].status, 'learning');
  assert.equal(page.data.visibleArticles[0].total, 1999);
});

test('文言目录先显示首批篇目，再加载后续分页，onLoad/onShow 共用进行中的请求', async () => {
  const { page } = createClassicalPage();
  session.saveSession({ token: 'directory-token', expiresAt: '' });
  const requests = [];
  global.wx.request = (options) => { requests.push(options); };
  page.onLoad();
  const loading = page.onShow();
  assert.equal(requests.length, 1);
  requests[0].success({ statusCode: 200, header: {}, data: {
    count: 2, next: '/api/student/v1/articles/?page=2', previous: null,
    results: [{ id: 'a', title: '首篇', publishedCount: 2000, wordCount: 2, translationCount: 0,
      progress: { masteredCount: 2, nextQuestion: { id: 'q1', type: 'word' } } }]
  } });
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.visibleArticles[0].title, '首篇');
  assert.equal(page.data.visibleArticles[0].total, 2);
  assert.equal(page.data.visibleArticles[0].status, 'learned');
  assert.equal(page.data.articleTotal, 2);
  requests[1].success({ statusCode: 200, header: {}, data: {
    count: 2, next: null, previous: '/api/student/v1/articles/?page=1',
    results: [{ id: 'b', title: '次篇', publishedCount: 1, wordCount: 0, translationCount: 1,
      progress: { masteredCount: 0, nextQuestion: { id: 'q2', type: 'translation' } } }]
  } });
  await loading;
  assert.equal(page.data.visibleCount, 2);
  assert.equal(page.data.learnedCount, 1);
  assert.equal(page.data.completionPercent, 50);
  assert.ok(requests.every((request) => /\/articles\//.test(request.url)));
});

test('文言目录后续分页失败保留已显示篇目和重试入口', async () => {
  const { page } = createClassicalPage();
  let calls = 0;
  global.wx.request = (options) => {
    calls += 1;
    options.success({ statusCode: calls === 1 ? 200 : 503, header: {}, data: calls === 1 ? {
      count: 2, next: '/api/student/v1/articles/?page=2', previous: null,
      results: [{ id: 'a', title: '首篇', publishedCount: 1, wordCount: 1, translationCount: 0, progress: null }]
    } : { error: { code: 'SERVICE_UNAVAILABLE', message: '稍后重试' } } });
  };
  await page.loadRemote();
  assert.equal(calls, 2);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.hasError, true);
  assert.equal(page.data.visibleCount, 1);
  assert.equal(page.data.visibleArticles[0].title, '首篇');
});

test('目录续学跳过已掌握篇目并使用后端可访问续学题，不再扫描题库', async () => {
  const { page, routes } = createClassicalPage();
  session.saveSession({ token: 'directory-token', expiresAt: '' });
  global.wx.request = () => { assert.fail('续学题已在目录返回，不应发题目或状态请求'); };
  page.data.loading = false;
  page.data.dataSource = 'remote';
  page.articles = [
    { id: 'a', title: '首篇', total: 20, status: 'learned', nextQuestion: { id: 'q1', type: 'word' } },
    { id: 'b', title: '次篇', total: 20, status: 'learning', nextQuestion: { id: 'q2', type: 'translation' } }
  ];
  await page.onContinue();
  assert.deepEqual(routes, ['/pages/practice/index?articleId=b&articleTitle=%E6%AC%A1%E7%AF%87&type=translation&questionId=q2&resume=1']);
});

test('游客续学只按需读取一个目标篇目首题，忽略其他篇目的总题量', async () => {
  const { page, routes } = createClassicalPage();
  const requests = [];
  global.wx.request = (options) => {
    requests.push(options);
    options.success({ statusCode: 200, header: {}, data: {
      count: 1, next: null, previous: null,
      results: [{ id: 'q1', type: 'word', articleId: 'a' }]
    } });
  };
  page.data.loading = false;
  page.data.dataSource = 'remote';
  page.articles = [
    { id: 'a', title: '首篇', total: 1, wordCount: 1, translationCount: 0, status: 'unlearned', nextQuestion: null },
    { id: 'b', title: '次篇', total: 5000, wordCount: 5000, translationCount: 0, status: 'unlearned', nextQuestion: null }
  ];
  await page.onContinue();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].data.articleId, 'a');
  assert.equal(requests[0].header.Authorization, undefined);
  assert.deepEqual(routes, ['/pages/practice/index?articleId=a&articleTitle=%E9%A6%96%E7%AF%87&type=word&questionId=q1&resume=1']);
});

test('切换账号时旧目录响应不会覆盖新账号数据', async () => {
  const { page } = createClassicalPage();
  session.saveSession({ token: 'account-a', expiresAt: '' });
  const requests = [];
  global.wx.request = (options) => { requests.push(options); };
  const oldLoading = page.loadRemote();
  session.saveSession({ token: 'account-b', expiresAt: '' });
  const newLoading = page.onShow();
  assert.equal(requests.length, 2);
  requests[1].success({ statusCode: 200, header: {}, data: {
    count: 1, next: null, previous: null,
    results: [{ id: 'b', title: '新账号篇目', publishedCount: 1, wordCount: 1, translationCount: 0,
      progress: { masteredCount: 0, nextQuestion: { id: 'q2', type: 'word' } } }]
  } });
  await newLoading;
  requests[0].success({ statusCode: 200, header: {}, data: {
    count: 1, next: null, previous: null,
    results: [{ id: 'a', title: '旧账号篇目', publishedCount: 1, wordCount: 1, translationCount: 0,
      progress: { masteredCount: 1, nextQuestion: { id: 'q1', type: 'word' } } }]
  } });
  await oldLoading;
  assert.equal(page.data.visibleArticles[0].title, '新账号篇目');
  assert.equal(page.data.visibleArticles[0].completed, 0);
});

test('卸载目录后忽略进行中的分页结果并停止后续请求', async () => {
  const { page } = createClassicalPage();
  const requests = [];
  global.wx.request = (options) => { requests.push(options); };
  const loading = page.loadRemote();
  requests[0].success({ statusCode: 200, header: {}, data: {
    count: 3, next: '/api/student/v1/articles/?page=2', previous: null,
    results: [{ id: 'a', title: '首篇', publishedCount: 1, wordCount: 1, translationCount: 0, progress: null }]
  } });
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.equal(page.data.visibleCount, 1);
  page.onUnload();
  requests[1].success({ statusCode: 200, header: {}, data: {
    count: 3, next: '/api/student/v1/articles/?page=3', previous: '/api/student/v1/articles/?page=1',
    results: [{ id: 'b', title: '卸载后不显示', publishedCount: 1, wordCount: 1, translationCount: 0, progress: null }]
  } });
  await loading;
  assert.equal(requests.length, 2);
  assert.equal(page.data.visibleCount, 1);
  assert.equal(page.data.visibleArticles[0].title, '首篇');
});

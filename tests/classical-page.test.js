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
  let storage;
  let definition;
  const routes = [];
  global.wx = {
    getStorageSync() { return storage; },
    setStorageSync(_key, value) { storage = JSON.parse(JSON.stringify(value)); },
    removeStorageSync() { storage = null; },
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

test('文言目录返回时重新加载开通前受限的题目，切换账号也清除旧范围', async () => {
  const { page } = createClassicalPage();
  session.saveSession({ token: 'directory-learner', expiresAt: '' });
  global.wx.request = () => {};
  page._remoteLoaded = true;
  page._contentToken = 'directory-learner';
  page._restrictedCount = 8;
  page.data.loading = false;
  page.data.dataSource = 'remote';
  let reloads = 0;
  page.loadRemote = async () => { reloads += 1; };
  await page.onShow();
  assert.equal(reloads, 1);
  page._restrictedCount = 0;
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
    { id: 'remote-a', title: '远端篇一' },
    { id: 'remote-b', title: '远端篇二' }
  ];
  page._remoteQuestions = [
    { id: 'remote-q1', articleId: 'remote-a', type: 'word', mastered: true },
    { id: 'remote-q2', articleId: 'remote-a', type: 'translation', mastered: false },
    { id: 'remote-q3', articleId: 'remote-b', type: 'word', mastered: false }
  ];
  page.onContinue();
  assert.deepEqual(routes, ['/pages/practice/index?articleId=remote-a&articleTitle=%E8%BF%9C%E7%AB%AF%E7%AF%87%E4%B8%80&type=translation&mode=reciting&questionId=remote-q2&resume=1']);
});

test('文言目录首个题目分页请求在已有会话时携带 Bearer 认证', async () => {
  const { page } = createClassicalPage();
  session.saveSession({ token: 'activated-token', expiresAt: '' });
  const calls = [];
  global.wx.request = (options) => {
    calls.push(options);
    if (options.url.includes('/me/questions/')) {
      options.success({ statusCode: 200, data: { questionId: 'remote-q1', favorite: false, mastered: true, version: 1 }, header: {} });
      return;
    }
    options.success({ statusCode: 200, data: {
      count: 1,
      next: null,
      previous: null,
      results: [{ id: 'remote-q1', source: 'classical', categoryId: null, articleId: 'remote-a', type: 'word', tag: '字词', stem: '题干', answers: ['答案'], sortOrder: 1, revision: 1 }],
      access: { activated: true, pageSize: 20, freeCount: 1, totalCount: 1, restrictedCount: 0 }
    }, header: {} });
  };
  await page.loadArticleStates([{ id: 'remote-a', title: '远端篇一' }]);
  assert.equal(calls[0].header.Authorization, 'Bearer activated-token');
});

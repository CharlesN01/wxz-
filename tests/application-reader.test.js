const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { genreOf, genresFrom, readingContent } = require('../miniprogram/pages/application/reader');

function pageWith(api, runtime = {}) {
  const filename = path.join(__dirname, '../miniprogram/pages/application/index.js');
  const localRequire = createRequire(filename);
  let definition;
  let canStudy;
  const routes = [];
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      if (name === '../../utils/study-timer') return { withStudyTime(value, ready) { canStudy = ready; return value; } };
      if (name === '../../services/api') return api;
      if (name === '../../utils/navigation') return { openPage(route) { routes.push(route); } };
      return localRequire(name);
    },
    Page(value) { definition = value; }, wx: runtime
  });
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(value) { Object.assign(this.data, value); } };
  return { page, routes, ready: () => canStudy(page) };
}
const event = (dataset) => ({ currentTarget: { dataset } });
const entry = (id, genre = 'notice') => ({ id, genreId: genre, genreName: genre === 'notice' ? '通知' : '总结', categoryId: 'affairs', categoryName: '事务文书', kind: 'template', title: id, body: `${id}正文` });

test('真实正文仅按明确章节拆分，保留全文且不编造缺失要点', () => {
  const value = readingContent({ body: '【写作样例】\n标题：通知\n正文内容\n写作要点：\n标题准确\n时间地点清楚\n题目要求：请拟写通知。', kind: 'template' });
  assert.equal(value.sample, '标题：通知\n正文内容');
  assert.deepEqual(value.points, ['标题准确', '时间地点清楚']);
  assert.equal(value.requirement, '请拟写通知。');
  assert.match(value.original, /写作要点/);
  assert.deepEqual(readingContent({ body: '写作要点是行文的重要内容，不是章节标题。' }).points, []);
  assert.equal(readingContent({ body: '正文只有范文' }).sample, '正文只有范文');
});

test('专项练习将真实题目和参考答案分区，文种缺失兼容实际分类', () => {
  const value = readingContent({ kind: 'exercise', body: '写一封申请书', referenceAnswer: '申请书\n尊敬的老师：' });
  assert.equal(value.requirement, '写一封申请书');
  assert.equal(value.sample, '申请书\n尊敬的老师：');
  assert.deepEqual(genresFrom([entry('a'), entry('b'), entry('c', 'summary')]).map((item) => item.name), ['通知', '总结']);
  assert.deepEqual(genreOf({ categoryId: 'old', categoryName: '旧分类' }), { id: 'category:old', name: '旧分类' });
});

test('全部与真实文种分页工作正常，模式切换不再请求详情', async () => {
  const entries = [entry('a'), entry('b'), entry('c', 'summary')];
  const details = [];
  const { page, ready } = pageWith({ content: {
    writings: async () => ({ results: entries, access: { restrictedCount: 2 } }),
    writing: async (id) => { details.push(id); return entries.find((item) => item.id === id); }
  } });
  await page.onLoad();
  assert.equal(page.data.detailItems.length, 3);
  assert.equal(page.data.restrictedCount, 2);
  assert.equal(ready(), true);
  await page.chooseGenre(event({ id: 'genre:notice' }));
  assert.equal(page.data.detailItems.length, 2);
  await page.changePage(event({ direction: 1 }));
  assert.equal(page.data.selected.id, 'b');
  await page.changePage(event({ direction: 1 }));
  assert.equal(page.data.selectedIndex, 1);
  const before = details.length;
  page.changeMode(event({ mode: 'points' }));
  assert.equal(page.data.mode, 'points');
  assert.equal(details.length, before);
  assert.equal(ready(), false, '缺少要点的提示页不计为有效学习时间');
  page.toggleOriginal();
  assert.equal(ready(), true, '展开可读原文后恢复计时');
  await page.chooseGenre(event({ id: '' }));
  assert.equal(page.data.detailItems.length, 3);
  assert.equal(page.data.selectedIndex, 0);
});

test('快速翻篇后的晚到详情及错误不会覆盖当前正文', async () => {
  const pending = {};
  const entries = [entry('a'), entry('b')];
  const { page } = pageWith({ content: { writing: (id) => new Promise((resolve, reject) => { pending[id] = { resolve, reject }; }) } });
  page.data.items = entries;
  page.data.detailItems = entries;
  const first = page.loadDetail(entries[0]);
  const second = page.changePage(event({ direction: 1 }));
  pending.b.resolve(entries[1]);
  await second;
  pending.a.reject(new Error('旧请求失败'));
  await first;
  assert.equal(page.data.selected.id, 'b');
  assert.equal(page.data.reader.sample, 'b正文');
  assert.equal(page.data.detailError, '');
});

test('详情失败停止计时并支持重试，无权空列表保留权益数量', async () => {
  let fails = true;
  const item = entry('a');
  const { page, ready, routes } = pageWith({ content: {
    writings: async () => ({ results: [item] }),
    writing: async () => { if (fails) throw new Error('需要登录'); return item; }
  } });
  await page.load();
  assert.equal(ready(), false);
  assert.equal(page.data.reader, null);
  fails = false;
  await page.retryDetail();
  assert.equal(ready(), true);
  page.openMembership();
  assert.deepEqual(routes, ['/pages/mine/index']);
  await page.onShow();
  assert.equal(page._refreshOnShow, false);
  const empty = pageWith({ content: { writings: async () => ({ results: [], access: { restrictedCount: 6 } }) } });
  await empty.page.load();
  assert.equal(empty.page.data.restrictedCount, 6);
  assert.equal(empty.ready(), false);
});

test('主题恢复与切换只保存主题，存储失败不阻断阅读', async () => {
  const saved = [];
  const { page } = pageWith({ content: { writings: async () => ({ results: [] }) } }, {
    getStorageSync: () => 'warm', setStorageSync: (...args) => saved.push(args)
  });
  await page.onLoad();
  assert.equal(page.data.theme, 'warm');
  page.changeTheme(event({ theme: 'blue' }));
  assert.deepEqual(saved, [['application-reader-theme', 'blue']]);
  page.changeTheme(event({ theme: 'unknown' }));
  assert.equal(page.data.theme, 'blue');
});

test('离页即清除正文，切换无权益账号回页不会恢复上一账号内容', async () => {
  let paid = true;
  let resolveLate;
  const item = entry('paid-only');
  const { page, ready } = pageWith({ content: {
    writings: async () => paid ? { results: [item] } : { results: [], access: { restrictedCount: 4 } },
    writing: async () => item
  } });
  await page.load();
  assert.equal(page.data.selected.id, 'paid-only');
  const late = new Promise((resolve) => { resolveLate = resolve; });
  const loadWritings = page.loadWritings;
  page.loadWritings = () => late;
  const obsolete = page.load();
  page.onHide();
  assert.equal(page.data.selected, null);
  assert.equal(page.data.reader, null);
  assert.equal(page.data.items.length, 0);
  assert.equal(ready(), false);
  resolveLate({ entries: [item], access: {} });
  await obsolete;
  assert.equal(page.data.items.length, 0, '离页前旧账号的晚到列表不再更新页面');
  page.loadWritings = loadWritings;
  paid = false;
  await page.onShow();
  assert.equal(page.data.selected, null);
  assert.equal(page.data.items.length, 0);
  assert.equal(page.data.restrictedCount, 4);
});

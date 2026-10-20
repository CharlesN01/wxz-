const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { learningTrend, minutes } = require('../miniprogram/utils/learning-trend');

const homeFile = path.join(__dirname, '../miniprogram/pages/home/index.js');
const templateFile = path.join(__dirname, '../miniprogram/pages/home/index.wxml');

function copy(value) { return JSON.parse(JSON.stringify(value)); }

function createHome(options = {}) {
  const calls = { timerSettled: 0, statistics: 0, resume: 0, resource: 0, preview: [], toast: [] };
  let token = options.token === undefined ? 'test-session' : options.token;
  let statistics = options.statistics || {};
  let statisticsError = options.statisticsError;
  let resource = options.resource || { enabled: false };
  let resourceError = options.resourceError;
  const api = {
    auth: { getToken: () => token },
    learning: {
      statistics() { calls.statistics += 1; return statisticsError ? Promise.reject(statisticsError) : Promise.resolve(statistics); },
      resume() { calls.resume += 1; return Promise.resolve({ valid: false, start: null }); }
    },
    resources: {
      group() { calls.resource += 1; return resourceError ? Promise.reject(resourceError) : Promise.resolve(resource); }
    }
  };
  const localRequire = createRequire(homeFile);
  let definition;
  vm.runInNewContext(fs.readFileSync(homeFile, 'utf8'), {
    require(name) {
      if (name === '../../services/api') return api;
      if (name === '../../utils/navigation') return { openPage() {} };
      if (name === '../../utils/study-timer') return { clock: { async settled() { calls.timerSettled += 1; } } };
      return localRequire(name);
    },
    Page(value) { definition = value; },
    wx: {
      previewImage(value) { calls.preview.push(copy(value)); },
      showToast(value) { calls.toast.push(copy(value)); }
    }
  }, { filename: homeFile });
  const page = { ...definition, data: copy(definition.data), setData(update) { Object.assign(this.data, update); } };
  return {
    page, calls,
    setToken(value) { token = value; },
    setStatistics(value, error) { statistics = value; statisticsError = error; },
    setResource(value, error) { resource = value; resourceError = error; }
  };
}

function trendDays(values) {
  return values.map((studySeconds, index) => ({ date: '2026-10-' + String(14 + index).padStart(2, '0'), studySeconds, isToday: index === values.length - 1 }));
}

test('首页30秒显示0.5分钟，题数和累计学习天数不能充当分钟或连续天数', async () => {
  const { page, calls } = createHome({ statistics: {
    todayStudySeconds: 30, todayQuestions: 18, consecutiveStudyDays: 2, studyDays: 90,
    dailyTarget: 20, dailyTrend: trendDays([0, 0, 0, 0, 0, 0, 30]), previousPeriodStudySeconds: 0
  } });
  await page.loadPersonalData();
  assert.equal(page.data.stats.todayMinutes, 0.5);
  assert.equal(page.data.stats.todayCount, 18);
  assert.equal(page.data.stats.studyDays, 2);
  assert.equal(page.data.todayPercent, 90);
  assert.equal(page.data.statsReady, true);
  assert.equal(calls.timerSettled, 1);
  assert.equal(minutes(30), 0.5);
  const template = fs.readFileSync(templateFile, 'utf8');
  assert.match(template, /statsReady \? stats\.todayMinutes : '--'/);
  assert.match(template, /连续学习 \/ 天/);
});

test('统计缺少真实时长和连续天数时保持零，不回退到答题数或累计天数', async () => {
  const { page } = createHome({ statistics: { todayQuestions: 100, studyDays: 99 } });
  await page.loadPersonalData();
  assert.equal(page.data.stats.todayMinutes, 0);
  assert.equal(page.data.stats.studyDays, 0);
  assert.equal(page.data.stats.todayCount, 100);
});

test('趋势柱只来自dailyTrend的真实秒数，保留日期和今日标识且不修改接口数据', () => {
  const statistics = { dailyTrend: trendDays([0, 30, 60, 90, 120, 150, 180]), previousPeriodStudySeconds: 315 };
  const original = copy(statistics);
  const result = learningTrend(statistics);
  assert.equal(result.trendBars.length, 7);
  assert.deepEqual(result.trendBars.map((bar) => bar.minutes), [0, 0.5, 1, 1.5, 2, 2.5, 3]);
  assert.equal(result.trendBars[0].height, 0);
  assert.equal(result.trendBars[6].height, 32);
  assert.equal(result.trendBars[6].date, '2026-10-20');
  assert.equal(result.trendBars[6].label, '10/20');
  assert.equal(result.trendBars[6].active, true);
  assert.equal(result.trendHint, '较前 7 天 +100%');
  assert.equal(result.trendHasData, true);
  assert.deepEqual(statistics, original);
});

test('前7天比较展示增长下降或持平，没有对照期不编造增长百分比', () => {
  const dailyTrend = trendDays([0, 0, 0, 0, 0, 0, 60]);
  assert.equal(learningTrend({ dailyTrend, previousPeriodStudySeconds: 120 }).trendHint, '较前 7 天 -50%');
  assert.equal(learningTrend({ dailyTrend, previousPeriodStudySeconds: 60 }).trendHint, '与前 7 天持平');
  assert.equal(learningTrend({ dailyTrend, previousPeriodStudySeconds: 0 }).trendHint, '近 7 天共 1 分钟');
  assert.equal(learningTrend({ dailyTrend }).trendHint, '近 7 天共 1 分钟');
});

test('全零和无数据趋势不生成示例柱高或虚假成绩', () => {
  const empty = learningTrend({ dailyTrend: trendDays([0, 0, 0, 0, 0, 0, 0]), previousPeriodStudySeconds: 0 });
  assert.equal(empty.trendHasData, false);
  assert.equal(empty.trendHint, '近 7 天暂无学习时长');
  assert.ok(empty.trendBars.every((bar) => bar.height === 0 && bar.minutes === 0));
  const missing = learningTrend({});
  assert.deepEqual(missing.trendBars, []);
  assert.equal(missing.trendHasData, false);
  assert.equal(missing.trendHint, '近 7 天暂无学习时长');
});

test('退出登录清除旧统计与趋势，不调用统计接口或学习计时器', async () => {
  const { page, calls } = createHome({ token: '' });
  page.setData({ statsReady: true, stats: { studyDays: 9, todayMinutes: 8 }, trendBars: [{ height: 44 }], trendHasData: true, trendHint: '+66%' });
  await page.loadPersonalData();
  assert.equal(page.data.isGuest, true);
  assert.equal(page.data.statsReady, false);
  assert.equal(page.data.stats.todayMinutes, 0);
  assert.equal(page.data.stats.studyDays, 0);
  assert.deepEqual(copy(page.data.trendBars), []);
  assert.equal(page.data.trendHasData, false);
  assert.equal(page.data.trendHint, '登录后查看学习趋势');
  assert.equal(calls.timerSettled, 0);
  assert.equal(calls.statistics, 0);
  assert.equal(calls.resume, 0);
});

test('统计失败清除旧趋势并显示失败提示，不保留伪造的趋势柱', async () => {
  const fixture = createHome({ statistics: { todayStudySeconds: 30, dailyTrend: trendDays([0, 0, 0, 0, 0, 0, 30]) } });
  await fixture.page.loadPersonalData();
  assert.equal(fixture.page.data.trendHasData, true);
  fixture.setStatistics(null, { code: 'NETWORK_ERROR' });
  await fixture.page.loadPersonalData();
  assert.equal(fixture.page.data.statsReady, false);
  assert.deepEqual(copy(fixture.page.data.trendBars), []);
  assert.equal(fixture.page.data.trendHasData, false);
  assert.equal(fixture.page.data.trendHint, '学习趋势暂不可用，请重试');
  assert.match(fixture.page.data.personalError, /网络暂不可用/);
  assert.equal(fixture.page.data.growthHint, '学习统计暂不可用');
});

test('首页二维码相对URL规范为HTTPS，加载成功和失败状态真实可见', async () => {
  const { page, calls } = createHome({ token: '', resource: { enabled: true, groupQrCode: '/media/resources/group/test.png' } });
  await page.loadGroupResource();
  assert.equal(page.data.groupQrCode, 'https://zsbzy.com/media/resources/group/test.png');
  assert.equal(page.data.groupQrLoading, true);
  page.onGroupQrLoad({ currentTarget: { dataset: { src: page.data.groupQrCode } } });
  assert.equal(page.data.groupQrLoading, false);
  assert.equal(page.data.groupQrError, '');
  page.previewGroupQr();
  assert.equal(calls.preview[0].urls[0], page.data.groupQrCode);
  page.onGroupQrError({ currentTarget: { dataset: { src: page.data.groupQrCode } } });
  assert.equal(page.data.groupQrLoading, false);
  assert.match(page.data.groupQrError, /加载失败.*重试/);
  const template = fs.readFileSync(templateFile, 'utf8');
  assert.match(template, /bindload="onGroupQrLoad" binderror="onGroupQrError"/);
  assert.match(template, /wx:if="\{\{groupQrError\}\}"[^>]*bindtap="retryGroupQr"/);
  assert.match(template, /wx:if="\{\{groupQrLoading\}\}"/);
});

test('二维码重试重新取配置并刷新src，旧图片回调不覆盖当前加载状态', async () => {
  const fixture = createHome({ resource: { enabled: true, groupQrCode: 'http://zsbzy.com/media/resources/group/old.png' } });
  await fixture.page.loadGroupResource();
  assert.equal(fixture.page.data.groupQrCode, 'https://zsbzy.com/media/resources/group/old.png');
  const oldUrl = fixture.page.data.groupQrCode;
  fixture.page.onGroupQrError({ currentTarget: { dataset: { src: oldUrl } } });
  fixture.setResource({ enabled: true, groupQrCode: '/media/resources/group/new.png' });
  await fixture.page.retryGroupQr();
  assert.equal(fixture.calls.resource, 2);
  assert.match(fixture.page.data.groupQrCode, /^https:\/\/zsbzy\.com\/media\/resources\/group\/new\.png\?qr_retry=/);
  assert.equal(fixture.page.data.groupQrLoading, true);
  assert.equal(fixture.page.data.groupQrError, '');
  fixture.page.onGroupQrError({ currentTarget: { dataset: { src: oldUrl } } });
  assert.equal(fixture.page.data.groupQrLoading, true);
  assert.equal(fixture.page.data.groupQrError, '');
});

test('资料群关闭清除二维码，接口失败有明确错误，未配置无法预览', async () => {
  const fixture = createHome({ resource: { enabled: true, groupQrCode: '/media/old.png' } });
  await fixture.page.loadGroupResource();
  fixture.setResource({ enabled: false, groupQrCode: '/media/old.png' });
  await fixture.page.loadGroupResource();
  assert.equal(fixture.page.data.groupQrCode, '');
  assert.equal(fixture.page.data.groupQrLoading, false);
  fixture.page.previewGroupQr();
  assert.equal(fixture.calls.preview.length, 0);
  assert.equal(fixture.calls.toast[0].title, '二维码暂未配置');
  fixture.setResource(null, { code: 'NETWORK_ERROR' });
  await fixture.page.loadGroupResource();
  assert.match(fixture.page.data.groupResourceError, /网络暂不可用/);
});

test('二维码重试时配置接口失败保留图片错误，不把旧图片伪装成重新加载', async () => {
  const fixture = createHome({ resource: { enabled: true, groupQrCode: '/media/resources/group/failed.png' } });
  await fixture.page.loadGroupResource();
  const failedUrl = fixture.page.data.groupQrCode;
  fixture.page.onGroupQrError({ currentTarget: { dataset: { src: failedUrl } } });
  const imageError = fixture.page.data.groupQrError;
  fixture.setResource(null, { code: 'NETWORK_ERROR' });
  await fixture.page.retryGroupQr();
  assert.equal(fixture.page.data.groupQrCode, failedUrl);
  assert.equal(fixture.page.data.groupQrLoading, false);
  assert.equal(fixture.page.data.groupQrError, imageError);
  assert.match(fixture.page.data.groupResourceError, /网络暂不可用/);
});

test('已配置但不可访问的二维码地址显示配置错误，重试不会清除错误或留下白框', async () => {
  const fixture = createHome({ resource: { enabled: true, groupQrCode: 'http://localhost:8000/media/resources/group/qr.png' } });
  await fixture.page.loadGroupResource();
  assert.equal(fixture.page.data.groupQrCode, '');
  assert.equal(fixture.page.data.groupQrLoading, false);
  assert.match(fixture.page.data.groupQrError, /地址不可用.*管理员/);
  await fixture.page.retryGroupQr();
  assert.equal(fixture.page.data.groupQrCode, '');
  assert.equal(fixture.page.data.groupQrLoading, false);
  assert.match(fixture.page.data.groupQrError, /地址不可用.*管理员/);
  assert.equal(fixture.calls.preview.length, 0);
});

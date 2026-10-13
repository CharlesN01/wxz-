const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const automator = require('miniprogram-automator');
const output = path.join(__dirname, '../.devtools/automation/screenshots');
const reportPath = path.join(__dirname, '../.devtools/automation/result.json');
const STORAGE_KEY = 'chinese-study.frontend.v1';
const report = {
  checkedAt: new Date().toISOString(),
  endpoint: process.env.WX_AUTOMATION_ENDPOINT || 'ws://127.0.0.1:9420',
  screenshots: [],
  scenarios: [],
  exceptions: [],
  runtime: null
};
let mini;
let original;
let loadedOriginal = false;
const STEP_TIMEOUT = Number(process.env.WX_AUTOMATION_STEP_TIMEOUT || 12000);
const AUTOMATION_ENDPOINT = process.env.WX_AUTOMATION_ENDPOINT || 'ws://127.0.0.1:9420';

function withTimeout(promise, label, timeout = STEP_TIMEOUT) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${timeout}ms）`)), timeout);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function capture(name) {
  await new Promise((resolve) => setTimeout(resolve, 350));
  await withTimeout(
    mini.screenshot({ path: path.join(output, `${name}.png`) }),
    `截图 ${name}`
  );
  report.screenshots.push(`${name}.png`);
  console.log(`Screenshot: ${name}`);
}

async function navigate(url) {
  const page = await withTimeout(mini.reLaunch(url), `路由 ${url}`);
  assert.ok(page, `Page not available: ${url}`);
  await withTimeout(page.waitFor(250), `等待路由 ${url}`);
  return page;
}

async function tap(page, selector, inside) {
  let element = await withTimeout(page.$(selector), `查找元素 ${selector}`);
  assert.ok(element, `Element missing: ${selector}`);
  if (inside) element = await withTimeout(element.$(inside), `查找子元素 ${inside}`);
  assert.ok(element, `Inner element missing: ${inside}`);
  await withTimeout(element.tap(), `点击 ${selector}${inside || ''}`);
  await withTimeout(page.waitFor(200), `点击后等待 ${selector}`);
}

async function readData(page, key) {
  return withTimeout(page.data(key), `读取页面数据 ${key}`);
}

async function readElementData(element, key) {
  return withTimeout(element.data(key), `读取组件数据 ${key}`);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  console.log('Connecting to the existing developer-tool automation service...');
  mini = await withTimeout(
    automator.connect({ wsEndpoint: AUTOMATION_ENDPOINT }),
    `连接开发者工具 ${AUTOMATION_ENDPOINT}`
  );
  mini.on('exception', (error) => report.exceptions.push(error));
  const info = await withTimeout(mini.systemInfo(), '读取模拟器信息');
  report.runtime = { model: info.model, windowWidth: info.windowWidth, windowHeight: info.windowHeight, SDKVersion: info.SDKVersion, platform: info.platform };
  console.log(`Connected: ${info.model}, ${info.windowWidth}×${info.windowHeight}, SDK ${info.SDKVersion}`);
  original = await withTimeout(mini.callWxMethod('getStorageSync', STORAGE_KEY), '读取本地存储');
  loadedOriginal = true;

  let page = await navigate('/pages/home/index');
  const initialStats = await readData(page, 'stats');
  assert.equal(typeof initialStats.totalQuestions, 'number');
  await capture('01-首页');

  // 使用真实组件点击检查 WXML 事件绑定，不只调用页面方法。
  page = await navigate('/pages/literature/index');
  assert.equal((await readData(page, 'questions')).length, 5);
  await capture('02-文学常识-默写');
  const questionId = (await readData(page, 'questions'))[0].id;
  const wasFavorite = (await readData(page, 'questions'))[0].favorite;
  await tap(page, 'question-card', '.star-hit');
  assert.equal((await readData(page, 'questions'))[0].favorite, !wasFavorite);
  const wasMastered = (await readData(page, 'questions'))[0].mastered;
  await tap(page, 'question-card', '.master');
  assert.equal((await readData(page, 'questions'))[0].mastered, !wasMastered);
  await tap(page, 'mode-switch', '[data-mode="reciting"]');
  assert.equal(await readData(page, 'mode'), 'reciting');
  const card = await page.$('question-card');
  assert.ok((await readElementData(card, 'segments')).some((part) => part.isAnswer));
  await capture('03-文学常识-背诵');
  await tap(page, '.next-button');
  assert.equal(await readData(page, 'groupIndex'), 1);
  assert.equal((await readData(page, 'questions')).length, 2);
  report.scenarios.push('真实点击：模式、题卡收藏、题卡掌握、末组不足五题');

  page = await navigate('/pages/favorites/index');
  if (!wasFavorite) assert.ok((await readData(page, 'questions')).some((question) => question.id === questionId));
  await capture('04-我的收藏');
  report.scenarios.push('文学收藏跨页面同步');

  page = await navigate('/pages/classical/index');
  assert.equal((await readData(page, 'leftArticles')).length + (await readData(page, 'rightArticles')).length, 25);
  await capture('05-文言文目录');
  await tap(page, '[data-id="quanxue"]');
  assert.equal(await readData(page, 'modalVisible'), true);
  await capture('06-篇目题型弹窗');
  await tap(page, '.dialog-button[data-type="word"]');
  page = await withTimeout(mini.currentPage(), '读取跳转后的页面');
  assert.equal(page.path, 'pages/practice/index');
  assert.equal(page.query.type, 'word');
  await capture('07-劝学字词');

  page = await navigate('/pages/practice/index?articleId=quanxue&type=translation');
  assert.equal(await readData(page, 'total'), 4);
  await capture('08-劝学翻译');
  const translationId = (await readData(page, 'questions'))[0].id;
  const translationWasFavorite = (await readData(page, 'questions'))[0].favorite;
  if (!translationWasFavorite) await tap(page, 'question-card', '.star-hit');
  page = await navigate('/pages/favorites/index?categoryId=classical-translation');
  assert.equal(await readData(page, 'categoryId'), 'classical-translation');
  assert.ok((await readData(page, 'questions')).some((question) => question.id === translationId));
  await capture('09-文言翻译收藏');
  report.scenarios.push('目录弹窗路由、字词与翻译、第二排文言收藏分类');

  page = await navigate('/pages/random/index?source=literature');
  assert.equal(await readData(page, 'groupCount'), 2);
  await capture('10-文常随机');
  const firstIds = (await readData(page, 'questions')).map((question) => question.id);
  await tap(page, '.next-group');
  const secondIds = (await readData(page, 'questions')).map((question) => question.id);
  assert.equal(secondIds.length, 2);
  assert.ok(secondIds.every((id) => !firstIds.includes(id)));
  await navigate('/pages/home/index');
  page = await navigate('/pages/random/index?source=literature&resume=1');
  assert.deepEqual((await readData(page, 'questions')).map((question) => question.id), secondIds);
  report.scenarios.push('随机本轮不重复、五题换组、原题序与组号恢复');

  page = await navigate('/pages/random/index?source=classical');
  assert.ok((await readData(page, 'questions')).every((question) => question.source === 'classical'));
  await capture('11-文言随机');
  page = await navigate('/pages/practice/index?articleId=guaren&type=word');
  assert.equal(await readData(page, 'total'), 0);
  await capture('12-暂无演示题');
  page = await navigate('/pages/literature/index?categoryId=wei-jin');
  assert.equal((await readData(page, 'questions')).length, 0);
  await capture('13-空分类与长标题');
  report.scenarios.push('两类随机题源隔离、篇目空态、分类空态、长导航标题');
  assert.equal(report.exceptions.length, 0, 'Runtime exception received');
  report.result = 'passed';
}

const verificationDeadline = new Promise((_, reject) => {
  setTimeout(() => reject(new Error('开发者工具运行验收超过60秒，请检查 AppID、编译窗口或自动化端口。')), 60000).unref();
});
Promise.race([main(), verificationDeadline]).catch((error) => {
  report.result = 'failed';
  report.failure = error.stack || String(error);
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (mini) {
    if (loadedOriginal) {
      try {
        if (original) await withTimeout(mini.callWxMethod('setStorageSync', STORAGE_KEY, original), '恢复本地存储');
        else await withTimeout(mini.callWxMethod('removeStorageSync', STORAGE_KEY), '清理本地存储');
      } catch (error) { report.restoreFailure = error.message; }
    }
    mini.disconnect();
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Verification: ${report.result}; ${report.screenshots.length} screenshots.`);
  if (report.result === 'failed') setTimeout(() => process.exit(1), 500).unref();
});

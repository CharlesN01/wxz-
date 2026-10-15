const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const automator = require('miniprogram-automator');

const projectRoot = path.resolve(__dirname, '..');
const output = path.join(projectRoot, '.devtools/automation/screenshots');
const reportPath = path.join(projectRoot, '.devtools/automation/result.json');
const STORAGE_KEY = 'chinese-study.frontend.v1';
const SESSION_KEY = 'student-session-v1';
const CLI_PATH = process.env.WX_DEVTOOLS_CLI || 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const STEP_TIMEOUT = Number(process.env.WX_AUTOMATION_STEP_TIMEOUT || 20000);
const REQUESTED_ENDPOINT = process.env.WX_AUTOMATION_ENDPOINT || '';
const DEFAULT_PORT = Number(process.env.WX_AUTOMATION_PORT || 9448);
const report = {
  checkedAt: new Date().toISOString(),
  endpoint: REQUESTED_ENDPOINT || `ws://127.0.0.1:${DEFAULT_PORT}`,
  screenshots: [],
  pages: [],
  scenarios: [],
  interactions: [],
  exceptions: [],
  runtime: null,
  accountSessionPresent: null,
  visualComparison: 'not-performed'
};

let mini;
let originalStorage;
let hadOriginalStorage = false;
let storageSnapshotTaken = false;
let automationProcessError = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, label, timeout = STEP_TIMEOUT) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${timeout}ms）`)), timeout);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function connect(endpoint) {
  return withTimeout(automator.connect({ wsEndpoint: endpoint }), `连接自动化服务 ${endpoint}`, 5000);
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function launchAutomation(port) {
  if (process.platform !== 'win32') {
    throw new Error('当前自动启动器只配置了 Windows 微信开发者工具 CLI。');
  }
  if (!fs.existsSync(CLI_PATH)) {
    throw new Error(`找不到微信开发者工具 CLI：${CLI_PATH}`);
  }
  const command = `"${CLI_PATH}" auto --project "${projectRoot}" --auto-port ${port} --trust-project --lang zh`;
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.once('error', (error) => { automationProcessError = error; });
  child.unref();
}

async function connectOrLaunch() {
  const endpoints = REQUESTED_ENDPOINT
    ? [REQUESTED_ENDPOINT]
    : Array.from({ length: 10 }, (_, index) => `ws://127.0.0.1:${DEFAULT_PORT + index}`);

  for (const endpoint of endpoints) {
    try {
      mini = await connect(endpoint);
      report.endpoint = endpoint;
      return;
    } catch (_) { /* Try another automation port or start the CLI below. */ }
  }

  const ports = REQUESTED_ENDPOINT
    ? [DEFAULT_PORT, ...Array.from({ length: 10 }, (_, index) => DEFAULT_PORT + index + 1)]
    : endpoints.map((endpoint) => Number(new URL(endpoint).port));
  let selectedPort = null;
  for (const port of ports) {
    if (await portAvailable(port)) {
      selectedPort = port;
      break;
    }
  }
  if (!selectedPort) throw new Error(`自动化端口 ${ports.join(', ')} 均不可用。`);

  report.endpoint = `ws://127.0.0.1:${selectedPort}`;
  launchAutomation(selectedPort);
  const deadline = Date.now() + 60000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (automationProcessError) throw automationProcessError;
    try {
      mini = await connect(report.endpoint);
      return;
    } catch (error) {
      lastError = error;
      await sleep(800);
    }
  }
  throw new Error(`DevTools 自动化未能在 60 秒内启动；端点 ${report.endpoint}；最近错误：${lastError && lastError.message}`);
}

async function readData(page, key) {
  const snapshot = await withTimeout(mini.evaluate((expectedPath, dataPath) => {
    const pages = getCurrentPages();
    const current = pages && pages.length ? pages[pages.length - 1] : null;
    if (!current) return { route: null, value: null };

    const data = current.data || {};
    const value = typeof dataPath === 'string'
      ? dataPath.split('.').reduce((result, part) => result == null ? undefined : result[part], data)
      : data;
    return { route: current.route, value };
  }, page.path, typeof key === 'string' ? key : null), `读取运行时页面数据 ${key || '(all)'}`);
  assert.ok(snapshot && snapshot.route, '小程序运行时没有当前页面');
  assert.equal(snapshot.route, page.path, `读取页面数据时路由已变化：期望 ${page.path}，实际 ${snapshot.route}`);
  return snapshot.value;
}

async function navigate(url, expectedPath) {
  await withTimeout(mini.reLaunch(url), `进入 ${url}`);
  const page = await currentPageFor(expectedPath);
  await waitUntilReady(page, url);
  return page;
}

function pageIdMatches(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left) === String(right);
}

function interactionUnavailable(message, cause) {
  const error = new Error(message);
  error.code = 'DEVTOOLS_INTERACTION_UNVERIFIED';
  if (cause) error.cause = cause;
  return error;
}

async function currentPageFor(expectedPath) {
  let runtimePage;
  try {
    runtimePage = await withTimeout(mini.send('App.getCurrentPage'), '读取运行时页面 ID', 8000);
  } catch (error) {
    throw interactionUnavailable(`无法确认当前页面 ID：${error.message}`, error);
  }
  assert.equal(runtimePage.path, expectedPath, `路由不匹配：期望 ${expectedPath}，实际 ${runtimePage.path}`);

  let page;
  try {
    page = await withTimeout(mini.currentPage(), '读取 Automator 当前页面', 8000);
  } catch (error) {
    throw interactionUnavailable(`无法取得 Automator 页面对象：${error.message}`, error);
  }
  if (!page || page.path !== expectedPath || !pageIdMatches(page.id, runtimePage.pageId)) {
    throw interactionUnavailable(
      `页面对象与运行时不一致：runtime=${runtimePage.pageId}/${runtimePage.path}，automator=${page && page.id}/${page && page.path}`
    );
  }
  return page;
}

function recordInteraction(name, status, reason) {
  const item = { name, status };
  if (reason) item.reason = reason;
  report.interactions.push(item);
  if (status === 'passed') report.scenarios.push(name);
}

async function waitUntilReady(page, label) {
  const deadline = Date.now() + STEP_TIMEOUT;
  while (Date.now() < deadline) {
    const loading = await readData(page, 'loading');
    if (loading !== true) {
      await sleep(450);
      return;
    }
    await sleep(250);
  }
  throw new Error(`${label} 页面仍处于 loading 状态，等待超过 ${STEP_TIMEOUT}ms。`);
}

async function tap(page, selector, inside) {
  let currentPage;
  try {
    currentPage = await currentPageFor(page.path);
  } catch (error) {
    if (error.code === 'DEVTOOLS_INTERACTION_UNVERIFIED') return { verified: false, reason: error.message };
    throw error;
  }

  let element;
  try {
    element = await withTimeout(currentPage.$(selector), `查找元素 ${selector}`);
  } catch (error) {
    return { verified: false, reason: `DevTools 元素查询未完成：${error.message}` };
  }
  if (!element) return { verified: false, reason: `Automator 未返回元素；无法区分选择器未命中与 DevTools 查询限制：${selector}` };
  if (!pageIdMatches(element.pageId, currentPage.id)) {
    return { verified: false, reason: `元素页面 ID 与当前页面不一致：element=${element.pageId}，page=${currentPage.id}` };
  }

  if (inside) {
    try {
      element = await withTimeout(element.$(inside), `查找子元素 ${inside}`);
    } catch (error) {
      return { verified: false, reason: `DevTools 子元素查询未完成：${error.message}` };
    }
    if (!element) return { verified: false, reason: `Automator 未返回子元素；无法区分选择器未命中与 DevTools 查询限制：${inside}` };
    if (!pageIdMatches(element.pageId, currentPage.id)) {
      return { verified: false, reason: `子元素页面 ID 与当前页面不一致：element=${element.pageId}，page=${currentPage.id}` };
    }
  }

  let latestPage;
  try {
    latestPage = await currentPageFor(page.path);
  } catch (error) {
    if (error.code === 'DEVTOOLS_INTERACTION_UNVERIFIED') return { verified: false, reason: error.message };
    throw error;
  }
  if (!pageIdMatches(latestPage.id, element.pageId)) {
    return { verified: false, reason: `点击前页面 ID 已变化：element=${element.pageId}，current=${latestPage.id}` };
  }
  try {
    await withTimeout(element.tap(), `点击 ${selector}${inside || ''}`);
  } catch (error) {
    return { verified: false, reason: `DevTools 点击命令未完成：${error.message}` };
  }
  await sleep(350);
  return { verified: true, pageId: latestPage.id };
}

async function capture(name, page) {
  const screenshotPath = path.join(output, `${name}.jpg`);
  execFileSync('pwsh.exe', [
    '-NoProfile',
    '-File',
    path.join(projectRoot, '.devtools/automation/capture-devtools-window.ps1'),
    '-Path',
    screenshotPath
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const stat = fs.statSync(screenshotPath);
  assert.ok(stat.size > 0 && stat.size <= 512000, `截图为空或大于 500 KB：${name}`);
  report.screenshots.push(`${name}.jpg`);
  const data = await readData(page);
  report.pages.push({
    name,
    path: page.path,
    pageId: page.id,
    mode: data.mode || null,
    source: data.source || data.dataSource || null,
    loading: Boolean(data.loading),
    hasError: Boolean(data.hasError || data.error),
    errorMessage: data.errorMessage || data.error || '',
    questionCount: Array.isArray(data.questions) ? data.questions.length : null,
    articleCount: Array.isArray(data.visibleArticles) ? data.visibleArticles.length : null,
    favoriteCount: Number.isFinite(Number(data.totalFavorites)) ? Number(data.totalFavorites) : null
  });
  console.log(`Screenshot: ${name} (${page.path})`);
}

async function captureRoute(name, url, route) {
  const page = await navigate(url, route);
  await capture(name, page);
  return page;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  console.log('Connecting to WeChat DevTools automation...');
  await connectOrLaunch();
  mini.on('exception', (error) => report.exceptions.push(String(error && (error.stack || error))));
  const info = await withTimeout(mini.systemInfo(), '读取模拟器信息');
  report.runtime = {
    model: info.model,
    windowWidth: info.windowWidth,
    windowHeight: info.windowHeight,
    SDKVersion: info.SDKVersion,
    platform: info.platform
  };
  console.log(`Connected: ${info.model}, ${info.windowWidth}×${info.windowHeight}, SDK ${info.SDKVersion}`);

  const storageInfo = await withTimeout(mini.callWxMethod('getStorageInfoSync'), '读取 storage 键名');
  const keys = Array.isArray(storageInfo && storageInfo.keys) ? storageInfo.keys : [];
  report.accountSessionPresent = keys.includes(SESSION_KEY);
  if (report.accountSessionPresent) {
    throw new Error(`检测到 ${SESSION_KEY} 已存在。为避免给真实账号写入学习状态或随机轮次，本次停止状态截图；请在独立游客模拟器中运行。`);
  }
  hadOriginalStorage = keys.includes(STORAGE_KEY);
  if (hadOriginalStorage) {
    originalStorage = await withTimeout(mini.callWxMethod('getStorageSync', STORAGE_KEY), '备份本地学习状态');
  }
  storageSnapshotTaken = true;

  let page = await captureRoute('01-首页', '/pages/home/index', 'pages/home/index');

  page = await captureRoute('02-文学常识-自测', '/pages/literature/index?mode=writing', 'pages/literature/index');
  const litQuestions = await readData(page, 'questions');
  if (Array.isArray(litQuestions) && litQuestions.length) {
    const firstId = litQuestions[0].id;
    const result = await tap(page, `.answer-button[data-id="${firstId}"]`);
    if (result.verified) {
      const afterReveal = await readData(page, 'questions');
      assert.equal(afterReveal[0].answerVisible, true, '文学题目“查看答案”真实 WXML 事件未触发');
      recordInteraction('文学题卡真实 WXML 点击：查看答案', 'passed');
    } else {
      recordInteraction('文学题卡真实 WXML 点击：查看答案', 'unverified', result.reason);
    }
  } else {
    recordInteraction('文学题卡真实 WXML 点击：查看答案', 'skipped', '当前分类没有可用题目');
  }
  page = await captureRoute('03-文学常识-背诵', '/pages/literature/index?mode=reciting', 'pages/literature/index');
  assert.equal(await readData(page, 'mode'), 'reciting');

  await captureRoute('04-文常随机-背诵', '/pages/random/index?source=literature&mode=reciting', 'pages/random/index');
  await captureRoute('05-文常随机-自测', '/pages/random/index?source=literature&mode=writing', 'pages/random/index');

  await captureRoute('06-文言文目录', '/pages/classical/index', 'pages/classical/index');

  page = await captureRoute('07-重点字词-自测', '/pages/practice/index?articleId=quanxue&type=word&mode=writing', 'pages/practice/index');
  const practiceQuestions = await readData(page, 'questions') || [];
  if (practiceQuestions.length) {
    const modeResult = await tap(page, 'mode-switch', '.mode[data-mode="reciting"]');
    if (modeResult.verified) {
      assert.equal(await readData(page, 'mode'), 'reciting', '专项页模式切换真实 WXML 事件未触发');
      recordInteraction('专项页 mode-switch 真实组件点击：切换背诵模式', 'passed');
    } else {
      recordInteraction('专项页 mode-switch 真实组件点击：切换背诵模式', 'unverified', modeResult.reason);
    }

    const favoriteBefore = practiceQuestions[0].favorite;
    const favoriteResult = await tap(page, 'question-card', '.star-hit');
    if (favoriteResult.verified) {
      const favoriteAfter = (await readData(page, 'questions'))[0].favorite;
      assert.equal(favoriteAfter, !favoriteBefore, '题卡收藏真实组件事件未触发');
      recordInteraction('专项题卡真实组件点击：本地收藏状态切换', 'passed');
    } else {
      recordInteraction('专项题卡真实组件点击：本地收藏状态切换', 'unverified', favoriteResult.reason);
    }
  } else {
    recordInteraction('专项题卡真实组件点击：切换背诵模式', 'skipped', '当前专项没有可用题目');
    recordInteraction('专项题卡真实组件点击：本地收藏状态切换', 'skipped', '当前专项没有可用题目');
  }

  await captureRoute('08-重点字词-背诵', '/pages/practice/index?articleId=quanxue&type=word&mode=reciting', 'pages/practice/index');
  await captureRoute('09-文言翻译-自测', '/pages/practice/index?articleId=quanxue&type=translation&mode=writing', 'pages/practice/index');
  await captureRoute('10-文言翻译-背诵', '/pages/practice/index?articleId=quanxue&type=translation&mode=reciting', 'pages/practice/index');
  await captureRoute('11-文言随机-自测', '/pages/random/index?source=classical&type=word&mode=writing', 'pages/random/index');
  await captureRoute('12-文言随机-背诵', '/pages/random/index?source=classical&type=word&mode=reciting', 'pages/random/index');
  await captureRoute('13-应用文', '/pages/application/index', 'pages/application/index');
  await captureRoute('14-我的收藏', '/pages/favorites/index?source=classical', 'pages/favorites/index');
  await captureRoute('15-我的', '/pages/mine/index', 'pages/mine/index');
  await captureRoute('16-资料群', '/pages/resources/index', 'pages/resources/index');

  assert.equal(report.exceptions.length, 0, '模拟器运行时存在异常');
  assert.equal(report.screenshots.length, 16, '未生成全部 16 个设计状态截图');
  const incompleteInteractions = report.interactions.filter((item) => item.status !== 'passed');
  if (incompleteInteractions.length) {
    report.result = 'partial';
    report.incompleteInteractions = incompleteInteractions.length;
    process.exitCode = 1;
  } else {
    report.result = 'passed';
  }
}

main().catch((error) => {
  report.result = 'failed';
  report.failure = error.stack || String(error);
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (mini) {
    if (storageSnapshotTaken) {
      try {
        if (hadOriginalStorage) await withTimeout(mini.callWxMethod('setStorageSync', STORAGE_KEY, originalStorage), '恢复本地学习状态');
        else await withTimeout(mini.callWxMethod('removeStorageSync', STORAGE_KEY), '清理本地测试状态');
      } catch (error) { report.restoreFailure = error.message; }
    }
    mini.disconnect();
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Verification: ${report.result}; ${report.screenshots.length}/16 screenshots.`);
  if (report.result === 'failed' || report.result === 'partial') setTimeout(() => process.exit(1), 500).unref();
});

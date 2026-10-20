const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const pagePath = path.join(__dirname, '..', 'miniprogram', 'pages', 'practice', 'index.js');

function createPage(resume, questionPayload) {
  let definition;
  let savedBody;
  const questionCalls = [];
  const routes = [];
  const stateCalls = [];
  let savedResume = null;
  const questions = Array.from({ length: 12 }, (_value, index) => ({ id: 'question-' + (index + 1) }));
  const api = {
    auth: { getToken: () => 'qa-session' },
    content: {
      questions: async (params, options) => {
        questionCalls.push({ params, options });
        return questionPayload || { results: [{ id: 'question-1', source: 'classical', articleId: 'quanxue', type: 'word', stem: '题干', answers: ['答案'] }], next: null };
      }
    },
    learning: {
      questionState: async (id) => { stateCalls.push(id); return { questionId: id, favorite: false, mastered: false, version: 0 }; },
      resume: async () => ({ valid: true, resume, version: 3 }),
      saveResume: async (body) => { savedBody = body; return { version: 4 }; }
    }
  };
  const studyStore = {
    getMode: () => 'writing',
    getState: () => ({ favorites: [], mastered: {} }),
    saveResume(value) { savedResume = value; },
    getResume() { return savedResume; }
  };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    require(name) {
      if (name === '../../utils/study-timer') return { withStudyTime: (definition) => definition };
      if (name === '../../services/data-service') return { getArticles: () => [] };
      if (name === '../../utils/study-store') return studyStore;
      if (name === '../../utils/navigation') return { openPage: (url) => routes.push(url) };
      if (name === '../../services/api') return api;
      if (name === '../../utils/answer-drafts') return require('../miniprogram/utils/answer-drafts');
      throw new Error('Unexpected module: ' + name);
    },
    Page(value) { definition = value; },
    wx: { pageScrollTo() {}, request() {} }
  }, { filename: pagePath });
  const page = {
    ...definition,
    data: Object.assign({}, definition.data),
    setData(value) { Object.assign(this.data, value); }
  };
  page.articleId = 'quanxue';
  page.questionType = 'word';
  page.allQuestions = questions;
  page._stateMap = {};
  page._groupCache = {};
  page._resumeVersion = 0;
  return { page, api, routes, questions, getSavedBody: () => savedBody, getSavedResume: () => savedResume, setSavedResume: value => { savedResume = value; }, studyStore, questionCalls, stateCalls };
}

test('专项练习按 API 约定只用 questionId 恢复顺序题组', async () => {
  const { page } = createPage({
    source: 'classical', articleId: 'quanxue', type: 'word', mode: 'writing',
    questionId: 'question-8', roundId: null, groupIndex: null
  });

  await page.restoreResume();

  assert.equal(page.data.groupIndex, 1);
});

test('专项已答进度与掌握统计独立，末页实际两题输入后能达到100%', () => {
  const { page, api } = createPage(null);
  page.allQuestions = Array.from({ length: 8 }, (_value, index) => ({ id: 'draft-practice-' + index, stem: '{{0}}与{{1}}', answers: ['甲', '乙'] }));
  page._stateMap['draft-practice-6'] = { mastered: true, version: 1 };
  page.data.groupIndex = 1;
  page.savePosition = () => { throw new Error('input must not save remote resume'); };
  // Initial page rendering may save a position; input itself must not.
  const savePosition = page.savePosition;
  page.savePosition = () => {};
  page.refreshQuestions();
  page.savePosition = savePosition;
  api.learning.setQuestionState = () => { throw new Error('input must not write mastered'); };
  assert.equal(page.data.pageQuestionCount, 2);
  assert.equal(page.data.completed, 1);
  assert.equal(page.data.pageCompleted, 0);
  page.onAnswerInput({ detail: { id: 'draft-practice-6', values: ['甲', ''] } });
  assert.equal(page.data.pageCompleted, 0);
  page.onAnswerInput({ detail: { id: 'draft-practice-6', values: ['甲', '乙'] } });
  assert.equal(page.data.pageCompleted, 1);
  assert.equal(page.data.pageProgressPercent, 50);
  page.onAnswerInput({ detail: { id: 'draft-practice-7', values: ['丙', '丁'] } });
  assert.equal(page.data.pageProgressPercent, 100);
  assert.equal(page.data.completed, 1);
  page.data.mode = 'reciting';
  page.onAnswerInput({ detail: { id: 'draft-practice-7', values: ['', ''] } });
  assert.equal(page.data.pageCompleted, 2);
});

test('专项练习续学请求不向非随机位置提交 groupIndex', async () => {
  const { page, questions, getSavedBody } = createPage(null);
  page.data.groupIndex = 1;
  page.data.mode = 'reciting';
  page.allQuestions = questions;

  page.savePosition();
  await Promise.resolve();

  assert.equal(getSavedBody().questionId, 'question-7');
  assert.equal(getSavedBody().roundId, null);
  assert.equal(getSavedBody().groupIndex, null);
});

test('字词和翻译有部分免费题时，开通权益返回也会重新加载受限题', async () => {
  for (const type of ['word', 'translation']) {
    const { page, api, questionCalls } = createPage(null, {
      count: 1, results: [{ id: 'free-q', stem: '免费题', answers: [] }], next: null,
      access: { restrictedCount: 2 }
    });
    page.questionType = type;
    page.savePosition = () => {};
    await page.loadRemote(false);
    assert.equal(page.data.requiresEntitlement, false);
    assert.equal(page.data.restrictedCount, 2);
    assert.equal(page.data.total, 1);
    api.content.questions = async () => ({ count: 3, results: [
      { id: 'free-q', stem: '免费题', answers: [] },
      { id: 'paid-q1', stem: '付费题1', answers: [] },
      { id: 'paid-q2', stem: '付费题2', answers: [] }
    ], next: null, access: { restrictedCount: 0 } });
    await page.onShow();
    assert.equal(questionCalls[0].options.auth, true);
    assert.equal(page.data.total, 3);
    assert.equal(page.data.restrictedCount, 0);
    assert.equal(page.data.questions.length, 3);
  }
});

test('专项练习首个题目分页请求在已有会话时携带 Bearer 认证选项', async () => {
  const { page, questionCalls } = createPage(null);
  await page.loadRemote(false);
  assert.equal(questionCalls.length, 1);
  assert.equal(questionCalls[0].options.auth, true);
});

test('专项有已发布题但无免费题时显示权益入口，开通后重读题目', async () => {
  const { page, api, routes } = createPage(null, {
    results: [], next: null, access: { totalCount: 30, restrictedCount: 30, freeCount: 0 }
  });
  await page.loadRemote(false);
  assert.equal(page.data.requiresEntitlement, true);
  assert.equal(page.data.restrictedCount, 30);
  assert.equal(page.data.dataSource, 'remote');
  assert.equal(page.data.hasError, false);
  assert.equal(page.data.questions.length, 0);
  page.onEmptyAction();
  assert.deepEqual(routes, ['/pages/mine/index']);

  api.content.questions = async () => ({
    results: [{ id: 'paid-word', source: 'classical', type: 'word', stem: '{{0}}', answers: ['答案'] }],
    access: { restrictedCount: 0 }, next: null
  });
  await page.loadRemote(false);
  assert.equal(page.data.requiresEntitlement, false);
  assert.equal(page.data.questions[0].id, 'paid-word');
});

test('专项真正无已发布题时保留空态', async () => {
  const { page } = createPage(null, {
    results: [], next: null, access: { totalCount: 0, restrictedCount: 0, freeCount: 0 }
  });
  await page.loadRemote(false);
  assert.equal(page.data.requiresEntitlement, false);
  assert.equal(page.data.restrictedCount, 0);
  assert.equal(page.data.total, 0);
});

test('跨篇目专项保留每篇的受限题数量', async () => {
  const { page, api } = createPage(null, {
    results: [], next: null, access: { totalCount: 30, restrictedCount: 30, freeCount: 0 }
  });
  page.articleId = '';
  api.content.articles = async () => ({ results: [{ id: 'quanxue' }, { id: 'liuguo' }], next: null });
  await page.loadRemote(false);
  assert.equal(page.data.requiresEntitlement, true);
  assert.equal(page.data.restrictedCount, 60);
});


test('千题跨篇专项首屏只读相交题目页并复用嵌入状态，不扫描全题或逐题状态', async () => {
  for (const type of ['word', 'translation']) {
    const { page, api, stateCalls } = createPage(null);
    page.articleId = '';
    page.questionType = type;
    const calls = [];
    api.content.articles = async () => ({ results: [
      { id: 'a', wordCount: 5, translationCount: 5, publishedWordCount: 5, publishedTranslationCount: 5 },
      { id: 'b', wordCount: 1000, translationCount: 1000, publishedWordCount: 1000, publishedTranslationCount: 1000 }
    ], next: null });
    api.content.questions = async params => {
      calls.push(params.articleId + ':' + params.page);
      const count = params.articleId === 'a' ? 5 : 1000;
      const start = (params.page - 1) * 20;
      return { count, results: Array.from({ length: Math.min(20, count - start) }, (_v, index) => ({
        id: params.articleId + (start + index + 1), state: { favorite: true, mastered: true, version: 9 }
      })), next: start + 20 < count ? 'next' : null, access: { pageSize: 20, restrictedCount: 0 } };
    };
    await page.loadRemote(false);
    assert.equal(page.data.loading, false);
    assert.equal(page.data.total, 1005);
    assert.equal(page.data.groupCount, 168);
    assert.equal(JSON.stringify(page.data.questions.map(q => q.id)), JSON.stringify(['a1', 'a2', 'a3', 'a4', 'a5', 'b1']));
    assert.deepEqual(calls, ['a:1', 'b:1']);
    assert.equal(stateCalls.length, 0);
    assert.equal(page.data.questions[0].favorite, true);
    assert.equal(page.data.questions[0].version, 9);
    await page.onNextGroup();
    assert.equal(page.data.questions[0].id, 'b2');
    assert.equal(calls.length, 2);
    await page.changeGroup(4);
    assert.equal(page.data.questions[0].id, 'b20');
    assert.deepEqual(calls, ['a:1', 'b:1', 'b:2']);
    await page.onPreviousGroup();
    assert.equal(calls.length, 3);
  }
});

test('跨篇续学先定位目标篇目，不加载其前面一千道题目', async () => {
  const { page, api, getSavedResume } = createPage(null);
  page.articleId = '';
  page._requestedQuestionId = 'b8';
  const calls = [];
  api.content.articles = async () => ({ results: [
    { id: 'a', wordCount: 1000, publishedWordCount: 1000 },
    { id: 'b', wordCount: 12, publishedWordCount: 12 }
  ], next: null });
  api.content.question = async id => ({ id, articleId: 'b' });
  api.content.questions = async params => {
    calls.push(params.articleId + ':' + params.page);
    assert.equal(params.articleId, 'b');
    return { count: 12, results: Array.from({ length: 12 }, (_v, index) => ({ id: 'b' + (index + 1) })), access: { pageSize: 20 }, next: null };
  };
  await page.loadRemote(true);
  assert.equal(page.data.groupIndex, 167);
  assert.equal(page.data.questions[0].id, 'b3');
  assert.equal(page.data.questions[5].id, 'b8');
  assert.deepEqual(calls, ['b:1']);
  assert.equal(getSavedResume().options.questionId, 'b3');
  assert.equal(getSavedResume().groupCache['168'][0].id, 'b3');

  // A later offline visit must retain its global group number with a sparse cache.
  page._remotePaging = false;
  assert.equal(page.restoreCachedResume(), true);
  page.refreshQuestions();
  assert.equal(page.data.groupIndex, 167);
  assert.equal(page.data.questions[0].id, 'b3');
  assert.equal(page.data.total, 1012);
});

test('按需翻页断网保留当前题组，重试仅请求失败页', async () => {
  const { page, api } = createPage(null);
  let disconnected = true;
  const calls = [];
  api.content.questions = async params => {
    calls.push(params.page);
    if (params.page === 2 && disconnected) throw { code: 'NETWORK_ERROR' };
    return { count: 12, results: Array.from({ length: 6 }, (_v, index) => ({ id: 'q' + ((params.page - 1) * 6 + index + 1) })), access: { pageSize: 6 }, next: params.page === 1 ? 'next' : null };
  };
  await page.loadRemote(false);
  await page.onNextGroup();
  assert.equal(page.data.groupIndex, 0);
  assert.equal(page.data.questions[0].id, 'q1');
  assert.equal(page.data.dataSource, 'remote');
  assert.match(page.data.personalError, /重试/);
  assert.doesNotMatch(page.data.personalError, /当前显示本地演示/);
  disconnected = false;
  await page.onNextGroup();
  assert.equal(page.data.groupIndex, 1);
  assert.equal(page.data.questions[0].id, 'q7');
  assert.deepEqual(calls, [1, 2, 2]);
});

test('无可读题时使用目录已发布类型计数显示受限空态，不逐篇读题', async () => {
  const { page, api } = createPage(null);
  page.articleId = '';
  api.content.articles = async () => ({ results: [
    { id: 'a', wordCount: 0, translationCount: 5, publishedWordCount: 30, publishedTranslationCount: 40 },
    { id: 'b', wordCount: 0, translationCount: 5, publishedWordCount: 20, publishedTranslationCount: 30 }
  ], next: null });
  api.content.questions = async () => { throw new Error('empty scope should not request questions'); };
  await page.loadRemote(false);
  assert.equal(page.data.restrictedCount, 50);
  assert.equal(page.data.requiresEntitlement, true);
  assert.equal(page.data.dataSource, 'remote');
});

test('收藏使用随题状态版本提交，冲突后只按服务器版本重试', async () => {
  const { page, api, stateCalls } = createPage(null, {
    count: 1, results: [{ id: 'q1', state: { favorite: true, mastered: false, version: 7 } }], next: null
  });
  await page.loadRemote(false);
  const writes = [];
  api.learning.setQuestionState = async (id, body) => {
    writes.push({ id, body });
    if (writes.length === 1) throw { code: 'VERSION_CONFLICT', current: { favorite: true, version: 8 } };
    return { favorite: false, mastered: false, version: 9 };
  };
  await page.onFavorite({ detail: { id: 'q1' } });
  assert.equal(stateCalls.length, 0);
  assert.equal(writes[0].body.baseVersion, 7);
  assert.equal(writes[1].body.baseVersion, 8);
  assert.equal(writes[1].body.favorite, false);
  assert.equal(page.data.questions[0].favorite, false);
});


test('页面退出后的未完成题目请求不会回写已失效页面状态', async () => {
  const { page, api } = createPage(null);
  let release;
  api.content.questions = () => new Promise(resolve => { release = resolve; });
  const loading = page.loadRemote(false);
  page.onUnload();
  release({ count: 1, results: [{ id: 'stale-q' }], access: { pageSize: 20 } });
  await loading;
  assert.equal(page._remoteLoaded, undefined);
  assert.equal(page.data.questions.length, 0);
  assert.equal(Object.keys(page._remoteRows).length, 0);
});

test('离线缓存未包含上一组时保留当前位置并提示联网', async () => {
  const { page, api } = createPage(null);
  page._remotePaging = false;
  page.allQuestions = new Array(12);
  page.allQuestions[6] = { id: 'q7' };
  page.data.loading = false;
  page.data.groupIndex = 1;
  page.data.groupCount = 2;
  page.data.total = 12;
  await page.onPreviousGroup();
  assert.equal(page.data.groupIndex, 1);
  assert.match(page.data.personalError, /尚未缓存/);
});


test('续学使用服务端scopeIndex直接取第50页，不扫描前49页', async () => {
  const { page, api } = createPage(null);
  page.articleId = '';
  page._requestedQuestionId = 'b998';
  const calls = [];
  api.content.articles = async () => ({ results: [
    { id: 'a', wordCount: 1000, publishedWordCount: 1000 },
    { id: 'b', wordCount: 1000, publishedWordCount: 1000 }
  ], next: null });
  api.content.question = async id => ({ id, articleId: 'b', type: 'word', scopeIndex: 997, access: { pageSize: 20 } });
  api.content.questions = async params => {
    calls.push(params.articleId + ':' + params.page);
    const start = (params.page - 1) * 20;
    return { count: 1000, results: Array.from({ length: 20 }, (_v, index) => ({ id: params.articleId + (start + index + 1) })), access: { pageSize: 20 } };
  };
  await page.loadRemote(true);
  assert.equal(page.data.groupIndex, 332);
  assert.equal(page.data.questions[0].id, 'b993');
  assert.equal(page.data.questions[5].id, 'b998');
  assert.deepEqual(calls, ['b:50']);
});

test('已缓存题目定位不重新请求详情或前面的分页', async () => {
  const { page, api } = createPage(null, {
    count: 1000, results: Array.from({ length: 20 }, (_v, index) => ({ id: 'q' + (index + 1) })), access: { pageSize: 20 }
  });
  api.content.question = async () => { throw new Error('cached question should not request detail'); };
  await page.loadRemote(false);
  assert.equal(await page.locateRemoteQuestion('q15'), 14);
});

test('旧缓存缺少options.questionId时从当前题组缓存恢复，不按压缩后的groupIds误定位', async () => {
  const { page, api, setSavedResume } = createPage(null);
  page.articleId = '';
  setSavedResume({
    path: '/pages/practice/index', options: { type: 'word' }, groupIndex: 167,
    groupIds: ['b3'], groupCache: { '168': [{ id: 'b3' }] }
  });
  api.content.articles = async () => ({ results: [
    { id: 'a', wordCount: 1000, publishedWordCount: 1000 },
    { id: 'b', wordCount: 12, publishedWordCount: 12 }
  ], next: null });
  api.content.question = async id => {
    assert.equal(id, 'b3');
    return { id, articleId: 'b', type: 'word', scopeIndex: 2, access: { pageSize: 20 } };
  };
  api.content.questions = async params => ({ count: 12, results: Array.from({ length: 12 }, (_v, index) => ({ id: 'b' + (index + 1) })), access: { pageSize: 20 } });
  await page.loadRemote(true);
  assert.equal(page.data.groupIndex, 167);
  assert.equal(page.data.questions[0].id, 'b3');
});

test('远端专项掌握统计不混入本地演示题的掌握状态', async () => {
  const { page, studyStore } = createPage(null, {
    count: 1, results: [{ id: 'q1' }], access: { pageSize: 20 }
  });
  studyStore.getState = () => ({ favorites: [], mastered: { q1: true } });
  await page.loadRemote(false);
  assert.equal(page.data.completed, 0);
  assert.equal(page.data.questions[0].mastered, false);
});

test('千题专项首屏用全部篇目对应类型掌握汇总，不把已读20题当总掌握数', async () => {
  for (const type of ['word', 'translation']) {
    const { page, api, stateCalls, studyStore } = createPage(null);
    page.articleId = '';
    page.questionType = type;
    const calls = [];
    studyStore.getState = () => ({ favorites: [], mastered: { q1: true } });
    api.content.articles = async () => ({ results: [
      { id: 'a', wordCount: 1000, translationCount: 1000, progress: { masteredWordCount: 900, masteredTranslationCount: 50 } },
      { id: 'b', wordCount: 1000, translationCount: 1000, progress: { masteredWordCount: 50, masteredTranslationCount: 900 } }
    ], next: null });
    api.content.questions = async params => {
      calls.push(params.articleId + ':' + params.page);
      return { count: 1000, progress: { masteredCount: type === 'word' ? 900 : 50 },
        results: Array.from({ length: 20 }, (_v, index) => ({ id: 'q' + (index + 1), state: { mastered: false, version: 1 } })),
        access: { pageSize: 20 } };
    };
    await page.loadRemote(false);
    assert.equal(page.data.total, 2000);
    assert.equal(page.data.completed, 950);
    assert.equal(page.data.progressPercent, 48);
    assert.equal(page.data.pageCompleted, 0);
    assert.deepEqual(calls, ['a:1']);
    assert.equal(stateCalls.length, 0);
  }
});

test('单篇专项使用分页响应总掌握数，后续按需分页刷新汇总', async () => {
  const { page, api, stateCalls } = createPage(null);
  const calls = [];
  api.content.questions = async params => {
    calls.push(params.page);
    return { count: 1000, progress: { masteredCount: params.page === 1 ? 950 : 951 },
      results: Array.from({ length: 20 }, (_v, index) => ({ id: 'q' + ((params.page - 1) * 20 + index + 1), state: { mastered: true, version: 1 } })),
      access: { pageSize: 20 } };
  };
  await page.loadRemote(false);
  assert.equal(page.data.completed, 950);
  assert.equal(page.data.total, 1000);
  assert.deepEqual(calls, [1]);
  await page.changeGroup(4);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(page.data.completed, 951);
  assert.equal(stateCalls.length, 0);
});

test('远端掌握汇总只随成功状态变化增减，失败、同值和重复响应不累计', async () => {
  const { page, api } = createPage(null, {
    count: 1000, progress: { masteredCount: 950 },
    results: [{ id: 'q1', state: { mastered: false, favorite: false, version: 1 } }], access: { pageSize: 20 }
  });
  await page.loadRemote(false);
  let fail = true;
  let version = 1;
  const writes = [];
  api.learning.setQuestionState = async (id, body) => {
    writes.push({ id, body });
    if (fail) throw { code: 'NETWORK_ERROR' };
    version += 1;
    return { mastered: body.mastered, favorite: false, version };
  };
  await page.onMaster({ detail: { id: 'q1', mastered: true } });
  assert.equal(page.data.completed, 950);
  fail = false;
  await page.onMaster({ detail: { id: 'q1', mastered: true } });
  assert.equal(page.data.completed, 951);
  assert.equal(page.data.questions[0].mastered, true);
  await page.onMaster({ detail: { id: 'q1', mastered: true } });
  assert.equal(writes.length, 2);
  assert.equal(page.data.completed, 951);
  page.acceptQuestionState('q1', { mastered: true, version: 2 });
  page.refreshQuestions();
  assert.equal(page.data.completed, 951);
  await page.onMaster({ detail: { id: 'q1', mastered: false } });
  assert.equal(page.data.completed, 950);
  page.acceptQuestionState('q1', { mastered: true, version: 2 });
  page.refreshQuestions();
  assert.equal(page.data.completed, 950);
  assert.equal(page.data.questions[0].mastered, false);
});

test('掌握写入409重试成功后仅更新一次汇总，收藏保留掌握数', async () => {
  const { page, api, stateCalls } = createPage(null, {
    count: 1000, progress: { masteredCount: 950 },
    results: [{ id: 'q1', state: { mastered: false, favorite: false, version: 1 } }], access: { pageSize: 20 }
  });
  await page.loadRemote(false);
  const writes = [];
  api.learning.setQuestionState = async (id, body) => {
    writes.push(body);
    if (writes.length === 1) throw { code: 'VERSION_CONFLICT', current: { mastered: false, favorite: true, version: 3 } };
    return { mastered: true, favorite: true, version: writes.length + 2 };
  };
  await page.onMaster({ detail: { id: 'q1', mastered: true } });
  assert.equal(writes[0].baseVersion, 1);
  assert.equal(writes[1].baseVersion, 3);
  assert.equal(page.data.completed, 951);
  await page.onFavorite({ detail: { id: 'q1' } });
  assert.equal(page.data.completed, 951);
  assert.equal(stateCalls.length, 0);
});

test('旧服务无汇总时只统计已加载远端状态，不混入其他篇目本地掌握', async () => {
  const { page, api, studyStore } = createPage(null);
  page.articleId = '';
  studyStore.getState = () => ({ favorites: [], mastered: { q1: true, q2: true, q3: true } });
  api.content.articles = async () => ({ results: [
    { id: 'a', wordCount: 1000 }, { id: 'b', wordCount: 1000 }
  ], next: null });
  api.content.questions = async () => ({ count: 1000, results: [
    { id: 'q1', state: { mastered: true, version: 1 } },
    { id: 'q2', state: { mastered: false, version: 1 } }, { id: 'q3' }
  ], access: { pageSize: 20 } });
  await page.loadRemote(false);
  assert.equal(page.data.completed, 1);
});

test('同题并发掌握请求确认相同状态时，scope总数只增加一次', async () => {
  const { page, api } = createPage(null, {
    count: 1000, progress: { masteredCount: 950 },
    results: [{ id: 'q1', state: { mastered: false, version: 1 } }], access: { pageSize: 20 }
  });
  await page.loadRemote(false);
  const resolveWrites = [];
  api.learning.setQuestionState = () => new Promise(resolve => resolveWrites.push(resolve));
  const first = page.onMaster({ detail: { id: 'q1', mastered: true } });
  const second = page.onMaster({ detail: { id: 'q1', mastered: true } });
  assert.equal(resolveWrites.length, 2);
  resolveWrites[1]({ mastered: true, version: 3 });
  await second;
  resolveWrites[0]({ mastered: true, version: 2 });
  await first;
  assert.equal(page.data.completed, 951);
  assert.equal(page.data.questions[0].version, 3);
});

test('题目未嵌入状态时，首次收藏读到已掌握不能再次增加scope总数', async () => {
  const { page, api, stateCalls } = createPage(null, {
    count: 1000, progress: { masteredCount: 950 }, results: [{ id: 'q1' }], access: { pageSize: 20 }
  });
  await page.loadRemote(false);
  api.learning.questionState = async id => {
    stateCalls.push(id);
    return { mastered: true, favorite: false, version: 7 };
  };
  api.learning.setQuestionState = async () => ({ mastered: true, favorite: true, version: 8 });
  await page.onFavorite({ detail: { id: 'q1' } });
  assert.equal(page.data.completed, 950);
  assert.equal(page.data.questions[0].mastered, true);
  assert.equal(page.data.questions[0].favorite, true);
  assert.deepEqual(stateCalls, ['q1']);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadPage(relativePath, overrides, globals = {}) {
  const filename = path.join(root, 'miniprogram', relativePath);
  let definition;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      if (name === '../../utils/study-timer') return { withStudyTime: (definition) => definition };
      if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name];
      if (name === '../../utils/agent-attribution') return { read: () => '', sharePath: (value) => value, shareQuery: () => '' };
      if (name === '../../utils/answer-drafts') return require('../miniprogram/utils/answer-drafts');
      if (name === '../../utils/page-swipe') return require('../miniprogram/utils/page-swipe');
      throw new Error('Unexpected module: ' + name);
    },
    Page(value) { definition = value; },
    wx: globals.wx,
    getCurrentPages: globals.getCurrentPages || (() => [])
  }, { filename });
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(value) { Object.assign(this.data, value); }
  };
}

function question(id, source = 'literature', type = 'fact') {
  return { id, source, type, stem: id, answers: ['answer'] };
}

function baseStore(resume) {
  return {
    getMode() { return 'writing'; },
    setMode() {},
    getState() { return { favorites: [], mastered: {} }; },
    getResume() { return resume; },
    saveResume() {}
  };
}

test('旧轮次直达链接在整组内容下架后提示重开，点击前不创建新轮次', async () => {
  let creations = 0;
  const reads = [];
  const api = {
    auth: { getToken: () => 'updated-round-user' },
    practice: {
      createRound: async () => { creations += 1; return { id: 'new-round', groupCount: 1, totalCount: 1 }; },
      group: async (id, index) => {
        reads.push([id, index]);
        return id === 'old-round'
          ? { groupIndex: index, groupCount: 2, totalCount: 2, results: [], skipped: [{ reason: 'UNAVAILABLE' }, { reason: 'SCOPE_CHANGED' }] }
          : { groupIndex: 1, groupCount: 1, totalCount: 1, results: [{ ...question('new-question'), state: {} }], skipped: [] };
      }
    }
  };
  const page = loadPage('pages/random/index.js', {
    '../../services/api': api, '../../utils/study-store': baseStore(null),
    '../../services/data-service': {}, '../../utils/safe-top': {}, '../../utils/navigation': {}
  }, { wx: { request() {} } });
  page.saveResume = () => {};
  page.onLoad({ source: 'literature', roundId: 'old-round', groupIndex: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creations, 0);
  assert.equal(page.data.roundContentUnavailable, true);
  assert.equal(page.data.questions.length, 0);
  assert.equal(page.data.hasError, false);
  assert.equal(JSON.stringify(reads), '[["old-round",2]]');
  page._groupCache['1'] = [question('stale-cached-question')];

  const restart = page.restartUpdatedRound();
  assert.equal(page.data.loading, true);
  assert.equal(page.restartUpdatedRound(), undefined);
  await restart;
  assert.equal(creations, 1);
  assert.equal(page._roundId, 'new-round');
  assert.equal(page._requestedRoundId, '');
  assert.equal(page._requestedGroupIndex, 0);
  assert.equal(page.data.questions[0].id, 'new-question');
  assert.equal(page.data.roundContentUnavailable, false);
  assert.equal(page._groupCache['2'], undefined);
  const template = fs.readFileSync(path.join(root, 'miniprogram/pages/random/index.wxml'), 'utf8');
  assert.match(template, /roundContentUnavailable\}\}"[^>]*description="题库已更新，请重新开始本轮"[^>]*bindaction="restartUpdatedRound"/);
});

test('权限不足、混合跳过原因、普通空集及仍有可读题目不会误报题库改版', async () => {
  const cases = [
    { results: [], skipped: [{ reason: 'ENTITLEMENT_REQUIRED' }] },
    { results: [], skipped: [{ reason: 'UNAVAILABLE' }, { reason: 'ENTITLEMENT_REQUIRED' }] },
    { results: [], skipped: [{ reason: 'UNEXPECTED_REASON' }] },
    { results: [], skipped: [null] },
    { results: [], skipped: [] },
    { results: [] },
    { results: [{ ...question('still-readable'), state: {} }], skipped: [{ reason: 'UNAVAILABLE' }] }
  ];
  for (const payload of cases) {
    let creations = 0;
    const page = loadPage('pages/random/index.js', {
      '../../services/api': {
        auth: { getToken: () => 'restricted-round-user' },
        practice: { group: async () => ({ groupIndex: 1, groupCount: 1, ...payload }), createRound: async () => { creations += 1; } }
      },
      '../../utils/study-store': baseStore(null), '../../services/data-service': {},
      '../../utils/safe-top': {}, '../../utils/navigation': {}
    });
    page._roundId = 'existing-round'; page._roundIds = []; page._groupCache = {}; page._stateMap = {};
    page.saveResume = () => {};
    await page.loadRemoteGroup(1);
    assert.equal(page.data.roundContentUnavailable, false);
    page.restartUpdatedRound();
    assert.equal(creations, 0);
    if (payload.skipped && payload.skipped.some(row => row && row.reason === 'ENTITLEMENT_REQUIRED')) {
      assert.match(page.data.personalError, /开通学习权益/);
    }
  }
});

test('旧轮次查组网络或服务端失败保留错误，不能显示题库改版或自动重建', async () => {
  for (const error of [{ code: 'NETWORK_ERROR' }, { status: 503, message: '服务暂不可用' }]) {
    let creations = 0;
    const page = loadPage('pages/random/index.js', {
      '../../services/api': {
        auth: { getToken: () => 'failed-round-user' },
        practice: { group: async () => { throw error; }, createRound: async () => { creations += 1; } }
      },
      '../../utils/study-store': baseStore(null), '../../services/data-service': {},
      '../../utils/safe-top': {}, '../../utils/navigation': {}
    });
    page._roundId = 'old-round'; page._roundIds = []; page._groupCache = {}; page._stateMap = {};
    page.setData({ roundContentUnavailable: true });
    assert.equal(await page.loadRemoteGroup(1), false);
    assert.equal(page.data.roundContentUnavailable, false);
    assert.equal(page.data.hasError, true);
    assert.ok(page.data.errorMessage);
    page.restartUpdatedRound();
    assert.equal(creations, 0);
    assert.equal(page._roundId, 'old-round');
  }
});

test('真实随机轮次按题源规范化旧路由参数，文常不会提交word或文言articleId', async () => {
  for (const [source, requestedType, expectedType] of [
    ['literature', 'word', null],
    ['literature', 'translation', null],
    ['literature', 'fact', 'fact'],
    ['classical', 'word', 'word'],
    ['classical', 'translation', 'translation'],
    ['classical', 'fact', 'word']
  ]) {
    let request;
    const api = {
      auth: { getToken: () => 'random-contract-user' },
      practice: {
        createRound: async body => { request = body; return { id: 'contract-round', groupCount: 1, totalCount: 1, pageSize: 6 }; },
        group: async () => ({ groupIndex: 1, groupCount: 1, totalCount: 1, pageSize: 6, results: [{ ...question('contract-q', source, expectedType || 'fact'), state: {} }] })
      },
      learning: {
        resume: async () => ({ valid: false, start: null }),
        saveResume: async () => ({ version: 1 })
      }
    };
    const page = loadPage('pages/random/index.js', {
      '../../services/api': api, '../../utils/study-store': baseStore(null),
      '../../services/data-service': {}, '../../utils/safe-top': {}, '../../utils/navigation': {}
    }, { wx: { request() {} } });
    page.onLoad({ source, type: requestedType, articleId: 'classical-leftover', mode: 'writing' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(request.source, source);
    assert.equal(request.type, expectedType);
    assert.equal(request.articleId, source === 'classical' ? 'classical-leftover' : null);
    assert.equal(page.data.hasError, false);
    assert.equal(page.data.questions.length, 1);
    assert.equal(page.data.dataSource, 'remote');
  }
});

test('随机组使用后端附带状态，20题只发一次题组请求且保留收藏版本', async () => {
  let reads = 0;
  const api = {
    auth: { getToken: () => 'learner' },
    practice: { group: async () => {
      reads += 1;
      return { groupIndex: 1, groupCount: 1, totalCount: 20, pageSize: 20,
        results: Array.from({ length: 20 }, (_, index) => ({ ...question('q' + index), state: { questionId: 'q' + index, favorite: index === 0, mastered: index === 1, version: 7 } })) };
    } },
    learning: { questionState: () => { throw new Error('unexpected per-question read'); } }
  };
  const page = loadPage('pages/random/index.js', {
    '../../services/api': api, '../../utils/study-store': baseStore(null),
    '../../services/data-service': {}, '../../utils/safe-top': {}, '../../utils/navigation': {}
  });
  page._stateMap = {}; page._groupCache = {}; page._roundIds = [];
  page._roundId = 'round'; page.saveResume = () => {};
  await page.loadRemoteGroup(1);
  assert.equal(reads, 1);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.questions[0].favorite, true);
  assert.equal(page.data.questions[1].mastered, true);
  assert.equal(page.data.questions[0].version, 7);
});

test('文常和文言随机在登录后退出演示模式，并在开通后重读原轮次当前组', async () => {
  for (const source of ['literature', 'classical']) {
    let token = '';
    let activated = false;
    let creations = 0;
    const row = question('paid-random-q', source, source === 'classical' ? 'word' : 'fact');
    const api = {
      auth: { getToken: () => token, getSession: () => ({ user: { id: 7 } }) },
      learning: { questionState: async () => ({ version: 0 }) },
      practice: {
        createRound: async () => { creations += 1; return { id: 'server-round', groupCount: 1, totalCount: 1, pageSize: 6 }; },
        group: async () => ({ groupIndex: 1, groupCount: 1, totalCount: 1,
          results: activated ? [row] : [], skipped: activated ? [] : [{ reason: 'ENTITLEMENT_REQUIRED' }] })
      }
    };
    const page = loadPage('pages/random/index.js', {
      '../../services/api': api, '../../utils/study-store': baseStore(null),
      '../../services/data-service': { getQuestions: () => [], getQuestion: () => null, decorateQuestions: rows => rows },
      '../../utils/navigation': {}, '../../utils/safe-top': {}
    }, { wx: { request() {} } });
    page.saveResume = () => {};
    page.onLoad({ source });
    assert.equal(page.data.dataSource, 'local');
    token = 'same-random-learner';
    await page.onShow();
    assert.equal(page.data.dataSource, 'remote');
    assert.match(page.data.personalError, /开通学习权益/);
    assert.equal(creations, 1);
    activated = true;
    await page.onShow();
    assert.equal(page.data.personalError, '');
    assert.equal(page.data.questions[0].id, 'paid-random-q');
    assert.equal(page._roundId, 'server-round');
    assert.equal(creations, 1);
    token = 'refreshed-session-same-account';
    await page.onShow();
    assert.equal(page._roundId, 'server-round');
    assert.equal(creations, 1);
  }
});

test('随机练习恢复接口断网时保留本地远端题组和当前组号', async () => {
  const groupTwo = [question('remote-q7'), question('remote-q8')];
  const resume = {
    path: '/pages/random/index',
    options: { source: 'literature', type: null, articleId: null, mode: 'writing' },
    groupIds: ['remote-q1', 'remote-q2', 'remote-q7', 'remote-q8'],
    groupIndex: 1,
    roundId: 'round-7',
    groupCount: 2,
    roundQuestionCount: 4,
    groupPageSize: 2,
    groupCache: { '2': groupTwo }
  };
  const api = {
    auth: { getToken() { return 'qa-session'; } },
    learning: { resume: async () => { throw { code: 'NETWORK_ERROR' }; } },
    practice: { createRound: async () => { throw new Error('should not create a new round'); } }
  };
  const dataService = { getQuestion() { return null; }, decorateQuestions(rows) { return rows; } };
  const page = loadPage('pages/random/index.js', {
    '../../services/data-service': dataService,
    '../../utils/study-store': baseStore(resume),
    '../../utils/safe-top': { getSafeTop() { return 0; } },
    '../../utils/navigation': {},
    '../../services/api': api
  });
  page._source = 'literature'; page._type = null; page._typeExplicit = false; page._articleId = null;
  page._modeExplicit = false; page.data.mode = 'writing';

  await page.startRemoteRound(true);

  assert.equal(page.data.dataSource, 'local');
  assert.equal(page.data.groupNumber, 2);
  assert.deepEqual(page.data.questions.map((item) => item.id), ['remote-q7', 'remote-q8']);
});

test('随机练习恢复轮次的当前组请求断网时使用缓存而不回退第一组', async () => {
  const groupTwo = [question('remote-q7'), question('remote-q8')];
  const resume = {
    path: '/pages/random/index',
    options: { source: 'literature', type: null, articleId: null, mode: 'writing' },
    groupIds: ['remote-q1', 'remote-q2', 'remote-q7', 'remote-q8'],
    groupIndex: 1,
    roundId: 'round-7',
    groupCount: 2,
    roundQuestionCount: 4,
    groupPageSize: 2,
    groupCache: { '2': groupTwo }
  };
  const api = {
    auth: { getToken() { return 'qa-session'; } },
    learning: { resume: async () => ({ valid: true, resume: { source: 'literature', type: null, articleId: null, mode: 'writing', roundId: 'round-7', groupIndex: 2 }, version: 4 }) },
    practice: { group: async () => { throw { code: 'NETWORK_ERROR' }; }, createRound: async () => { throw new Error('should not create a new round'); } }
  };
  const page = loadPage('pages/random/index.js', {
    '../../services/data-service': { getQuestion() { return null; }, decorateQuestions(rows) { return rows; } },
    '../../utils/study-store': baseStore(resume),
    '../../utils/safe-top': { getSafeTop() { return 0; } },
    '../../utils/navigation': {},
    '../../services/api': api
  });
  page._source = 'literature'; page._type = null; page._typeExplicit = false; page._articleId = null;
  page._modeExplicit = false; page.data.mode = 'writing';

  await page.startRemoteRound(true);

  assert.equal(page.data.groupNumber, 2);
  assert.deepEqual(page.data.questions.map((item) => item.id), ['remote-q7', 'remote-q8']);
  assert.equal(page.data.hasError, false);
});

test('专项练习题目接口断网时恢复缓存中的当前分页', async () => {
  const rows = Array.from({ length: 12 }, (_value, index) => question('classical-q' + (index + 1), 'classical', 'word'));
  const resume = {
    path: '/pages/practice/index',
    options: { articleId: 'quanxue', type: 'word' },
    groupIds: rows.map((item) => item.id),
    groupIndex: 1,
    groupCount: 2,
    roundQuestionCount: 12,
    groupPageSize: 6,
    groupCache: { '1': rows.slice(0, 6), '2': rows.slice(6) }
  };
  const api = {
    auth: { getToken() { return 'qa-session'; } },
    content: { questions: async () => { throw { code: 'NETWORK_ERROR' }; } },
    learning: { resume: async () => { throw { code: 'NETWORK_ERROR' }; }, saveResume: async () => ({ version: 4 }) }
  };
  const page = loadPage('pages/practice/index.js', {
    '../../services/data-service': { getArticles() { return []; }, getQuestions() { return []; } },
    '../../utils/study-store': baseStore(resume),
    '../../utils/navigation': {},
    '../../services/api': api
  }, { wx: { pageScrollTo() {} } });
  page.articleId = 'quanxue'; page.questionType = 'word';
  page.data.mode = 'writing'; page.allQuestions = [];

  await page.loadRemote(true);

  assert.equal(page.data.dataSource, 'local');
  assert.equal(page.data.groupIndex, 1);
  assert.equal(JSON.stringify(page.data.questions.map((item) => item.id)), JSON.stringify(rows.slice(6).map((item) => item.id)));
});

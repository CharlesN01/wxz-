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
      if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name];
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

const test = require('node:test');
const assert = require('node:assert/strict');
const drafts = require('../miniprogram/utils/answer-drafts');

function makeStore(id) {
  let userId = id;
  let token = 'token-a';
  const saved = new Map();
  const auth = { getSession: () => userId == null ? null : ({ user: { id: userId } }), getToken: () => token };
  const storage = { getStorageSync: key => saved.get(key), setStorageSync: (key, value) => saved.set(key, value) };
  return { store: drafts.createStore(auth, storage), saved, setUser: id => { userId = id; }, setToken: value => { token = value; }, auth };
}

test('输入草稿按账号和题目隔离，同账号换Token保留且不持久化Bearer', () => {
  const fixture = makeStore('draft-user-one');
  const question = { id: 'account-isolation', stem: '{{1}}后{{0}}', answers: ['甲', '乙'] };
  fixture.store.save(question, ['甲', '乙']);
  fixture.setToken('refreshed-token');
  assert.deepEqual(fixture.store.read(question), ['甲', '乙']);
  fixture.setUser('draft-user-two');
  assert.deepEqual(fixture.store.read(question), ['', '']);
  fixture.store.save(question, ['丙', '丁']);
  fixture.setUser('draft-user-one');
  assert.deepEqual(fixture.store.read(question), ['甲', '乙']);
  assert.doesNotMatch(JSON.stringify([...fixture.saved.entries()]), /token-a|refreshed-token/);
});

test('只按真实空位计算完整已答题数，空白输入和mastered均不计入', () => {
  const rows = [
    { id: 'multi', stem: '{{1}}与{{0}}再{{1}}', answers: ['一', '二'], draftAnswers: ['一', '  '] },
    { id: 'translation', type: 'translation', stem: '原文', answers: ['译文'], draftAnswers: ['我的译文'] },
    { id: 'mastered-only', stem: '{{0}}', answers: ['答案'], mastered: true, draftAnswers: [''] }
  ];
  assert.deepEqual(drafts.progress(rows), { answeredCount: 1, answerProgressPercent: 33, pageQuestionCount: 3 });
  rows[0].draftAnswers[1] = '二';
  assert.equal(drafts.progress(rows).answeredCount, 2);
});

test('页面只接受当前可访问题目输入，背诵、未知和权限题事件不污染进度', () => {
  const { store } = makeStore('validation-user');
  const page = { data: { mode: 'writing', questions: [{ id: 'valid', stem: '{{0}}', answers: ['答'] }, { id: 'restricted', unavailable: true, stem: '{{0}}' }] } };
  assert.equal(drafts.acceptInput(page, { detail: { id: 'unknown', values: ['答'] } }, store), null);
  assert.equal(drafts.acceptInput(page, { detail: { id: 'restricted', values: ['答'] } }, store), null);
  const update = drafts.acceptInput(page, { detail: { id: 'valid', values: ['自填'], completed: false } }, store);
  assert.equal(update.answeredCount, 1);
  assert.deepEqual(update.questions[0].draftAnswers, ['自填']);
  page.data.mode = 'reciting';
  assert.equal(drafts.acceptInput(page, { detail: { id: 'valid', values: ['答案泄露'] } }, store), null);
});

test('缓存组题目中的他人draftAnswers不会被当成当前账号的答案恢复', () => {
  const { store } = makeStore('cache-user');
  const rows = drafts.decorate([{ id: 'cache-question', stem: '{{0}}', answers: ['答'], draftAnswers: ['其他账号答案'] }], store);
  assert.deepEqual(rows[0].draftAnswers, ['']);
  assert.equal(drafts.progress(rows).answeredCount, 0);
});

test('题库改版后同一题的草稿按发布修订隔离，旧轮次仍能恢复自己的输入', () => {
  const { store, saved } = makeStore('revision-draft-user');
  const original = { id: 'revision-question', revision: 1, stem: '{{0}}', answers: ['旧答案'] };
  store.save(original, ['旧版输入']);
  const updated = { ...original, revision: 2, answers: ['新版答案'] };
  assert.deepEqual(store.read(updated), ['']);
  store.save(updated, ['新版输入']);
  assert.deepEqual(store.read(original), ['旧版输入']);
  assert.deepEqual(store.read(updated), ['新版输入']);
  assert.equal(saved.size, 2);
});

test('所有已发布修订均不继承无版本草稿，本地无修订题目保持兼容', () => {
  const { store } = makeStore('legacy-revision-draft-user');
  const local = { id: 'legacy-revision-question', stem: '{{0}}', answers: ['答案'] };
  store.save(local, ['无法确定内容版本的输入']);
  for (const revision of [1, 2, 20]) {
    assert.deepEqual(store.read({ ...local, revision }), ['']);
  }
  assert.deepEqual(store.read(local), ['无法确定内容版本的输入']);
});

test('学习状态版本变化不影响相同内容修订的草稿，重建store从持久化记录恢复', () => {
  const fixture = makeStore('state-version-draft-user');
  const question = { id: 'state-version-question', revision: 3, version: 1, stem: '{{0}}', answers: ['答案'] };
  fixture.store.save(question, ['保留输入']);
  assert.deepEqual(fixture.store.read({ ...question, version: 8 }), ['保留输入']);
  const persisted = new Map([...fixture.saved.entries()].map(([key, values]) => [
    key.replace('user-state-version-draft-user', 'user-reloaded-revision-draft-user'), values
  ]));
  const restored = drafts.createStore(
    { getSession: () => ({ user: { id: 'reloaded-revision-draft-user' } }) },
    { getStorageSync: key => persisted.get(key) }
  );
  assert.deepEqual(restored.read(question), ['保留输入']);
  assert.deepEqual(restored.read({ ...question, revision: 4 }), ['']);
});

test('清空当前页只清除可答题目的持久化草稿并重算本页进度', () => {
  const { store } = makeStore('clear-page-user');
  const first = { id: 'clear-page-first', stem: '{{0}} 和 {{1}}', answers: ['甲', '乙'], draftAnswers: ['作答', '完成'] };
  const second = { id: 'clear-page-second', type: 'translation', stem: '原文', answers: ['译文'], draftAnswers: ['已翻译'] };
  const locked = { id: 'clear-page-locked', stem: '{{0}}', answers: ['答案'], draftAnswers: ['保留'], locked: true };
  store.save(first, first.draftAnswers);
  store.save(second, second.draftAnswers);
  store.save(locked, locked.draftAnswers);
  const page = { data: { mode: 'writing', questions: [first, second, locked] } };

  const update = drafts.clearPage(page, store);

  assert.deepEqual(update.questions[0].draftAnswers, ['', '']);
  assert.deepEqual(update.questions[1].draftAnswers, ['']);
  assert.deepEqual(update.questions[2].draftAnswers, ['保留']);
  assert.equal(update.answeredCount, 0);
  assert.equal(update.answerProgressPercent, 0);
  assert.deepEqual(store.read(first), ['', '']);
  assert.deepEqual(store.read(second), ['']);
  assert.deepEqual(store.read(locked), ['保留']);
});

test('背诵模式不能触发清空草稿', () => {
  const { store } = makeStore('clear-page-reciting-user');
  const question = { id: 'clear-page-reciting', stem: '{{0}}', answers: ['答案'], draftAnswers: ['我的作答'] };
  store.save(question, question.draftAnswers);
  assert.equal(drafts.clearPage({ data: { mode: 'reciting', questions: [question] } }, store), null);
  assert.deepEqual(store.read(question), ['我的作答']);
});

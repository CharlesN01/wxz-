const test = require('node:test');
const assert = require('node:assert/strict');
const { shuffle, chunk, segments, requiredAnswerIndices, normalizeDraftAnswers, answerProgress } = require('../miniprogram/utils/question-utils');
const service = require('../miniprogram/services/data-service');

test('一轮洗牌完整保留题目且不修改输入，末组不补重复题', () => {
  const input = [1, 2, 3, 4, 5, 6, 7];
  const output = shuffle(input, () => 0.25);
  assert.deepEqual(output.slice().sort((a, b) => a - b), input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(chunk(output, 5).map((group) => group.length), [5, 2]);
  assert.deepEqual(chunk([], 5), []);
});

test('背诵展开全部答案，默写不泄露答案', () => {
  const stem = '体例为{{0}}、{{1}}。';
  assert.equal(segments(stem, ['风', '雅'], 'writing').map((part) => part.text).join(''), '体例为____、____。');
  assert.equal(segments(stem, ['风', '雅'], 'reciting').filter((part) => part.isAnswer).length, 2);
});

test('空位保持原始位置和答案索引，重复索引只计算一个必填答案', () => {
  const question = { stem: '先{{1}}再{{0}}，重复{{1}}。', answers: ['甲', '乙'] };
  assert.deepEqual(segments(question.stem, question.answers, 'writing').filter((part) => part.isBlank).map((part) => part.answerIndex), [1, 0, 1]);
  assert.deepEqual(requiredAnswerIndices(question), [0, 1]);
  assert.deepEqual(answerProgress(question, ['甲', '']), { completed: false, filledCount: 1, totalCount: 2 });
  assert.deepEqual(answerProgress(question, ['甲', '乙']), { completed: true, filledCount: 2, totalCount: 2 });
  assert.deepEqual(answerProgress(question, ['甲', '\n  ']), { completed: false, filledCount: 1, totalCount: 2 });
});

test('翻译统一使用一个完整输入，无占位但有答案的题提供独立输入', () => {
  const translation = { type: 'translation', stem: '“原句”翻译为{{0}}', answers: ['译文'] };
  assert.deepEqual(requiredAnswerIndices(translation), [0]);
  assert.deepEqual(normalizeDraftAnswers(translation, ['我的译文\n第二行']), ['我的译文\n第二行']);
  assert.deepEqual(requiredAnswerIndices({ stem: '请解释原句', answers: ['解释'] }), [0]);
  assert.deepEqual(requiredAnswerIndices({ stem: '无答案说明' }), []);
  assert.deepEqual(answerProgress({ stem: '无答案说明' }, []), { completed: false, filledCount: 0, totalCount: 0 });
});

test('稀疏索引按实际空位计数，草稿转换不泄露标准答案', () => {
  const question = { stem: '{{2}}、{{0}}', answers: ['甲', '未使用', '丙'] };
  assert.deepEqual(normalizeDraftAnswers(question, ['写甲']), ['写甲', '', '']);
  assert.deepEqual(answerProgress(question, ['甲', '', '丙']), { completed: true, filledCount: 2, totalCount: 2 });
  assert.deepEqual(normalizeDraftAnswers(question), ['', '', '']);
});

test('两种随机入口题源分离，收藏文言分类能取到对应题型', () => {
  const literature = service.getQuestions({ source: 'literature' });
  const classical = service.getQuestions({ source: 'classical' });
  assert.ok(literature.length > 0 && classical.length > 0);
  assert.ok(literature.every((question) => question.source === 'literature'));
  assert.ok(classical.every((question) => question.source === 'classical'));
  assert.ok(service.getQuestions({ categoryId: 'classical-translation' }).every((question) => question.type === 'translation'));
  assert.equal(service.getQuestions({ articleId: 'guaren', type: 'word' }).length, 0);
});

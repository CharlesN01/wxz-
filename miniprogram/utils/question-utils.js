function shuffle(items, rng) {
  const random = rng || Math.random;
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
    const current = result[i];
    result[i] = result[j];
    result[j] = current;
  }
  return result;
}

function chunk(items, size) {
  const width = Math.max(1, Math.floor(size || 5));
  const groups = [];
  for (let index = 0; index < items.length; index += width) groups.push(items.slice(index, index + width));
  return groups;
}

function segments(stem, answers, mode) {
  return String(stem || '').split(/(\{\{\d+\}\})/g).filter(Boolean).map((part, index) => {
    const match = /^\{\{(\d+)\}\}$/.exec(part);
    if (!match) return { key: index, text: part, isAnswer: false, isBlank: false };
    const answerIndex = Number(match[1]);
    const answer = (answers || [])[answerIndex];
    const isAnswer = mode === 'reciting' && answer !== undefined && answer !== null && String(answer) !== '';
    return { key: index, text: isAnswer ? `（${answer}）` : '____', isAnswer, isBlank: !isAnswer, answerIndex };
  });
}

// Use placeholder indexes, even when the sentence presents them out of order.
// The complete translation belongs in one expanding input field.
function requiredAnswerIndices(question) {
  const item = question || {};
  if (item.type === 'translation') return [0];
  const matches = String(item.stem || '').match(/\{\{\d+\}\}/g) || [];
  const indices = [...new Set(matches.map((token) => Number(token.slice(2, -2))))].sort((left, right) => left - right);
  return indices.length ? indices : (Array.isArray(item.answers) && item.answers.length ? [0] : []);
}

function normalizeDraftAnswers(question, values) {
  const indices = requiredAnswerIndices(question);
  const length = indices.length ? indices[indices.length - 1] + 1 : 0;
  return Array.from({ length }, (_, index) => values && values[index] !== undefined && values[index] !== null ? String(values[index]) : '');
}

function answerProgress(question, values) {
  const indices = requiredAnswerIndices(question);
  const filledCount = indices.filter((index) => values && String(values[index] === undefined || values[index] === null ? '' : values[index]).trim()).length;
  return { completed: indices.length > 0 && filledCount === indices.length, filledCount, totalCount: indices.length };
}

module.exports = { shuffle, chunk, segments, requiredAnswerIndices, normalizeDraftAnswers, answerProgress };

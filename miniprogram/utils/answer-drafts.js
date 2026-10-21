const questionUtils = require('./question-utils');

const STORAGE_PREFIX = 'study-answer-drafts-v1:';
const memory = Object.create(null);

function accountKey(auth) {
  try {
    const session = auth && auth.getSession && auth.getSession();
    if (session && session.user && session.user.id != null) return 'user-' + String(session.user.id);
    const token = auth && auth.getToken && auth.getToken();
    if (token) {
      // Compatibility for a session without user metadata. Never persist the
      // Bearer itself, and keep this fallback separate from anonymous drafts.
      let hash = 2166136261;
      for (let index = 0; index < token.length; index += 1) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return 'session-' + (hash >>> 0).toString(16);
    }
  } catch (_) {}
  return 'guest';
}

function createStore(auth, storage) {
  function keyFor(question) {
    const key = STORAGE_PREFIX + accountKey(auth) + ':' + encodeURIComponent(String(question.id));
    // Published revisions are immutable. Never restore unversioned drafts into
    // remote content, including revision 1; legacy drafts have no proven owner
    // revision. Local mock questions without a revision keep their existing key.
    return question.revision == null ? key : key + ':revision-' + encodeURIComponent(String(question.revision));
  }
  return {
    read(question) {
      const key = keyFor(question);
      let values = memory[key];
      if (!values && storage && typeof storage.getStorageSync === 'function') {
        try {
          const saved = storage.getStorageSync(key);
          if (Array.isArray(saved)) values = saved;
        } catch (_) {}
      }
      return questionUtils.normalizeDraftAnswers(question, values || []);
    },
    save(question, values) {
      const key = keyFor(question);
      const next = questionUtils.normalizeDraftAnswers(question, values);
      memory[key] = next;
      if (storage && typeof storage.setStorageSync === 'function') {
        try { storage.setStorageSync(key, next); } catch (_) {}
      }
      return next.slice();
    }
  };
}

function decorate(questions, store) {
  return (questions || []).map(question => Object.assign({}, question, {
    // Cached remote groups may belong to another user. Only the current
    // account's draft store is trusted for restoring an answer.
    draftAnswers: store.read(question)
  }));
}

function progress(questions) {
  const rows = questions || [];
  const answeredCount = rows.filter(question => !question.unavailable
    && questionUtils.answerProgress(question, question.draftAnswers || []).completed).length;
  return {
    answeredCount,
    answerProgressPercent: rows.length ? Math.round(answeredCount / rows.length * 100) : 0,
    pageQuestionCount: rows.length
  };
}

function acceptInput(page, event, store) {
  const detail = event && event.detail || {};
  if (page.data.mode !== 'writing' || !detail.id || !Array.isArray(detail.values)) return null;
  const question = (page.data.questions || []).find(row => String(row.id) === String(detail.id));
  if (!question || question.unavailable) return null;
  const values = store.save(question, detail.values);
  const questions = page.data.questions.map(row => row === question
    ? Object.assign({}, row, { draftAnswers: values }) : row);
  return Object.assign({ questions }, progress(questions));
}

module.exports = { accountKey, createStore, decorate, progress, acceptInput };

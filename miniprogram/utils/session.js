const STORAGE_KEY = 'student-session-v1';
let memorySession = null;
let memorySessionPersisted = false;

function getSession() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function') {
      const stored = wx.getStorageSync(STORAGE_KEY);
      if (stored && typeof stored === 'object' && typeof stored.token === 'string') {
        memorySession = stored;
        memorySessionPersisted = true;
        return stored;
      }
      if (memorySessionPersisted) {
        memorySession = null;
        memorySessionPersisted = false;
      }
    }
  } catch (_) { /* Keep the in-memory session when storage is unavailable. */ }
  return memorySession;
}

function getToken() {
  const session = getSession();
  return session && session.token ? session.token : '';
}

function saveSession(session) {
  if (!session || typeof session.token !== 'string' || !session.token) {
    throw new TypeError('A non-empty session token is required.');
  }
  memorySession = {
    token: session.token,
    expiresAt: typeof session.expiresAt === 'string' ? session.expiresAt : '',
    user: session.user && typeof session.user === 'object' ? session.user : null
  };
  try {
    if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') {
      wx.setStorageSync(STORAGE_KEY, memorySession);
      memorySessionPersisted = true;
    }
  } catch (_) { memorySessionPersisted = false; /* Session remains available for this process. */ }
  return memorySession;
}

function clearSession() {
  memorySession = null;
  memorySessionPersisted = false;
  try {
    if (typeof wx !== 'undefined' && typeof wx.removeStorageSync === 'function') {
      wx.removeStorageSync(STORAGE_KEY);
    }
  } catch (_) { /* Ignore storage cleanup failures. */ }
}

module.exports = { STORAGE_KEY, getSession, getToken, saveSession, clearSession };

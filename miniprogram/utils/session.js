const STORAGE_KEY = 'student-session-v1';
let memorySession = null;

function getSession() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function') {
      const stored = wx.getStorageSync(STORAGE_KEY);
      if (stored && typeof stored === 'object' && typeof stored.token === 'string') {
        memorySession = stored;
        return stored;
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
    }
  } catch (_) { /* Session remains available for the current app process. */ }
  return memorySession;
}

function clearSession() {
  memorySession = null;
  try {
    if (typeof wx !== 'undefined' && typeof wx.removeStorageSync === 'function') {
      wx.removeStorageSync(STORAGE_KEY);
    }
  } catch (_) { /* Ignore storage cleanup failures. */ }
}

module.exports = { STORAGE_KEY, getSession, getToken, saveSession, clearSession };

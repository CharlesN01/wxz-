const PREFIX = 'chinese-study.content-cache.v1:';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MS = 60 * 1000;

function accountKey(auth) {
  try {
    const session = auth && auth.getSession ? auth.getSession() : null;
    const id = session && session.user && session.user.id;
    return id ? 'user:' + String(id) : 'guest';
  } catch (_) {
    return 'guest';
  }
}

function key(scope, auth, identity) {
  return PREFIX + accountKey(auth) + ':' + String(scope || '') + ':' + String(identity || 'default');
}

function read(scope, auth, identity) {
  if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return null;
  try {
    const value = wx.getStorageSync(key(scope, auth, identity));
    if (!value || typeof value !== 'object' || !value.savedAt || Date.now() - Number(value.savedAt) > TTL_MS) {
      if (value) wx.removeStorageSync(key(scope, auth, identity));
      return null;
    }
    return value.payload === undefined ? null : { payload: value.payload, savedAt: Number(value.savedAt), stale: Date.now() - Number(value.savedAt) > STALE_MS };
  } catch (_) {
    return null;
  }
}

function write(scope, auth, identity, payload) {
  if (payload === undefined) return false;
  if (typeof wx === 'undefined' || typeof wx.setStorageSync !== 'function') return false;
  try {
    wx.setStorageSync(key(scope, auth, identity), { savedAt: Date.now(), payload });
    return true;
  } catch (_) {
    return false;
  }
}

function clear(auth) {
  if (typeof wx === 'undefined' || typeof wx.getStorageInfoSync !== 'function') return;
  try {
    const info = wx.getStorageInfoSync();
    (info.keys || []).filter((item) => item.indexOf(PREFIX + accountKey(auth) + ':') === 0).forEach((item) => wx.removeStorageSync(item));
  } catch (_) {}
}

module.exports = { TTL_MS, STALE_MS, accountKey, read, write, clear };

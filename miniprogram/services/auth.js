const http = require('../utils/http');
const session = require('../utils/session');
const contentCache = require('../utils/content-cache');
const studyStore = require('../utils/study-store');

function getWechatCode() {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || typeof wx.login !== 'function') {
      reject(new http.ApiError({ code: 'WX_LOGIN_UNAVAILABLE', message: 'wx.login is unavailable.' }));
      return;
    }
    wx.login({
      success(result) {
        if (result && result.code) resolve(result.code);
        else reject(new http.ApiError({ code: 'WECHAT_CODE_INVALID', message: 'WeChat did not return a login code.' }));
      },
      fail(error) {
        reject(new http.ApiError({
          code: 'WX_LOGIN_FAILED',
          message: error && error.errMsg ? error.errMsg : 'WeChat login failed.'
        }));
      }
    });
  });
}

async function login() {
  const code = await getWechatCode();
  const result = await http.request({
    path: http.API_PREFIX + '/auth/wechat/',
    method: 'POST',
    data: { code },
    auth: false,
    retryAuth: false
  });
  session.saveSession(result);
  return result;
}

async function refreshSession() {
  session.clearSession();
  return login();
}

function wechatSessionValid() {
  return new Promise((resolve) => {
    if (typeof wx === 'undefined' || typeof wx.checkSession !== 'function') {
      resolve(false);
      return;
    }
    wx.checkSession({ success: () => resolve(true), fail: () => resolve(false) });
  });
}

// Before a virtual payment the backend signs with the session_key captured at
// the last wx.login. WeChat validates that signature against the session_key it
// still holds for the user, which can expire independently while our 7-day
// token is still valid. Re-login whenever the local token is missing or the
// WeChat session has lapsed, so the key the backend signs with matches WeChat's.
async function ensureFreshSession() {
  if (!session.getToken()) return login();
  if (await wechatSessionValid()) return session.getSession();
  return refreshSession();
}

async function logout() {
  const token = session.getToken();
  try {
    if (token) {
      await http.request({
        path: http.API_PREFIX + '/auth/logout/',
        method: 'POST',
        data: {},
        auth: true,
        retryAuth: false
      });
    }
  } finally {
    contentCache.clear({ getSession: session.getSession });
    if (studyStore.clear) studyStore.clear();
    session.clearSession();
  }
}

module.exports = { login, logout, refreshSession, ensureFreshSession };

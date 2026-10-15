const http = require('../utils/http');
const session = require('../utils/session');

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
    session.clearSession();
  }
}

module.exports = { login, logout, refreshSession };

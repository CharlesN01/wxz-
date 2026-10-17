const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8000';
const PRODUCTION_API_BASE_URL = 'https://zsbzy.com';
let configuredBaseUrl = '';

function normalizeBaseUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/i.test(url)) {
    throw new TypeError('API base URL must be an http(s) URL without credentials, query, or hash.');
  }
  return url;
}

function setApiBaseUrl(value) {
  configuredBaseUrl = normalizeBaseUrl(value);
  return configuredBaseUrl;
}

function getApiBaseUrl() {
  try {
    if (typeof wx !== 'undefined' && typeof wx.getExtConfigSync === 'function') {
      const extConfig = wx.getExtConfigSync() || {};
      if (extConfig.apiBaseUrl) return normalizeBaseUrl(extConfig.apiBaseUrl);
    }
  } catch (_) { /* Ignore unavailable or malformed optional extension config. */ }
  if (configuredBaseUrl) return configuredBaseUrl;
  try {
    if (typeof wx !== 'undefined' && typeof wx.getAccountInfoSync === 'function') {
      const account = wx.getAccountInfoSync() || {};
      const envVersion = account.miniProgram && account.miniProgram.envVersion;
      if (envVersion === 'trial' || envVersion === 'release') return PRODUCTION_API_BASE_URL;
    }
  } catch (_) { /* Use the local-development URL when environment metadata is unavailable. */ }
  return DEFAULT_API_BASE_URL;
}

function resetApiBaseUrl() {
  configuredBaseUrl = '';
}

module.exports = { DEFAULT_API_BASE_URL, PRODUCTION_API_BASE_URL, getApiBaseUrl, setApiBaseUrl, resetApiBaseUrl };

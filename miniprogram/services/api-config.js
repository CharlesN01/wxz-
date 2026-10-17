const DEFAULT_API_BASE_URL = 'https://zsbzy.com';
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
  } catch (_) { /* Use the explicit or local-development URL when no ext config exists. */ }
  return configuredBaseUrl || DEFAULT_API_BASE_URL;
}

function resetApiBaseUrl() {
  configuredBaseUrl = '';
}

module.exports = { DEFAULT_API_BASE_URL, getApiBaseUrl, setApiBaseUrl, resetApiBaseUrl };

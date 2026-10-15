const session = require('./session');
const apiConfig = require('../services/api-config');

let refreshPromise = null;

const API_PREFIX = '/api/student/v1';

class ApiError extends Error {
  constructor(details) {
    super(details.message || details.code || 'Request failed.');
    this.name = 'ApiError';
    this.status = details.status || 0;
    this.code = details.code || 'REQUEST_FAILED';
    this.requestId = details.requestId || '';
    this.fields = details.fields || {};
    this.current = details.current !== undefined ? details.current : this.fields.current;
    this.network = Boolean(details.network);
  }
}

function createIdempotencyKey() {
  const random = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return ('wx-' + Date.now().toString(36) + '-' + random).slice(0, 96);
}

function joinBaseUrl(path, basePath) {
  const base = apiConfig.getApiBaseUrl();
  const target = String(path || '');
  if (/^https?:\/\//i.test(target)) {
    if (getOrigin(target) !== getOrigin(base)) {
      throw new ApiError({ code: 'INVALID_API_URL', message: 'Pagination URL must use the configured API host.' });
    }
    return target;
  }
  if (target.charAt(0) === '?') {
    if (!basePath) throw new ApiError({ code: 'INVALID_API_URL', message: 'A relative query URL requires its original request path.' });
    return joinBaseUrl(basePath) + target;
  }
  const normalized = target.charAt(0) === '/' ? target : '/' + target;
  return base + normalized;
}

function getOrigin(url) {
  const match = /^([a-z]+:\/\/[^/]+)/i.exec(String(url || ''));
  return match ? match[1].toLowerCase() : '';
}

function getRequestId(data, headers) {
  const responseId = data && data.requestId;
  if (responseId) return String(responseId);
  const source = headers || {};
  const key = Object.keys(source).find((name) => name.toLowerCase() === 'x-request-id');
  return key ? String(source[key] || '') : '';
}

function toApiError(response) {
  const data = response && response.data;
  const body = data && typeof data === 'object' ? data : {};
  const error = body.error && typeof body.error === 'object' ? body.error : {};
  const fields = error.fields || body.fields || {};
  return new ApiError({
    status: response ? response.statusCode : 0,
    code: error.code || body.code || 'HTTP_ERROR',
    message: error.message || body.message || 'The server could not complete the request.',
    requestId: getRequestId(body, response && response.header),
    fields,
    current: fields.current !== undefined ? fields.current : error.current
  });
}

function wxRequest(options) {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || typeof wx.request !== 'function') {
      reject(new ApiError({ code: 'WX_REQUEST_UNAVAILABLE', message: 'wx.request is unavailable.' }));
      return;
    }
    wx.request({
      url: options.url,
      method: options.method,
      data: options.data,
      header: options.header,
      timeout: options.timeout,
      success: resolve,
      fail(error) {
        reject(new ApiError({
          code: 'NETWORK_ERROR',
          message: error && error.errMsg ? error.errMsg : 'Network request failed.',
          network: true
        }));
      }
    });
  });
}

function buildHeaders(options) {
  const headers = Object.assign({ 'content-type': 'application/json' }, options.headers || {});
  Object.keys(headers).forEach((key) => {
    if (key.toLowerCase() === 'authorization') delete headers[key];
  });
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const shouldAttach = options.auth === true || options.auth === 'optional';
  const token = shouldAttach ? session.getToken() : '';
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

async function perform(options, authRetried) {
  let response;
  try {
    response = await wxRequest({
      url: options.url,
      method: options.method,
      data: options.data,
      header: buildHeaders(options),
      timeout: options.timeout
    });
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError({ code: 'NETWORK_ERROR', message: 'Network request failed.', network: true });
  }
  const status = Number(response && response.statusCode) || 0;
  if (status >= 200 && status < 300) return status === 204 ? null : response.data;

  const apiError = toApiError(response);
  const canRefresh = options.auth === true || (options.auth === 'optional' && Boolean(session.getToken()));
  if (status === 401 && canRefresh && options.retryAuth !== false && !authRetried) {
    try {
      const auth = require('../services/auth');
      if (!refreshPromise) {
        refreshPromise = Promise.resolve().then(() => auth.refreshSession()).finally(() => {
          refreshPromise = null;
        });
      }
      await refreshPromise;
    } catch (_) {
      session.clearSession();
      throw apiError;
    }
    return perform(options, true);
  }
  if (status === 401 && authRetried) session.clearSession();
  throw apiError;
}

function request(options) {
  const input = options || {};
  const method = String(input.method || 'GET').toUpperCase();
  const suppliedData = input.data || {};
  const data = method === 'GET' || method === 'HEAD'
    ? Object.assign({}, input.query || {}, suppliedData)
    : suppliedData;
  let url;
  try {
    url = joinBaseUrl(input.path, input.basePath);
  } catch (error) {
    return Promise.reject(error);
  }
  const normalized = {
    url,
    method,
    data,
    headers: input.headers || {},
    basePath: input.basePath || '',
    auth: input.auth === undefined ? false : input.auth,
    retryAuth: input.retryAuth,
    idempotencyKey: input.idempotencyKey || '',
    timeout: input.timeout
  };
  return perform(normalized, false);
}

module.exports = { API_PREFIX, ApiError, createIdempotencyKey, request, toApiError };

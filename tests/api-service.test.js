const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../miniprogram/services/api');
const apiConfig = require('../miniprogram/services/api-config');
const session = require('../miniprogram/utils/session');
const http = require('../miniprogram/utils/http');

function installWx(handler) {
  const calls = [];
  global.wx = {
    request(options) {
      calls.push(options);
      handler(options, calls.length - 1);
    },
    login(options) { options.success({ code: 'one-time-code' }); },
    getStorageSync() { return this.session || null; },
    setStorageSync(key, value) { this.session = value; },
    removeStorageSync() { this.session = null; }
  };
  return calls;
}

function respond(options, statusCode, data, header) {
  options.success({ statusCode, data, header: header || {} });
}

test.beforeEach(() => {
  session.clearSession();
  api.setApiBaseUrl('http://127.0.0.1:8000');
});

test.afterEach(() => {
  delete global.wx;
});

test('removing a persisted session from storage clears the in-memory session', () => {
  global.wx = {
    session: null,
    getStorageSync() { return this.session; },
    setStorageSync(_key, value) { this.session = value; },
    removeStorageSync() { this.session = null; }
  };

  session.saveSession({ token: 'stored-token', expiresAt: '' });
  global.wx.removeStorageSync(session.STORAGE_KEY);

  assert.equal(session.getSession(), null);
  assert.equal(session.getToken(), '');
});

test('an in-memory session remains available when persistence fails', () => {
  global.wx = {
    getStorageSync() { return null; },
    setStorageSync() { throw new Error('storage unavailable'); }
  };

  session.saveSession({ token: 'memory-token', expiresAt: '' });

  assert.equal(session.getToken(), 'memory-token');
});

test('public content request is anonymous and uses the configured API prefix', async () => {
  session.saveSession({ token: 'stored-token', expiresAt: '' });
  const calls = installWx((options) => respond(options, 200, { results: [] }));
  const result = await api.content.questions({ source: 'literature', page: 2 });
  assert.deepEqual(result, { results: [] });
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/api/student/v1/questions/');
  assert.deepEqual(calls[0].data, { source: 'literature', page: 2 });
  assert.equal(calls[0].header.Authorization, undefined);
});

test('content requests can opt into the Bearer contract for activated learners', async () => {
  session.saveSession({ token: 'activated-token', expiresAt: '' });
  const calls = installWx((options) => respond(options, 200, { results: [] }));
  await api.content.questions({ source: 'classical', articleId: 'quanxue', page: 1 }, { auth: true });
  assert.equal(calls[0].header.Authorization, 'Bearer activated-token');
});

test('app extension configuration overrides the configured API origin', async () => {
  const calls = installWx((options) => respond(options, 200, { pageSize: 20 }));
  global.wx.getExtConfigSync = () => ({ apiBaseUrl: 'https://student-api.example' });
  await api.config.get();
  assert.equal(calls[0].url, 'https://student-api.example/api/student/v1/config/');
  assert.throws(() => api.setApiBaseUrl('https://user:secret@example.test'), /without credentials/);
  delete global.wx.getExtConfigSync;
  api.setApiBaseUrl('https://student-api.example/backend');
  assert.equal(api.getApiBaseUrl(), 'https://student-api.example/backend');
});

test('trial and release builds use the production API when no extension override exists', () => {
  apiConfig.resetApiBaseUrl();
  global.wx = {
    getAccountInfoSync() { return { miniProgram: { envVersion: 'trial' } }; }
  };
  assert.equal(api.getApiBaseUrl(), 'https://zsbzy.com');
  global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'release' } });
  assert.equal(api.getApiBaseUrl(), 'https://zsbzy.com');
});

test('development builds use the public API when no extension override exists', () => {
  apiConfig.resetApiBaseUrl();
  global.wx = {
    getAccountInfoSync() { return { miniProgram: { envVersion: 'develop' } }; }
  };
  assert.equal(api.getApiBaseUrl(), 'https://zsbzy.com');
});

test('explicit API configuration overrides the environment default', () => {
  apiConfig.resetApiBaseUrl();
  api.setApiBaseUrl('https://qa-api.example');
  global.wx = {
    getAccountInfoSync() { return { miniProgram: { envVersion: 'release' } }; }
  };
  assert.equal(api.getApiBaseUrl(), 'https://qa-api.example');
});

test('production environment fallback still applies when extension config is unavailable', () => {
  apiConfig.resetApiBaseUrl();
  global.wx = {
    getExtConfigSync() { throw new Error('extension config unavailable'); },
    getAccountInfoSync() { return { miniProgram: { envVersion: 'release' } }; }
  };
  assert.equal(api.getApiBaseUrl(), 'https://zsbzy.com');
});

test('private writes preserve baseVersion and attach Bearer plus an idempotency key', async () => {
  session.saveSession({ token: 'test-session-token', expiresAt: '2030-01-01T00:00:00Z' });
  const calls = installWx((options) => respond(options, 200, { questionId: 'q-1', version: 2 }));
  const result = await api.learning.setQuestionState('q-1', { favorite: true, baseVersion: 1 }, { idempotencyKey: 'state-action-1' });
  assert.deepEqual(result, { questionId: 'q-1', version: 2 });
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/api/student/v1/me/questions/q-1/state/');
  assert.deepEqual(calls[0].data, { favorite: true, baseVersion: 1 });
  assert.equal(calls[0].header.Authorization, 'Bearer test-session-token');
  assert.equal(calls[0].header['Idempotency-Key'], 'state-action-1');
});

test('409 errors expose the current server version and request id', async () => {
  installWx((options) => respond(options, 409, {
    error: { code: 'VERSION_CONFLICT', message: 'conflict', fields: { current: { version: 3 } } },
    requestId: 'req-409'
  }));
  await assert.rejects(api.learning.setQuestionState('q-1', { mastered: true, baseVersion: 1 }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'VERSION_CONFLICT');
    assert.equal(error.requestId, 'req-409');
    assert.deepEqual(error.current, { version: 3 });
    return true;
  });
});

test('403 entitlement errors preserve the session and do not retry anonymously', async () => {
  session.saveSession({ token: 'stored-token', expiresAt: '' });
  const calls = installWx((options) => respond(options, 403, {
    error: { code: 'ENTITLEMENT_REQUIRED', message: 'restricted' }, requestId: 'req-403'
  }));

  await assert.rejects(api.practice.createRound({ source: 'classical', articleId: 'quanxue', mode: 'writing' }), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.code, 'ENTITLEMENT_REQUIRED');
    assert.equal(error.requestId, 'req-403');
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(session.getToken(), 'stored-token');
});

test('practice round creation matches the authenticated idempotent contract', async () => {
  session.saveSession({ token: 'practice-token', expiresAt: '' });
  const calls = installWx((options) => respond(options, 201, {
    id: 'round-1',
    source: 'classical',
    categoryId: null,
    articleId: 'quanxue',
    type: 'translation',
    mode: 'reciting'
  }));
  const payload = {
    source: 'classical',
    categoryId: null,
    articleId: 'quanxue',
    type: 'translation',
    mode: 'reciting'
  };

  const result = await api.practice.createRound(payload);

  assert.equal(result.id, 'round-1');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/api/student/v1/practice/rounds/');
  assert.deepEqual(calls[0].data, payload);
  assert.equal(calls[0].header.Authorization, 'Bearer practice-token');
  assert.match(calls[0].header['Idempotency-Key'], /^[A-Za-z0-9._:-]{8,128}$/);
});

test('practice group reads use a 1-based encoded path without query parameters', async () => {
  session.saveSession({ token: 'practice-token', expiresAt: '' });
  const calls = installWx((options) => respond(options, 200, { groupIndex: 2, results: [] }));

  const result = await api.practice.group('round/1', 2);

  assert.deepEqual(result, { groupIndex: 2, results: [] });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/api/student/v1/practice/rounds/round%2F1/groups/2/');
  assert.deepEqual(calls[0].data, {});
  assert.equal(calls[0].header.Authorization, 'Bearer practice-token');
  assert.equal(calls[0].header['Idempotency-Key'], undefined);
});

test('429 and 5xx responses retain structured errors and request IDs', async () => {
  let status = 429;
  const calls = installWx((options) => respond(options, status, {
    error: { code: status === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR', message: 'temporary error' },
    requestId: 'req-' + status
  }));

  await assert.rejects(api.learning.statistics(), (error) => error.status === 429 && error.code === 'RATE_LIMITED' && error.requestId === 'req-429');
  status = 503;
  await assert.rejects(api.learning.statistics(), (error) => error.status === 503 && error.code === 'INTERNAL_ERROR' && error.requestId === 'req-503');
  assert.equal(calls.length, 2);
});

test('network failures become explicit retryable network errors', async () => {
  const calls = installWx((options) => options.fail({ errMsg: 'request:fail timeout' }));

  await assert.rejects(api.learning.resume(), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.network, true);
    assert.equal(error.message, 'request:fail timeout');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('401 refresh logs in without Bearer and retries the original request once', async () => {
  session.saveSession({ token: 'expired-token', expiresAt: '' });
  const calls = installWx((options) => {
    if (options.url.endsWith('/auth/wechat/')) {
      assert.equal(options.header.Authorization, undefined);
      assert.deepEqual(options.data, { code: 'one-time-code' });
      respond(options, 200, { token: 'fresh-token', expiresAt: '2030-01-01T00:00:00Z', user: { id: 1 } });
    } else if (options.header.Authorization === 'Bearer expired-token') {
      respond(options, 401, { error: { code: 'INVALID_TOKEN', message: 'expired' }, requestId: 'first-401' });
    } else {
      respond(options, 200, { active: true });
    }
  });
  assert.deepEqual(await api.entitlements.current(), { active: true });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].header.Authorization, 'Bearer expired-token');
  assert.equal(calls[2].header.Authorization, 'Bearer fresh-token');
  assert.equal(session.getToken(), 'fresh-token');
});

test('a second 401 ends the single retry and clears the session', async () => {
  session.saveSession({ token: 'expired-token', expiresAt: '' });
  const calls = installWx((options) => {
    if (options.url.endsWith('/auth/wechat/')) {
      respond(options, 200, { token: 'fresh-token', expiresAt: '', user: { id: 1 } });
    } else {
      respond(options, 401, { error: { code: 'INVALID_TOKEN', message: 'still invalid' } });
    }
  });
  await assert.rejects(api.learning.statistics(), (error) => error.status === 401);
  assert.equal(calls.length, 3);
  assert.equal(session.getToken(), '');
});

test('concurrent 401 requests share one session refresh', async () => {
  session.saveSession({ token: 'expired-token', expiresAt: '' });
  let loginCount = 0;
  let privateCount = 0;
  global.wx = {
    request(options) {
      if (options.url.endsWith('/auth/wechat/')) {
        loginCount += 1;
        setTimeout(() => respond(options, 200, { token: 'fresh-token', expiresAt: '', user: { id: 1 } }), 0);
        return;
      }
      privateCount += 1;
      const token = options.header.Authorization;
      setTimeout(() => respond(options, token === 'Bearer expired-token' ? 401 : 200, token === 'Bearer expired-token'
        ? { error: { code: 'INVALID_TOKEN', message: 'expired' } }
        : { active: true }), 0);
    },
    login(options) { options.success({ code: 'one-time-code' }); },
    getStorageSync() { return this.session || null; },
    setStorageSync(key, value) { this.session = value; },
    removeStorageSync() { this.session = null; }
  };
  const results = await Promise.all([api.entitlements.current(), api.learning.statistics()]);
  assert.deepEqual(results, [{ active: true }, { active: true }]);
  assert.equal(loginCount, 1);
  assert.equal(privateCount, 4);
  assert.equal(session.getToken(), 'fresh-token');
});

test('payment argument adapter preserves signed data as an opaque string', () => {
  const signData = '{"offerId":"x","env":0,"productId":"p"}';
  const args = api.payment.toVirtualPaymentArgs({ mode: 'short_series_goods', signData, paySig: 'pay-sig', signature: 'sig' });
  assert.deepEqual(args, { mode: 'short_series_goods', signData, paySig: 'pay-sig', signature: 'sig' });
  assert.equal(api.payment.toVirtualPaymentArgs(null), null);
});

test('server pagination URLs are restricted to the configured host', async () => {
  const calls = installWx((options) => respond(options, 200, { results: [2] }));
  await api.pagination.follow('http://127.0.0.1:8000/api/student/v1/questions/?page=2');
  assert.equal(calls.length, 1);
  await api.pagination.follow('?page=3', { basePath: '/api/student/v1/questions/' });
  assert.equal(calls[1].url, 'http://127.0.0.1:8000/api/student/v1/questions/?page=3');
  await assert.rejects(api.pagination.follow('https://other.example/api/student/v1/questions/?page=2'), (error) => error.code === 'INVALID_API_URL');
});

test('generated idempotency keys satisfy the API character and length contract', () => {
  const key = http.createIdempotencyKey();
  assert.ok(key.length >= 8 && key.length <= 128);
  assert.match(key, /^[A-Za-z0-9._:-]+$/);
});

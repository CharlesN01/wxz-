const http = require('../utils/http');
const config = require('./api-config');
const authService = require('./auth');

const ROOT = http.API_PREFIX;

function encodeId(id) {
  if (id === undefined || id === null || String(id) === '') throw new TypeError('A resource id is required.');
  return encodeURIComponent(String(id));
}

function query(method, path, params, options) {
  const opts = options || {};
  return http.request({
    method,
    path,
    query: params || {},
    auth: opts.auth === undefined ? false : opts.auth,
    headers: opts.headers,
    timeout: opts.timeout
  });
}

function write(method, path, body, options) {
  const opts = options || {};
  const key = opts.idempotencyKey || http.createIdempotencyKey();
  return http.request({
    method,
    path,
    data: body === undefined ? {} : body,
    auth: opts.auth === undefined ? true : opts.auth,
    idempotencyKey: key,
    retryAuth: opts.retryAuth,
    headers: opts.headers,
    timeout: opts.timeout
  });
}

const api = {
  setApiBaseUrl: config.setApiBaseUrl,
  getApiBaseUrl: config.getApiBaseUrl,
  createIdempotencyKey: http.createIdempotencyKey,
  request: http.request,
  ApiError: http.ApiError,

  auth: {
    login: authService.login,
    logout: authService.logout,
    getSession: require('../utils/session').getSession,
    getToken: require('../utils/session').getToken
  },

  config: {
    get: (options) => query('GET', ROOT + '/config/', null, options)
  },

  content: {
    categories: (params, options) => query('GET', ROOT + '/categories/', params, options),
    articles: (params, options) => query('GET', ROOT + '/articles/', params, Object.assign({ auth: 'optional' }, options || {})),
    questions: (params, options) => query('GET', ROOT + '/questions/', params, Object.assign({ auth: 'optional' }, options || {})),
    question: (id, options) => query('GET', ROOT + '/questions/' + encodeId(id) + '/', null, Object.assign({ auth: 'optional' }, options || {})),
    writings: (params, options) => query('GET', ROOT + '/writings/', params, Object.assign({ auth: 'optional' }, options || {})),
    writing: (id, options) => query('GET', ROOT + '/writings/' + encodeId(id) + '/', null, Object.assign({ auth: 'optional' }, options || {}))
  },

  learning: {
    questionState: (id, options) => query('GET', ROOT + '/me/questions/' + encodeId(id) + '/state/', null, Object.assign({ auth: true }, options || {})),
    setQuestionState: (id, data, options) => write('PUT', ROOT + '/me/questions/' + encodeId(id) + '/state/', data, options),
    statistics: (options) => query('GET', ROOT + '/me/statistics/', null, Object.assign({ auth: true }, options || {})),
    studyTime: (data, options) => write('POST', ROOT + '/me/study-time/', data, options),
    resume: (options) => query('GET', ROOT + '/me/resume/', null, Object.assign({ auth: true }, options || {})),
    saveResume: (data, options) => write('PUT', ROOT + '/me/resume/', data, options),
    preferences: (options) => query('GET', ROOT + '/me/preferences/', null, Object.assign({ auth: true }, options || {})),
    savePreferences: (data, options) => write('PUT', ROOT + '/me/preferences/', data, options),
    favorites: (params, options) => query('GET', ROOT + '/me/favorites/', params, Object.assign({ auth: true }, options || {}))
  },

  practice: {
    createRound: (data, options) => write('POST', ROOT + '/practice/rounds/', data, options),
    group: (roundId, groupIndex, options) => query('GET', ROOT + '/practice/rounds/' + encodeId(roundId) + '/groups/' + encodeURIComponent(String(groupIndex)) + '/', null, Object.assign({ auth: true }, options || {}))
  },

  products: {
    list: (options) => query('GET', ROOT + '/products/', null, options)
  },

  entitlements: {
    current: (options) => query('GET', ROOT + '/me/entitlements/', null, Object.assign({ auth: true }, options || {}))
  },

  orders: {
    list: (params, options) => query('GET', ROOT + '/orders/', params, Object.assign({ auth: true }, options || {})),
    detail: (id, options) => query('GET', ROOT + '/orders/' + encodeId(id) + '/', null, Object.assign({ auth: true }, options || {})),
    create: (data, options) => write('POST', ROOT + '/orders/', data, options),
    preparePayment: (id, options) => write('POST', ROOT + '/orders/' + encodeId(id) + '/payment/', {}, options),
    queryPayment: (id, options) => write('POST', ROOT + '/orders/' + encodeId(id) + '/query/', {}, options)
    ,revealActivationCode: (id, options) => write('POST', ROOT + '/orders/' + encodeId(id) + '/activation-code/reveal/', {}, options)
  },

  activation: {
    redeem: (code, options) => write('POST', ROOT + '/activation/redeem/', { code }, options)
  },

  feedback: {
    submit: (data, options) => write('POST', ROOT + '/feedback/', data, options)
  },

  resources: {
    group: (options) => query('GET', ROOT + '/resources/group/', null, options)
  },

  pagination: {
    follow(url, options) {
      const opts = options || {};
      return http.request({
        method: 'GET',
        path: url,
        basePath: opts.basePath,
        auth: opts.auth === undefined ? false : opts.auth,
        headers: opts.headers,
        timeout: opts.timeout
      });
    }
  },

  payment: {
    toVirtualPaymentArgs(packet) {
      if (!packet) return null;
      return {
        mode: packet.mode,
        signData: packet.signData,
        paySig: packet.paySig,
        signature: packet.signature
      };
    }
  }
};

// Stable page-facing aliases keep page code independent from the domain grouping above.
Object.assign(api, {
  login: api.auth.login,
  logout: api.auth.logout,
  getConfig: api.config.get,
  getCategories: api.content.categories,
  getArticles: api.content.articles,
  getQuestions: api.content.questions,
  getQuestion: api.content.question,
  getWritings: api.content.writings,
  getWriting: api.content.writing,
  getQuestionState: api.learning.questionState,
  updateQuestionState: api.learning.setQuestionState,
  getStatistics: api.learning.statistics,
  getResume: api.learning.resume,
  saveResume: api.learning.saveResume,
  getPreferences: api.learning.preferences,
  savePreferences: api.learning.savePreferences,
  getFavorites: api.learning.favorites,
  createPracticeRound: api.practice.createRound,
  getPracticeGroup: api.practice.group,
  getProducts: api.products.list,
  getEntitlement: api.entitlements.current,
  getOrders: api.orders.list,
  getOrder: api.orders.detail,
  createOrder: api.orders.create,
  preparePayment: api.orders.preparePayment,
  queryPayment: api.orders.queryPayment,
  revealActivationCode: api.orders.revealActivationCode,
  redeemActivationCode: api.activation.redeem,
  submitFeedback: api.feedback.submit,
  getGroupResources: api.resources.group
});

module.exports = api;

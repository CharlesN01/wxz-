const SHARE_TITLE = '文常记｜山东专升本语文';
const SHARE_PATH = '/pages/home/index';
const SHARE_IMAGE = '/assets/share-cover.png';
function shareAppMessage() { return { title: SHARE_TITLE, path: SHARE_PATH, imageUrl: SHARE_IMAGE }; }
function shareTimeline() { return { title: SHARE_TITLE, query: '', imageUrl: SHARE_IMAGE }; }
const { withStudyTime } = require('../../utils/study-timer');
const api = require('../../services/api');
const navigation = require('../../utils/navigation');
const safeTop = require('../../utils/safe-top');
const UI_PAGE_SIZE = 6;
const questionUtils = require('../../utils/question-utils');
const answerDrafts = require('../../utils/answer-drafts');

let tabletSheet = null;
try { tabletSheet = require('../../utils/tablet-answer-sheet'); } catch (_) {}
tabletSheet = tabletSheet || { viewport: () => null, resizedViewport: () => null, pageSize: () => UI_PAGE_SIZE, isTablet: () => false };
let contentCache = { read: () => null, write: () => false };
try {
  const loadedCache = require('../../utils/content-cache');
  if (loadedCache && typeof loadedCache.read === 'function') contentCache = loadedCache;
} catch (_) { /* test shells may omit optional cache */ }
const SOURCE = 'literature';
function currentTheme() { try { return wx.getStorageSync('chinese-study.theme') === 'night' ? 'night' : 'day'; } catch (_) { return 'day'; } }

function settle(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
}

function hasToken() {
  try {
    return Boolean(api.auth && api.auth.getToken && api.auth.getToken());
  } catch (_) {
    return false;
  }
}

function isMode(value) {
  return value === 'reciting' ? 'reciting' : 'writing';
}

function describeError(error, fallback) {
  if (error && error.code === 'NETWORK_ERROR') return '网络暂不可用，请检查连接后重试';
  if (error && error.code === 'ENTITLEMENT_REQUIRED') return '当前内容需要先开通学习权益';
  if (error && error.code === 'INVALID_TOKEN') return '登录状态已失效，请重新登录';
  return error && error.message ? String(error.message) : fallback;
}

function displayCategoryName(category) {
  const item = category || {};
  const known = {
    'pre-qin': '先秦',
    'qin-han': '秦汉',
    'wei-jin': '六朝',
    'six-dynasties': '六朝',
    tang: '唐代',
    song: '宋代',
    'yuan-ming-qing': '元明清',
    modern: '现当代',
    foreign: '外国文学'
  };
  return known[item.id] || String(item.name || '文学常识').replace(/文学$/, '');
}

function buildParts(question, mode) {
  return questionUtils.segments(question.stem, question.answers || [], mode).map(part =>
    Object.assign({}, part, { text: part.isAnswer ? part.text.slice(1, -1) : part.text, isFilled: Boolean(part.isAnswer) }));
}

function normalizeState(value) {
  const version = Number(value && value.version);
  return {
    favorite: Boolean(value && value.favorite),
    mastered: Boolean(value && value.mastered),
    version: Number.isFinite(version) && version >= 0 ? version : 0
  };
}

function formatQuestionProgress(startIndex, total) {
  const totalCount = Math.max(0, Number(total) || 0);
  const current = totalCount ? Math.min(totalCount, Math.max(1, Number(startIndex) + 1 || 1)) : 0;
  const format = (value) => String(value).padStart(2, '0');
  return format(current) + ' / ' + format(totalCount);
}

Page(withStudyTime({
  data: {
    theme: 'day',
    loading: true,
    hasError: false,
    errorMessage: '',
    personalError: '',
    categories: [],
    categoryId: '',
    categoryName: '文学常识',
    mode: 'writing',
    questions: [],
    page: 1,
    pageSize: UI_PAGE_SIZE,
    isTablet: false,
    questionProgressLabel: '00 / 00',
    totalQuestions: 0,
    pageCount: 0,
    progressPercent: 0,
    answeredCount: 0,
    answerProgressPercent: 0,
    pageQuestionCount: 0,
    restrictedCount: 0,
    restrictedQuestionCount: 0,
    restrictedPageCount: 0,
    activated: false,
    lockedPage: false,
    membershipVisible: false,
    categoryScrollLeft: 0,
    safeTop: 0,
    isGuest: true,
    canPrevious: false,
    canNext: false
  },

  onLoad(options) {
    this._answerViewport = tabletSheet.viewport(typeof wx === 'undefined' ? null : wx);
    this._options = options || {};
    // These prototype pages have no custom navigation bar; the WeChat viewport
    // already starts below the status bar, so adding a capsule spacer would
    // create a large blank band above the period tabs.
    this.setData({ safeTop: 0 });
    this._questionRequest = 0;
    this._categoryRequests = Object.create(null);
    this._questionPages = {};
    this._loaded = false;
    this._stateMap = {};
    this._pendingState = {};
    this._answerVisible = {};
    this._questionRows = [];
    this._draftStore = answerDrafts.createStore(api.auth, typeof wx === 'undefined' ? null : wx);
    this._resumeQuestionId = this._options.questionId || '';
    this._resumeVersion = 0;
    this._preferenceVersion = 0;
    this._resumePending = null;
    this._resumeSaving = false;
    this._lastRefreshAt = 0;
    const cached = contentCache.read('literature-first', api.auth, 'v1');
    if (cached && cached.payload && Array.isArray(cached.payload.categories)) {
      const snapshot = cached.payload;
      this._lastRefreshAt = Number(cached.savedAt) || Date.now();
      this._questionRows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
      this._questionPages = {};
      if (snapshot.categoryId) this._questionPages[String(snapshot.categoryId) + ':1'] = {
        rows: this._questionRows,
        count: Number(snapshot.totalQuestions) || this._questionRows.length,
        pageSize: Number(snapshot.apiPageSize) || Math.max(this._questionRows.length, 1),
        activated: Boolean(snapshot.activated),
        freeCount: Number(snapshot.freeCount) || 0,
        restrictedCount: Number(snapshot.restrictedCount) || 0
      };
      this._loaded = true;
      this.setData({ loading: false, categories: snapshot.categories, categoryId: snapshot.categoryId || '',
        categoryName: snapshot.categoryName || '文学常识', mode: snapshot.mode || 'writing',
        questions: Array.isArray(snapshot.questions) ? snapshot.questions : [], page: Number(snapshot.page) || 1,
        pageSize: UI_PAGE_SIZE, totalQuestions: Number(snapshot.totalQuestions) || this._questionRows.length,
        pageCount: Number(snapshot.pageCount) || 0, restrictedCount: Number(snapshot.restrictedCount) || 0,
        questionProgressLabel: snapshot.questionProgressLabel || '00 / 00', progressPercent: Number(snapshot.progressPercent) || 0,
        isGuest: !hasToken() });
    }
    this.bootstrap();
  },

  onShow() {
    this.setData({ theme: currentTheme() });
    if (!this._loaded || this.data.loading) return;
    if (!this._needsRemoteRefresh && this.data.page <= 1 && this.data.restrictedCount <= 0
      && Date.now() - (this._lastRefreshAt || 0) < 60 * 1000) return;
    this._needsRemoteRefresh = false;
    // Returning from membership/activation must refetch the accessible count
    // and pages; refreshing question state alone retains the free-only cache.
    this._questionPages = {};
    this._questionRows = [];
    this._stateMap = {};
    this.setData({ questions: [], restrictedCount: 0, personalError: '', isGuest: !hasToken() });
    return this.loadPage(this.data.page || 1);
  },

  onResize(event) {
    const next = tabletSheet.resizedViewport(typeof wx === 'undefined' ? null : wx, this._answerViewport, event);
    if (!next) return;
    this._answerViewport = next;
    if (this._loaded) return this.loadPage(this.data.page || 1);
  },

  onHide() { this._needsRemoteRefresh = true; },

  async bootstrap() {
    // Start independent reads together; categories must not delay preferences
    // or the saved position by another network round trip.
    const signedIn = hasToken();
    const results = await Promise.all([
      settle(api.content.categories({ page: 1 })),
      signedIn ? settle(api.learning.preferences()) : Promise.resolve({ ok: true, value: null }),
      signedIn ? settle(api.learning.resume()) : Promise.resolve({ ok: true, value: null })
    ]);
    const categoriesResult = results[0];
    if (!categoriesResult.ok) {
      this.setData({
        loading: false,
        hasError: true,
        errorMessage: describeError(categoriesResult.error, '文学分类暂不可用')
      });
      return;
    }

    const categories = categoriesResult.value && Array.isArray(categoriesResult.value.results)
      ? categoriesResult.value.results.map((item) => Object.assign({}, item, { name: displayCategoryName(item) }))
      : [];
    const preference = results[1].ok ? results[1].value : null;
    const resumeSnapshot = results[2].ok ? results[2].value : null;
    const preferenceError = results[1].error;
    const resumeError = results[2].error;

    const mayRestore = this._options.resume === '1' || Boolean(this._options.questionId);
    const resume = resumeSnapshot
      ? (resumeSnapshot.valid ? resumeSnapshot.resume : resumeSnapshot.start)
      : null;
    const requestedCategory = this._options.categoryId || (mayRestore && resume && resume.categoryId);
    const category = categories.find((item) => item.id === requestedCategory) || categories[0];
    const categoryIndex = category ? categories.indexOf(category) : 0;
    const mode = isMode(this._options.mode || (mayRestore && resume && resume.mode) || (preference && preference.mode));
    this._resumeQuestionId = this._options.questionId || (mayRestore && resume && resume.questionId) || '';
    this._resumeVersion = resumeSnapshot && Number(resumeSnapshot.version) >= 0
      ? Number(resumeSnapshot.version)
      : 0;
    this._preferenceVersion = preference && Number(preference.version) >= 0
      ? Number(preference.version)
      : 0;
    // Phone/free pages stay at six; member tablet pages aggregate API pages below.
    this._pageSize = UI_PAGE_SIZE;
    this._loaded = true;
    this.setData({
      categories,
      categoryId: category ? category.id : '',
      categoryName: category ? category.name : '文学常识',
      mode,
      pageSize: this._pageSize,
      categoryScrollLeft: Math.max(0, categoryIndex - 1) * 92,
      isGuest: !hasToken(),
      personalError: preferenceError && resumeError
        ? describeError(preferenceError, '学习记录暂不可用')
        : '',
      hasError: false
    });
    if (!category) {
      this.setData({
        loading: false,
        questions: [],
        totalQuestions: 0,
        pageCount: 0,
        canPrevious: false,
        canNext: false
      });
      return;
    }
    await this.loadPage(1, { findResume: Boolean(this._resumeQuestionId) });
    this.prefetchCategories(categories);
  },

  async loadApiPage(page, requestId, options) {
    options = options || {};
    if (!this._categoryRequests) this._categoryRequests = Object.create(null);
    const categoryId = options.categoryId || this.data.categoryId;
    const cacheKey = categoryId + ':' + page;
    if (this._questionPages[cacheKey] && !options.force) return this._questionPages[cacheKey];
    if (!options.force) {
      const cached = contentCache.read('literature-category', api.auth, cacheKey);
      if (cached && cached.payload && Array.isArray(cached.payload.rows)) {
        const cachedRecord = Object.assign({}, cached.payload, { fromCache: true, stale: Boolean(cached.stale) });
        this._questionPages[cacheKey] = cachedRecord;
        return cachedRecord;
      }
      if (this._categoryRequests[cacheKey] && !options.priority) return this._categoryRequests[cacheKey];
    }
    const background = String(categoryId) !== String(this.data.categoryId);
    const request = Promise.resolve(api.content.questions({ source: SOURCE, categoryId, page }))
      .then((response) => {
        if (!background && requestId !== this._questionRequest) return null;
        const rows = response && Array.isArray(response.results) ? response.results : [];
        const access = response && response.access || {};
        const pageSize = Number(access.pageSize) > 0 ? Number(access.pageSize) : Math.max(rows.length, 1);
        const record = {
          rows,
          count: Number(access.totalCount) >= 0 ? Number(access.totalCount) : Number(response && response.count) >= 0 ? Number(response.count) : rows.length,
          pageSize,
          activated: Boolean(access.activated),
          freeCount: Number(access.freeCount) >= 0 ? Number(access.freeCount) : 0,
          restrictedCount: Number(access.restrictedCount) || 0,
          fromPrefetch: background
        };
        this._questionPages[cacheKey] = record;
        contentCache.write('literature-category', api.auth, cacheKey, record);
        return record;
      });
    if (!options.force) this._categoryRequests[cacheKey] = request;
    try {
      return await request;
    } finally {
      if (this._categoryRequests[cacheKey] === request) delete this._categoryRequests[cacheKey];
    }
  },
  async prefetchCategories(categories) {
    if (this._prefetchPromise || !Array.isArray(categories)) return this._prefetchPromise;
    const ids = categories.map((item) => item && item.id).filter(Boolean)
      .filter((id) => String(id) !== String(this.data.categoryId));
    this._prefetchPromise = (async () => {
      for (let index = 0; index < ids.length; index += 2) {
        await Promise.all(ids.slice(index, index + 2).map((categoryId) =>
          this.loadApiPage(1, this._questionRequest, { categoryId }).catch(() => null)
        ));
      }
    })().finally(() => { this._prefetchPromise = null; });
    return this._prefetchPromise;
  },

  async loadPage(page, options) {
    if (!this._answerViewport) this._answerViewport = tabletSheet.viewport(typeof wx === 'undefined' ? null : wx);
    if (!this.data.categoryId) return;
    let targetPage = Math.max(1, Number(page) || 1);
    const requestId = ++this._questionRequest;
    this.setData({ loading: !(this.data.questions && this.data.questions.length), hasError: false, errorMessage: '' });
    let firstPage;
    try {
      firstPage = await this.loadApiPage(1, requestId, { priority: true });
    } catch (error) {
      if (requestId !== this._questionRequest) return;
      this.setData({
        loading: false,
        hasError: true,
        errorMessage: describeError(error, '文学题目加载失败，请稍后重试'),
        questions: []
      });
      return;
    }
    if (requestId !== this._questionRequest) return;
    if (!firstPage) return;
    const count = firstPage.count;
    const apiPageSize = firstPage.pageSize;
    const activated = Boolean(firstPage.activated);
    const runtime = typeof wx === 'undefined' ? null : wx;
    const pageSize = tabletSheet.pageSize(activated, runtime, this._answerViewport);
    const pageCount = count ? Math.ceil(count / pageSize) : 0;
    if (pageSize !== this.data.pageSize) {
      targetPage = Math.floor((targetPage - 1) * (this.data.pageSize || UI_PAGE_SIZE) / pageSize) + 1;
    }

    if (options && options.findResume && this._resumeQuestionId) {
      const serverPageCount = count ? Math.ceil(count / apiPageSize) : 0;
      let resumeIndex = -1;
      let scanPages = true;
      const cachedIndex = firstPage.rows.findIndex((item) => item.id === this._resumeQuestionId);
      if (cachedIndex >= 0) {
        resumeIndex = cachedIndex;
        scanPages = false;
      } else if (api.content.question) {
        const detail = await settle(api.content.question(this._resumeQuestionId));
        if (requestId !== this._questionRequest) return;
        if (detail.ok && detail.value && detail.value.categoryId === this.data.categoryId
          && detail.value.source === SOURCE && Number.isInteger(detail.value.scopeIndex)
          && detail.value.scopeIndex >= 0 && detail.value.scopeIndex < count) {
          resumeIndex = detail.value.scopeIndex;
          scanPages = false;
        } else if (!detail.ok && detail.error && (detail.error.status === 403 || detail.error.status === 404)) {
          // A withdrawn or newly restricted saved question cannot be restored.
          scanPages = false;
        }
      }
      for (let apiPage = 1; scanPages && apiPage <= serverPageCount; apiPage += 1) {
        let record = this._questionPages[this.data.categoryId + ':' + apiPage];
        if (!record) record = await this.loadApiPage(apiPage, requestId);
        if (requestId !== this._questionRequest) return;
        if (!record) continue;
        const localIndex = record.rows.findIndex((item) => item.id === this._resumeQuestionId);
        if (localIndex >= 0) {
          resumeIndex = (apiPage - 1) * apiPageSize + localIndex;
          break;
        }
      }
      if (resumeIndex >= 0) {
        targetPage = Math.floor(resumeIndex / pageSize) + 1;
      } else if (targetPage > 1) {
        targetPage = 1;
      }
    }

    targetPage = Math.min(targetPage, pageCount || 1);
    const lockedPage = !activated && targetPage > 1;
    const startIndex = (targetPage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, count);
    const firstApiPage = Math.floor(startIndex / apiPageSize) + 1;
    const lastApiPage = endIndex > startIndex
      ? Math.floor((endIndex - 1) / apiPageSize) + 1
      : firstApiPage;
    try {
      for (let apiPage = firstApiPage; apiPage <= lastApiPage; apiPage += 1) {
        const cacheKey = this.data.categoryId + ':' + apiPage;
        if (!this._questionPages[cacheKey]) await this.loadApiPage(apiPage, requestId);
        if (requestId !== this._questionRequest) return;
      }
    } catch (error) {
      if (requestId !== this._questionRequest) return;
      this.setData({
        loading: false,
        hasError: true,
        errorMessage: describeError(error, '文学题目加载失败，请稍后重试'),
        questions: []
      });
      return;
    }

    if (pageSize > UI_PAGE_SIZE && Object.keys(this._questionPages).some(key => {
      const record = this._questionPages[key];
      return key.startsWith(this.data.categoryId + ':') && record.activated !== activated;
    })) {
      this._questionPages = {};
      this._questionRows = [];
      this._activated = false;
      this.setData({ loading: false, hasError: true, questions: [], activated: false, membershipVisible: false, errorMessage: '会员状态已变化，请重新加载题目' });
      return;
    }

    const rows = [];
    for (let index = startIndex; index < endIndex; index += 1) {
      const apiPage = Math.floor(index / apiPageSize) + 1;
      const record = this._questionPages[this.data.categoryId + ':' + apiPage];
      const row = record && record.rows[index % apiPageSize];
      if (row) rows.push(row);
    }
    const safeRows = answerDrafts.restrict(rows, lockedPage);
    const statePromise = this.loadStates(safeRows, requestId);
    const cachedFirstPage = Boolean(firstPage.fromCache || firstPage.fromPrefetch);
    if (!cachedFirstPage) await statePromise;
    if (requestId !== this._questionRequest) return;
    this._questionRows = safeRows;
    this._activated = activated;
    this._lockedPage = lockedPage;
    const questions = this.renderRows(safeRows, lockedPage);
    this.setData(Object.assign({
      loading: false,
      hasError: false,
      questions,
      page: targetPage,
      pageSize,
      isTablet: tabletSheet.isTablet(runtime, this._answerViewport),
      questionProgressLabel: formatQuestionProgress(startIndex, count),
      totalQuestions: count,
      pageCount,
      progressPercent: pageCount ? Math.round(targetPage / pageCount * 100) : 0,
      restrictedCount: activated ? 0 : Math.max(0, count - UI_PAGE_SIZE),
      restrictedQuestionCount: Math.max(0, count - UI_PAGE_SIZE),
      restrictedPageCount: Math.max(0, pageCount - 1),
      activated,
      lockedPage,
      membershipVisible: lockedPage,
      canPrevious: targetPage > 1,
      canNext: targetPage < pageCount,
      personalError: this.data.personalError
    }, answerDrafts.progress(questions)));
    this._lastRefreshAt = Date.now();
    contentCache.write('literature-first', api.auth, 'v1', {
      categories: this.data.categories,
      categoryId: this.data.categoryId,
      categoryName: this.data.categoryName,
      mode: this.data.mode,
      rows: safeRows,
      questions,
      page: targetPage,
      totalQuestions: count,
      pageCount,
      apiPageSize,
      activated,
      freeCount: firstPage.freeCount,
      restrictedCount: firstPage.restrictedCount,
      questionProgressLabel: formatQuestionProgress(startIndex, count),
      progressPercent: pageCount ? Math.round(targetPage / pageCount * 100) : 0
    });
    if (firstPage.fromCache && firstPage.stale) {
      this.loadApiPage(1, requestId, { force: true }).catch(() => null);
    }
    if (cachedFirstPage) {
      statePromise.then(() => {
        if (requestId !== this._questionRequest) return;
        const updated = this.renderRows(this._questionRows, lockedPage);
        this.setData(Object.assign({ questions: updated }, answerDrafts.progress(updated)));
      }).catch(() => null);
    }
    this.queueResume();
  },

  async loadStates(rows, requestId, refresh) {
    if (!hasToken() || !rows.length) return;
    rows = rows.filter((item) => !item.locked);
    if (!rows.length) return;
    // Current content responses already contain the learner's state. Only
    // older servers (or an explicit refresh) require individual reads.
    const missing = rows.filter((item) => refresh || !item.state);
    rows.forEach((item) => {
      const current = this._stateMap[item.id];
      if (!refresh && item.state && (!current || Number(item.state.version) >= current.version)) {
        this._stateMap[item.id] = normalizeState(item.state);
      }
    });
    if (!missing.length) return;
    const results = await Promise.all(missing.map((item) => settle(api.learning.questionState(item.id))));
    if (requestId !== this._questionRequest) return;
    let stateError = null;
    results.forEach((result, index) => {
      if (result.ok) this._stateMap[missing[index].id] = normalizeState(result.value);
      else if (!stateError) stateError = result.error;
    });
    if (stateError && stateError.code !== 'NOT_FOUND') {
      this.setData({ personalError: describeError(stateError, '部分学习状态暂不可用') });
    }
  },

  renderRows(rows, lockedPage) {
    const mode = this.data.mode;
    const pageLocked = lockedPage === undefined ? Boolean(this._lockedPage) : Boolean(lockedPage);
    const questions = answerDrafts.restrict(rows, pageLocked).map((item) => {
      const state = this._stateMap[item.id] || normalizeState(null);
      return Object.assign({}, item, state, {
        locked: Boolean(item.locked || pageLocked),
        parts: buildParts(item, mode),
        hasInlineBlanks: /\{\{\d+\}\}/.test(item.stem || ''),
        hasAnswerInput: questionUtils.requiredAnswerIndices(item).length > 0,
        answerText: Array.isArray(item.answers) ? item.answers.join('；') : '',
        answerVisible: Boolean(this._answerVisible[item.id])
      });
    });
    return answerDrafts.decorate(questions, this.draftStore());
  },

  draftStore() {
    if (!this._draftStore) this._draftStore = answerDrafts.createStore(api.auth, typeof wx === 'undefined' ? null : wx);
    return this._draftStore;
  },

  onAnswerInput(event) {
    const update = answerDrafts.acceptInput(this, event, this.draftStore());
    if (update) this.setData(update);
  },

  onBlankInput(event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset || {};
    const question = this.data.questions.find(item => String(item.id) === String(dataset.id));
    const index = Number(dataset.index);
    if (!question || !Number.isInteger(index) || index < 0) return;
    const values = (question.draftAnswers || []).slice();
    values[index] = event.detail.value;
    this.onAnswerInput({ detail: { id: question.id, values } });
  },

  async ensureLogin() {
    if (hasToken()) return true;
    if (!api.auth || typeof api.auth.login !== 'function') return false;
    try {
      await api.auth.login();
      this.setData({ isGuest: !hasToken() });
      return hasToken();
    } catch (error) {
      this.setData({ personalError: describeError(error, '登录暂不可用，请稍后重试') });
      wx.showToast({ title: '登录失败，请稍后重试', icon: 'none' });
      return false;
    }
  },

  async refreshVisibleStates() {
    if (!this._questionRows.length) return;
    await this.loadStates(this._questionRows, this._questionRequest, true);
    this.setData({ questions: this.renderRows(this._questionRows) });
  },

  changeCategory(event) {
    const categoryId = event.currentTarget.dataset.id;
    const index = this.data.categories.findIndex((item) => item.id === categoryId);
    const category = this.data.categories[index];
    if (!category || categoryId === this.data.categoryId) return;
    this._resumeQuestionId = '';
    this.setData({
      categoryId,
      categoryName: category.name,
      page: 1,
      loading: true,
      hasError: false,
      errorMessage: '',
      questions: [],
      answeredCount: 0,
      answerProgressPercent: 0,
      pageQuestionCount: 0,
      categoryScrollLeft: Math.max(0, index - 1) * 92
    });
    this.loadPage(1);
  },

  async changeMode(event) {
    const mode = isMode(event.detail && event.detail.mode);
    if (mode === this.data.mode) return;
    this._answerVisible = {};
    this.setData({ mode });
    const questions = this.renderRows(this._questionRows);
    this.setData(Object.assign({ questions }, answerDrafts.progress(questions)));
    if (!await this.ensureLogin()) return;
    this.queueResume();
    let baseVersion = this._preferenceVersion;
    try {
      if (baseVersion === null) {
        const current = await api.learning.preferences();
        baseVersion = Number(current && current.version) >= 0 ? Number(current.version) : 0;
        this._preferenceVersion = baseVersion;
      }
      const result = await api.learning.savePreferences({ mode, baseVersion });
      this._preferenceVersion = Number(result && result.version) >= 0
        ? Number(result.version)
        : baseVersion + 1;
    } catch (error) {
      const current = error && (error.current || error.fields && error.fields.current);
      if (error && error.code === 'VERSION_CONFLICT' && current && Number(current.version) >= 0) {
        try {
          const result = await api.learning.savePreferences({
            mode,
            baseVersion: Number(current.version)
          });
          this._preferenceVersion = Number(result && result.version) >= 0
            ? Number(result.version)
            : Number(current.version) + 1;
          return;
        } catch (retryError) {
          error = retryError;
        }
      }
      if (current && Number(current.version) >= 0) this._preferenceVersion = Number(current.version);
      this.setData({ personalError: describeError(error, '学习模式同步失败') });
    }
  },

  onModeTap(event) {
    const mode = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.mode
      : '';
    return this.changeMode({ detail: { mode } });
  },

  toggleFavorite(event) {
    const id = event && event.detail && event.detail.id
      ? event.detail.id
      : event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id;
    return this.updateQuestionState(id, 'favorite');
  },

  toggleMaster(event) {
    return this.updateQuestionState(event && event.detail && event.detail.id, 'mastered');
  },

  async updateQuestionState(id, field) {
    if (this.data.lockedPage || (this.data.questions || []).some(q => String(q.id) === String(id) && q.locked)) return this.openMembership();
    if (!id || this._pendingState[id]) return;
    if (!await this.ensureLogin()) return;
    const stateResult = await settle(api.learning.questionState(id));
    if (!stateResult.ok) {
      this.setData({ personalError: describeError(stateResult.error, '学习状态读取失败') });
      wx.showToast({ title: '暂时无法读取学习状态', icon: 'none' });
      return;
    }
    const current = normalizeState(stateResult.value);
    this._stateMap[id] = current;
    const next = !current[field];
    const body = { baseVersion: current.version, [field]: next };
    this._pendingState[id] = true;
    try {
      const result = await api.learning.setQuestionState(id, body);
      this._stateMap[id] = normalizeState(result);
      this.setData({ questions: this.renderRows(this._questionRows) });
    } catch (error) {
      const currentServer = error && (error.current || error.fields && error.fields.current);
      if (error && error.code === 'VERSION_CONFLICT' && currentServer) {
        const currentState = normalizeState(currentServer);
        this._stateMap[id] = currentState;
        try {
          const retryBody = { baseVersion: currentState.version, [field]: next };
          const result = await api.learning.setQuestionState(id, retryBody);
          this._stateMap[id] = normalizeState(result);
          this.setData({ questions: this.renderRows(this._questionRows) });
          return;
        } catch (retryError) {
          error = retryError;
        }
      }
      if (currentServer) this._stateMap[id] = normalizeState(currentServer);
      this.setData({
        questions: this.renderRows(this._questionRows),
        personalError: describeError(error, '学习状态同步失败')
      });
      if (error && error.code === 'VERSION_CONFLICT') {
        wx.showToast({ title: '记录已更新，请再试一次', icon: 'none' });
      }
    } finally {
      delete this._pendingState[id];
    }
  },

  toggleAnswer(event) {
    const id = event.currentTarget.dataset.id;
    if (!id) return;
    const question = this.data.questions.find((item) => String(item.id) === String(id));
    if (question && question.locked) return this.openMembership();
    this._answerVisible[id] = !this._answerVisible[id];
    this.setData({ questions: this.renderRows(this._questionRows) });
  },

  goPage(event) {
    const delta = Number(event.currentTarget.dataset.delta) || 0;
    const target = Math.max(1, Math.min(this.data.pageCount, this.data.page + delta));
    if (!delta || target === this.data.page) return;
    this._resumeQuestionId = '';
    this.loadPage(target);
    wx.pageScrollTo({ scrollTop: 0, duration: 180 });
  },

  openMembership() {
    this.setData({ membershipVisible: true });
  },

  closeMembership() {
    this.setData({ membershipVisible: false });
  },

  goMembership() {
    this.setData({ membershipVisible: false });
    navigation.openPage('/pages/mine/index', { membership: '1' });
  },

  retry() {
    if (!this.data.categories.length) {
      this.bootstrap();
      return;
    }
    this.loadPage(this.data.page || 1);
  },

  showFirstCategory() {
    const first = this.data.categories[0];
    if (!first) return;
    this._resumeQuestionId = '';
    this.setData({
      categoryId: first.id,
      categoryName: first.name,
      page: 1,
      categoryScrollLeft: 0
    });
    this.loadPage(1);
  },

  queueResume() {
    if (this.data.lockedPage || !hasToken() || !this.data.questions.length || this.data.questions[0].locked) return;
    const question = this.data.questions[0];
    this._resumePending = {
      source: SOURCE,
      categoryId: this.data.categoryId,
      articleId: null,
      type: 'fact',
      mode: this.data.mode,
      questionId: question.id,
      roundId: null,
      groupIndex: null,
      baseVersion: this._resumeVersion
    };
    this.flushResume();
  },

  async flushResume() {
    if (this._resumeSaving || !this._resumePending) return;
    this._resumeSaving = true;
    while (this._resumePending) {
      const body = this._resumePending;
      this._resumePending = null;
      try {
        const result = await api.learning.saveResume(body);
        if (result && Number(result.version) >= 0) this._resumeVersion = Number(result.version);
      } catch (error) {
        const current = error && (error.current || error.fields && error.fields.current);
        if (error && error.code === 'VERSION_CONFLICT' && current && Number(current.version) >= 0) {
          this._resumeVersion = Number(current.version);
          try {
            const result = await api.learning.saveResume(Object.assign({}, body, {
              baseVersion: this._resumeVersion
            }));
            if (result && Number(result.version) >= 0) this._resumeVersion = Number(result.version);
            continue;
          } catch (retryError) {
            error = retryError;
          }
        }
        if (current && Number(current.version) >= 0) this._resumeVersion = Number(current.version);
        this.setData({ personalError: describeError(error, '续学位置暂未同步') });
      }
    }
    this._resumeSaving = false;
  },

  openHome() {
    navigation.openPage('/pages/home/index');
  },

  openFavorites() {
    navigation.openPage('/pages/favorites/index');
  },

  openProfile() {
    navigation.openPage('/pages/mine/index');
  },

  onPreviousPage() {
    this.goPage({ currentTarget: { dataset: { delta: -1 } } });
  },

  onNextPage() {
    this.goPage({ currentTarget: { dataset: { delta: 1 } } });
  },
  onShareAppMessage() { return shareAppMessage(); },
  onShareTimeline() { return shareTimeline(); }
}));

const api = require('../../services/api');
const navigation = require('../../utils/navigation');

const DEFAULT_PAGE_SIZE = 20;
const SOURCE = 'literature';

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

function buildParts(question, mode) {
  const stem = String((question && question.stem) || '');
  const answers = Array.isArray(question && question.answers) ? question.answers : [];
  return stem.split(/(\{\{\d+\}\})/g).filter(Boolean).map((part, index) => {
    const match = /^\{\{(\d+)\}\}$/.exec(part);
    if (!match) return { key: index, text: part, isBlank: false, isFilled: false };
    const answer = answers[Number(match[1])] || '';
    if (mode === 'reciting' && answer) {
      return { key: index, text: '（' + answer + '）', isBlank: false, isFilled: true };
    }
    return { key: index, text: '____', isBlank: true, isFilled: false };
  });
}

function normalizeState(value) {
  return {
    favorite: Boolean(value && value.favorite),
    mastered: Boolean(value && value.mastered),
    version: Number(value && value.version) >= 0 ? Number(value.version) : 0
  };
}

Page({
  data: {
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
    pageSize: DEFAULT_PAGE_SIZE,
    totalQuestions: 0,
    pageCount: 0,
    progressPercent: 0,
    restrictedCount: 0,
    categoryScrollLeft: 0,
    isGuest: true,
    canPrevious: false,
    canNext: false
  },

  onLoad(options) {
    this._options = options || {};
    this._questionRequest = 0;
    this._loaded = false;
    this._stateMap = {};
    this._pendingState = {};
    this._answerVisible = {};
    this._questionRows = [];
    this._resumeQuestionId = this._options.questionId || '';
    this._resumeVersion = 0;
    this._preferenceVersion = 0;
    this._resumePending = null;
    this._resumeSaving = false;
    this.bootstrap();
  },

  onShow() {
    if (this._loaded && hasToken()) this.refreshVisibleStates();
  },

  async bootstrap() {
    const publicResults = await Promise.all([
      settle(api.config.get()),
      settle(api.content.categories({ page: 1 }))
    ]);
    const configResult = publicResults[0];
    const categoriesResult = publicResults[1];
    if (!categoriesResult.ok) {
      this.setData({
        loading: false,
        hasError: true,
        errorMessage: describeError(categoriesResult.error, '文学分类暂不可用')
      });
      return;
    }

    const config = configResult.ok && configResult.value ? configResult.value : {};
    const categories = categoriesResult.value && Array.isArray(categoriesResult.value.results)
      ? categoriesResult.value.results
      : [];
    let preference = null;
    let resumeSnapshot = null;
    let preferenceError = null;
    let resumeError = null;
    if (hasToken()) {
      const privateResults = await Promise.all([
        settle(api.learning.preferences()),
        settle(api.learning.resume())
      ]);
      if (privateResults[0].ok) preference = privateResults[0].value;
      else preferenceError = privateResults[0].error;
      if (privateResults[1].ok) resumeSnapshot = privateResults[1].value;
      else resumeError = privateResults[1].error;
    }

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
    this._pageSize = Number(config.pageSize) > 0 ? Number(config.pageSize) : DEFAULT_PAGE_SIZE;
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
  },

  async loadPage(page, options) {
    if (!this.data.categoryId) return;
    const targetPage = Math.max(1, Number(page) || 1);
    const requestId = ++this._questionRequest;
    this.setData({ loading: true, hasError: false, errorMessage: '' });
    let response;
    try {
      response = await api.content.questions({
        source: SOURCE,
        categoryId: this.data.categoryId,
        page: targetPage
      });
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
    const rows = response && Array.isArray(response.results) ? response.results : [];
    const count = Number(response && response.count) >= 0 ? Number(response.count) : rows.length;
    const pageSize = Number(response && response.access && response.access.pageSize) > 0
      ? Number(response.access.pageSize)
      : this._pageSize;
    const pageCount = count ? Math.ceil(count / pageSize) : 0;
    this._pageSize = pageSize;
    const resumeIndex = rows.findIndex((item) => item.id === this._resumeQuestionId);
    if (options && options.findResume && this._resumeQuestionId && resumeIndex < 0 && targetPage < pageCount) {
      await this.loadPage(targetPage + 1, options);
      return;
    }
    if (options && options.findResume && this._resumeQuestionId && resumeIndex < 0 && targetPage > 1) {
      await this.loadPage(1, { findResume: false });
      return;
    }
    await this.loadStates(rows, requestId);
    if (requestId !== this._questionRequest) return;
    this._questionRows = rows;
    const actualPage = resumeIndex >= 0 ? targetPage : targetPage;
    this.setData({
      loading: false,
      hasError: false,
      questions: this.renderRows(rows),
      page: actualPage,
      pageSize,
      totalQuestions: count,
      pageCount,
      progressPercent: pageCount ? Math.round(actualPage / pageCount * 100) : 0,
      restrictedCount: Number(response && response.access && response.access.restrictedCount) || 0,
      canPrevious: actualPage > 1,
      canNext: actualPage < pageCount,
      personalError: this.data.personalError
    });
    this.queueResume();
  },

  async loadStates(rows, requestId) {
    if (!hasToken() || !rows.length) return;
    const results = await Promise.all(rows.map((item) => settle(api.learning.questionState(item.id))));
    if (requestId !== this._questionRequest) return;
    let stateError = null;
    results.forEach((result, index) => {
      if (result.ok) this._stateMap[rows[index].id] = normalizeState(result.value);
      else if (!stateError) stateError = result.error;
    });
    if (stateError && stateError.code !== 'NOT_FOUND') {
      this.setData({ personalError: describeError(stateError, '部分学习状态暂不可用') });
    }
  },

  renderRows(rows) {
    const mode = this.data.mode;
    return rows.map((item) => {
      const state = this._stateMap[item.id] || normalizeState(null);
      return Object.assign({}, item, state, {
        parts: buildParts(item, mode),
        answerText: Array.isArray(item.answers) ? item.answers.join('；') : '',
        answerVisible: Boolean(this._answerVisible[item.id])
      });
    });
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
    await this.loadStates(this._questionRows, this._questionRequest);
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
      categoryScrollLeft: Math.max(0, index - 1) * 92
    });
    this.loadPage(1);
  },

  async changeMode(event) {
    const mode = isMode(event.detail && event.detail.mode);
    if (mode === this.data.mode) return;
    this.setData({ mode, questions: this.renderRows(this._questionRows) });
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

  toggleFavorite(event) {
    return this.updateQuestionState(event && event.detail && event.detail.id, 'favorite');
  },

  toggleMaster(event) {
    return this.updateQuestionState(event && event.detail && event.detail.id, 'mastered');
  },

  async updateQuestionState(id, field) {
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
    if (!hasToken() || !this.data.questions.length) return;
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
  }
});

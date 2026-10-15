const dataService = require('../../services/data-service');
const studyStore = require('../../utils/study-store');
const navigation = require('../../utils/navigation');
const api = require('../../services/api');

function canRequest() {
  return typeof wx !== 'undefined' && typeof wx.request === 'function';
}

function hasToken() {
  try { return Boolean(api.auth && api.auth.getToken && api.auth.getToken()); } catch (_) { return false; }
}

function describeError(error) {
  if (error && error.code === 'ENTITLEMENT_REQUIRED') return '该目录需要登录并开通学习权益';
  if (error && (error.code === 'INVALID_TOKEN' || error.status === 401)) return '登录状态已失效，请重新登录';
  if (error && error.status === 403) return '当前账号暂无访问权限';
  if (error && error.code === 'NETWORK_ERROR') return '网络暂不可用，当前显示本地演示内容';
  return error && error.message ? String(error.message) : '文言目录加载失败';
}

function settle(promise) {
  return Promise.resolve(promise).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
}

function normalizeQuestionState(value) {
  return { mastered: Boolean(value && value.mastered) };
}

function articleStatus(completed, total) {
  if (!total || completed <= 0) return { status: 'unlearned', statusLabel: '未学' };
  if (completed >= total) return { status: 'learned', statusLabel: '已学' };
  return { status: 'learning', statusLabel: '练习中' };
}

Page({
  data: {
    loading: true,
    hasError: false,
    errorMessage: '',
    dataSource: 'local',
    personalError: '',
    filterStatus: 'all',
    filters: [
      { value: 'all', label: '全部' },
      { value: 'unlearned', label: '未学' },
      { value: 'learning', label: '练习中' },
      { value: 'learned', label: '已学' }
    ],
    visibleArticles: [],
    visibleCount: 0,
    articleTotal: 25,
    learnedCount: 0,
    completionPercent: 0,
    modalVisible: false,
    selectedArticle: null
  },

  onLoad(options = {}) {
    this._requestedArticleId = options.articleId || '';
    this._requestedQuestionId = options.questionId || '';
    const requestedMode = options.mode === 'writing' || options.mode === 'reciting'
      ? options.mode
      : studyStore.getMode();
    this._remoteLoaded = false;
    this.setData({ mode: requestedMode });
    if (options.mode === 'writing' || options.mode === 'reciting') studyStore.setMode(requestedMode);
    if (canRequest()) this.loadRemote();
  },

  onShow() {
    if (!canRequest() || this._remoteLoaded) this.refreshProgress();
  },

  onReady() {
    this.canvasReady = true;
    this.drawProgress();
  },

  refreshProgress() {
    if (this.data.dataSource !== 'remote' || !Array.isArray(this.articles)) {
      this.articles = dataService.getArticleProgress().map((article) => article.total > 0
        ? article
        : Object.assign({}, article, { completed: 0, status: 'unlearned', statusLabel: '未学' }));
    }
    const stats = studyStore.getStats();
    const articleTotal = this.data.dataSource === 'remote' ? (Number(this.data.articleTotal) || this.articles.length) : (stats.articleTotal || this.articles.length);
    const learnedCount = this.data.dataSource === 'remote' ? Number(this.data.learnedCount || 0) : Number(stats.articleLearnedCount) || 0;
    this.setData({
      articleTotal,
      learnedCount,
      completionPercent: articleTotal ? Math.round(learnedCount / articleTotal * 100) : 0
    });
    this.applyFilter();
    this.restoreRequestedArticle();
    if (this.canvasReady) wx.nextTick(() => this.drawProgress());
  },

  async loadRemote() {
    this.setData({ loading: true, hasError: false, errorMessage: '' });
    const result = await settle(api.content.articles({ page: 1 }));
    if (!result.ok) {
      const message = describeError(result.error);
      if (result.error && result.error.code === 'NETWORK_ERROR') {
        this._remoteLoaded = true;
        this.setData({ loading: false, dataSource: 'local', personalError: message });
        this.refreshProgress();
      } else {
        this.setData({ loading: false, hasError: true, errorMessage: message, visibleArticles: [], visibleCount: 0 });
      }
      return;
    }
    const payload = result.value || {};
    const rows = Array.isArray(payload.results) ? payload.results.slice() : [];
    let next = payload.next || null;
    const seen = new Set();
    while (next && !seen.has(String(next))) {
      seen.add(String(next));
      const pageResult = await settle(api.pagination.follow(next, { auth: 'optional', basePath: '/api/student/v1/articles/' }));
      if (!pageResult.ok) {
        this.setData({ loading: false, hasError: true, errorMessage: describeError(pageResult.error), visibleArticles: [], visibleCount: 0 });
        return;
      }
      const page = pageResult.value || {};
      if (Array.isArray(page.results)) rows.push(...page.results);
      next = page.next || null;
    }
    if (!rows.length) {
      this._remoteLoaded = true;
      this.articles = [];
      this.setData({ loading: false, dataSource: 'remote', articleTotal: 0, learnedCount: 0, completionPercent: 0, visibleArticles: [], visibleCount: 0 });
      return;
    }
    const statsResult = hasToken() ? await settle(api.learning.statistics()) : { ok: false, error: null };
    const stats = statsResult.ok ? (statsResult.value || {}) : {};
    const learnedCount = Number(stats.completedArticles) >= 0 ? Number(stats.completedArticles) : 0;
    const total = Number(payload.count) >= 0 ? Number(payload.count) : rows.length;
    this.articles = rows.map((item, index) => ({
      id: item.id,
      title: item.title,
      index: Number(item.sortOrder) || index + 1,
      total: Number(item.publishedCount) || Number(item.freeCount) || 0,
      completed: 0,
      status: 'unlearned',
      statusLabel: '未学',
      placeholder: false
    }));
    let stateResult = { ok: true, value: null };
    if (hasToken()) stateResult = await this.loadArticleStates(this.articles);
    this._remoteLoaded = true;
    this.setData({
      loading: false,
      dataSource: 'remote',
      articleTotal: total,
      learnedCount,
      completionPercent: total ? Math.round(learnedCount / total * 100) : 0,
      personalError: !statsResult.ok
        ? describeError(statsResult.error)
        : (!stateResult.ok ? describeError(stateResult.error) : '')
    });
    this.applyFilter();
    this.restoreRequestedArticle();
    if (this.canvasReady) wx.nextTick(() => this.drawProgress());
  },

  async loadArticleStates(articles) {
    const progress = {};
    let firstError = null;
    for (const article of articles) {
      const questionResult = await settle(api.content.questions({ source: 'classical', articleId: article.id, page: 1 }));
      if (!questionResult.ok) {
        firstError = firstError || questionResult.error;
        continue;
      }
      const payload = questionResult.value || {};
      const questions = Array.isArray(payload.results) ? payload.results.slice() : [];
      let next = payload.next || null;
      const seen = new Set();
      while (next && !seen.has(String(next))) {
        seen.add(String(next));
        const pageResult = await settle(api.pagination.follow(next, { auth: true, basePath: '/api/student/v1/questions/' }));
        if (!pageResult.ok) {
          firstError = firstError || pageResult.error;
          break;
        }
        const page = pageResult.value || {};
        if (Array.isArray(page.results)) questions.push(...page.results);
        next = page.next || null;
      }
      if (!progress[article.id]) progress[article.id] = { total: 0, completed: 0 };
      progress[article.id].total = questions.length;
      const stateResults = await Promise.all(questions.map((question) => settle(api.learning.questionState(question.id))));
      stateResults.forEach((state) => {
        if (state.ok && normalizeQuestionState(state.value).mastered) progress[article.id].completed += 1;
      });
    }
    const updated = articles.map((article) => {
      const item = progress[article.id];
      if (!item) return article;
      const total = article.total || item.total;
      return Object.assign({}, article, { total, completed: item.completed }, articleStatus(item.completed, total));
    });
    this.articles = updated;
    this.setData({ visibleArticles: updated, visibleCount: updated.length });
    return firstError ? { ok: false, error: firstError } : { ok: true, value: progress };
  },

  onRetry() {
    if (canRequest()) this.loadRemote();
  },

  restoreRequestedArticle() {
    if (!this._requestedArticleId || this._requestedArticleRestored) return;
    const article = (this.articles || []).find((item) => String(item.id) === String(this._requestedArticleId));
    if (!article) return;
    this._requestedArticleRestored = true;
    this.setData({ selectedArticle: article, modalVisible: true });
  },

  applyFilter() {
    const status = this.data.filterStatus;
    const articles = (this.articles || []).filter((article) => status === 'all' || article.status === status);
    this.setData({
      visibleArticles: articles,
      visibleCount: articles.length
    });
  },

  drawProgress() {
    this.createSelectorQuery().select('#article-progress').fields({ node: true, size: true }).exec((results) => {
      const result = results && results[0];
      if (!result || !result.node || !result.width) return;
      const canvas = result.node;
      const context = canvas.getContext('2d');
      const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const ratio = windowInfo.pixelRatio || 1;
      canvas.width = result.width * ratio;
      canvas.height = result.height * ratio;
      context.scale(ratio, ratio);
      const centerX = result.width / 2;
      const centerY = result.height / 2;
      const lineWidth = result.width * 0.077;
      const radius = Math.min(centerX, centerY) - lineWidth;
      context.lineWidth = lineWidth;
      context.lineCap = 'round';
      context.strokeStyle = '#E6EBE5';
      context.beginPath();
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context.stroke();
      if (this.data.completionPercent > 0) {
        context.strokeStyle = '#1B4D3E';
        context.beginPath();
        context.arc(centerX, centerY, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * this.data.completionPercent / 100);
        context.stroke();
      }
    });
  },

  onFilter(event) {
    this.setData({ filterStatus: event.currentTarget.dataset.status });
    this.applyFilter();
  },

  onOpenArticle(event) {
    const article = (this.articles || []).find((item) => item.id === event.currentTarget.dataset.id);
    if (article) this.setData({ selectedArticle: article, modalVisible: true });
  },

  onCloseModal() {
    this.setData({ modalVisible: false });
  },

  stopTap() {},

  onChooseType(event) {
    const article = this.data.selectedArticle;
    if (!article) return;
    this.setData({ modalVisible: false });
    navigation.openPage('/pages/practice/index', {
      articleId: article.id || undefined,
      articleTitle: article.id ? article.title : undefined,
      type: event.currentTarget.dataset.type,
      mode: this.data.mode || undefined,
      questionId: this._requestedQuestionId || undefined,
      resume: this._requestedQuestionId ? 1 : undefined
    });
  },

  onSpecialty(event) {
    const type = event.currentTarget.dataset.type;
    if (type !== 'word' && type !== 'translation') return;
    this.setData({
      selectedArticle: { title: type === 'word' ? '重点字词' : '重点翻译', placeholder: false },
      modalVisible: true
    });
  },

  onContinue() {
    const resume = studyStore.getResume();
    if (resume && /pages\/practice\/index$/.test(resume.path || '')) {
      navigation.continueLearning();
      return;
    }
    const questions = dataService.decorateQuestions(dataService.getQuestions({ source: 'classical' }))
      .filter((question) => question.type === 'word' || question.type === 'translation');
    const articles = (this.articles || []).filter((article) => questions.some((question) => question.articleId === article.id));
    const article = articles.find((item) => questions.some((question) => question.articleId === item.id && !question.mastered)) || articles[0];
    if (!article) {
      wx.showToast({ title: '暂无可学习的演示内容', icon: 'none' });
      return;
    }
    const articleQuestions = questions.filter((question) => question.articleId === article.id);
    const nextQuestion = articleQuestions.find((question) => !question.mastered) || articleQuestions[0];
    navigation.openPage('/pages/practice/index', { articleId: article.id, articleTitle: article.title, type: nextQuestion.type, mode: this.data.mode || undefined });
  },

  moreSettings() {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title: '更多设置', icon: 'none' });
    }
  }
});

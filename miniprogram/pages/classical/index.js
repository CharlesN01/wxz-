const SHARE_TITLE = '文常记｜山东专升本语文';
const SHARE_PATH = '/pages/home/index';
const SHARE_IMAGE = '/assets/share-cover.png';
function shareAppMessage() { return { title: SHARE_TITLE, path: SHARE_PATH, imageUrl: SHARE_IMAGE }; }
function shareTimeline() { return { title: SHARE_TITLE, query: '', imageUrl: SHARE_IMAGE }; }
const dataService = require('../../services/data-service');
const studyStore = require('../../utils/study-store');
const navigation = require('../../utils/navigation');
const api = require('../../services/api');
let contentCache = { read: () => null, write: () => false };
try { const loadedCache = require('../../utils/content-cache'); if (loadedCache && typeof loadedCache.read === 'function') contentCache = loadedCache; } catch (_) { /* Older test/runtime shells do not expose optional cache. */ }

function currentTheme() { try { return wx.getStorageSync('chinese-study.theme') === 'night' ? 'night' : 'day'; } catch (_) { return 'day'; } }

function canRequest() {
  return typeof wx !== 'undefined' && typeof wx.request === 'function';
}

function getToken() {
  try { return api.auth && api.auth.getToken && api.auth.getToken() || ''; } catch (_) { return ''; }
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

function articleStatus(completed, total) {
  if (!total || completed <= 0) return { status: 'unlearned', statusLabel: '未学' };
  if (completed >= total) return { status: 'learned', statusLabel: '已学' };
  return { status: 'learning', statusLabel: '练习中' };
}

function readableCount(article) {
  if (Object.prototype.hasOwnProperty.call(article, 'wordCount') && Object.prototype.hasOwnProperty.call(article, 'translationCount')) {
    return Math.max(0, Number(article.wordCount) || 0) + Math.max(0, Number(article.translationCount) || 0);
  }
  return Math.max(0, Number(article.publishedCount) || Number(article.freeCount) || 0);
}

Page({
  data: {
    theme: 'day',
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
    this._loadGeneration = 0;
    this._needsRemoteRefresh = false;
    this._lastRefreshAt = 0;
    this.setData({ mode: requestedMode });
    const cached = contentCache.read('classical-catalog', api.auth, 'v1');
    if (cached && cached.payload && Array.isArray(cached.payload.articles)) {
      this.articles = cached.payload.articles;
      this._remoteLoaded = true;
      this._contentToken = getToken();
      this.setData({ loading: false, dataSource: 'remote', articleTotal: Number(cached.payload.articleTotal) || this.articles.length,
        learnedCount: Number(cached.payload.learnedCount) || 0, completionPercent: Number(cached.payload.completionPercent) || 0 });
      this.applyFilter();
    }
    if (options.mode === 'writing' || options.mode === 'reciting') studyStore.setMode(requestedMode);
    if (canRequest()) this.loadRemote();
  },

  onShow() {
    this.setData({ theme: currentTheme() });
    if (canRequest() && this._loadingPromise) return this.loadRemote();
    if (canRequest() && this._remoteLoaded && (this._contentToken !== getToken()
      || this._needsRemoteRefresh || this.data.dataSource === 'local') && Date.now() - (this._lastRefreshAt || 0) >= 60 * 1000) return this.loadRemote();
    if (!canRequest() || this._remoteLoaded) this.refreshProgress();
  },

  onHide() {
    this._needsRemoteRefresh = true;
  },

  onUnload() {
    this._loadGeneration = (this._loadGeneration || 0) + 1;
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

  loadRemote() {
    const token = getToken();
    if (this._loadingPromise && this._loadingToken === token) return this._loadingPromise;
    const generation = (this._loadGeneration || 0) + 1;
    this._loadGeneration = generation;
    this._loadingToken = token;
    this._needsRemoteRefresh = false;
    this._loadingPromise = this.fetchRemote(generation, token).finally(() => {
      if (this._loadGeneration === generation) this._loadingPromise = null;
    });
    return this._loadingPromise;
  },

  async fetchRemote(generation, token) {
    const isCurrent = () => this._loadGeneration === generation && getToken() === token;
    const keepVisible = this.data.dataSource === 'remote' && this._contentToken === token && Array.isArray(this.articles);
    this._contentToken = token;
    this.setData({ loading: !keepVisible, hasError: false, errorMessage: '', personalError: '' });
    if (!keepVisible) {
      this.articles = [];
      this.setData({ visibleArticles: [], visibleCount: 0, learnedCount: 0, completionPercent: 0 });
    }
    const result = await settle(api.content.articles({ page: 1 }, { auth: 'optional' }));
    if (!isCurrent()) return;
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
    const total = Number.isFinite(Number(payload.count)) && Number(payload.count) >= 0 ? Number(payload.count) : rows.length;
    this._remoteLoaded = true;
    this.renderRemoteArticles(rows, total);
    let next = payload.next || null;
    const seen = new Set();
    while (next && !seen.has(String(next))) {
      seen.add(String(next));
      const pageResult = await settle(api.pagination.follow(next, { auth: 'optional', basePath: '/api/student/v1/articles/' }));
      if (!isCurrent()) return;
      if (!pageResult.ok) {
        // Keep the already visible directory usable when a later page fails.
        this.setData({ hasError: true, errorMessage: describeError(pageResult.error) });
        return;
      }
      const page = pageResult.value || {};
      if (Array.isArray(page.results)) rows.push(...page.results);
      next = page.next || null;
      this.renderRemoteArticles(rows, total);
    }
  },

  renderRemoteArticles(rows, total) {
    this.articles = rows.map((item, index) => ({
      id: item.id,
      title: item.title,
      index: Number(item.sortOrder) || index + 1,
      total: readableCount(item),
      wordCount: Math.max(0, Number(item.wordCount) || 0),
      translationCount: Math.max(0, Number(item.translationCount) || 0),
      completed: Math.max(0, Number(item.progress && item.progress.masteredCount) || 0),
      nextQuestion: item.progress && item.progress.nextQuestion || null,
      placeholder: false,
      ...articleStatus(Number(item.progress && item.progress.masteredCount) || 0, readableCount(item))
    }));
    const learnedCount = this.articles.filter((article) => article.status === 'learned').length;
    this.setData({
      loading: false,
      dataSource: 'remote',
      articleTotal: total,
      learnedCount,
      completionPercent: total ? Math.round(learnedCount / total * 100) : 0
    });
    this._lastRefreshAt = Date.now();
    contentCache.write('classical-catalog', api.auth, 'v1', {
      articles: this.articles, articleTotal: total, learnedCount,
      completionPercent: total ? Math.round(learnedCount / total * 100) : 0
    });
    this.applyFilter();
    this.restoreRequestedArticle();
    if (this.canvasReady) wx.nextTick(() => this.drawProgress());
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

  async onContinue() {
    if (this.data.loading && canRequest()) {
      wx.showToast({ title: '正在同步文言内容', icon: 'none' });
      return;
    }
    if (this.data.dataSource === 'remote') {
      if (this._continuing) return;
      const articles = (this.articles || []).filter((article) => article.nextQuestion || article.total > 0);
      const article = articles.find((item) => item.status !== 'learned' && item.nextQuestion)
        || articles.find((item) => item.nextQuestion) || articles[0];
      if (!article) {
        wx.showToast({ title: '暂无可学习的远端内容', icon: 'none' });
        return;
      }
      let nextQuestion = article.nextQuestion;
      if (!nextQuestion) {
        const token = getToken();
        this._continuing = true;
        const result = await settle(api.content.questions({
          source: 'classical', articleId: article.id, page: 1,
          type: article.wordCount > 0 ? 'word' : (article.translationCount > 0 ? 'translation' : undefined)
        }, { auth: 'optional' }));
        this._continuing = false;
        if (getToken() !== token) return;
        if (!result.ok) {
          wx.showToast({ title: describeError(result.error), icon: 'none' });
          return;
        }
        nextQuestion = (result.value && result.value.results || []).find((question) => question.type === 'word' || question.type === 'translation');
      }
      if (!nextQuestion) {
        wx.showToast({ title: '暂无可学习的远端内容', icon: 'none' });
        return;
      }
      navigation.openPage('/pages/practice/index', {
        articleId: article.id,
        articleTitle: article.title,
        type: nextQuestion.type,
        mode: this.data.mode || undefined,
        questionId: nextQuestion.id,
        resume: 1
      });
      return;
    }
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
  onShareAppMessage() { return shareAppMessage(); },
  onShareTimeline() { return shareTimeline(); }
});

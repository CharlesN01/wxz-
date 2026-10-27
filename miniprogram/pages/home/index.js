const SHARE_TITLE = '文常记｜山东专升本语文';
const SHARE_PATH = '/pages/home/index';
const SHARE_IMAGE = '/assets/share-cover.png';
function shareAppMessage() { return { title: SHARE_TITLE, path: SHARE_PATH, imageUrl: SHARE_IMAGE }; }
function shareTimeline() { return { title: SHARE_TITLE, query: '', imageUrl: SHARE_IMAGE }; }
const api = require('../../services/api');
const navigation = require('../../utils/navigation');
const { learningTrend, minutes } = require('../../utils/learning-trend');
const studyTimer = require('../../utils/study-timer').clock;
const themeStore = require('../../utils/theme');
const { revealGeometry } = require('../../utils/theme-reveal');
const dataService = require('../../services/data-service');
const mockData = require('../../data/mock');

const GROUP_QR_IMAGE = '/assets/group-qr.jpg';

const EMPTY_STATS = {
  masteredCount: 0,
  studyDays: 0,
  completion: 0,
  todayCount: 0,
  todayMinutes: 0,
  todayTarget: 20,
  totalQuestions: 0,
  completedArticles: 0
};

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

function isDeveloperToolsPreview() {
  try {
    if (typeof wx === 'undefined' || typeof wx.getSystemInfoSync !== 'function') return false;
    const info = wx.getSystemInfoSync() || {};
    return String(info.platform || '').toLowerCase() === 'devtools';
  } catch (_) {
    return false;
  }
}

function getPreviewFallback() {
  const categories = dataService.getCategories();
  const articles = dataService.getArticles();
  return {
    config: Object.assign({}, mockData.config),
    categories: { count: categories.length, results: categories },
    articles: { count: articles.length, results: articles }
  };
}

function describeError(error, fallback) {
  if (error && error.code === 'NETWORK_ERROR') return '网络暂不可用，请检查连接后重试';
  if (error && error.code === 'INVALID_TOKEN') return '登录状态已失效，请重新登录';
  return error && error.message ? String(error.message) : fallback;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function daysUntil(dateText) {
  if (!dateText) return null;
  const target = new Date(String(dateText) + 'T00:00:00');
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.ceil((target.getTime() - today.getTime()) / 86400000));
}

function mapStatistics(value, dailyTarget) {
  const source = value || {};
  return {
    masteredCount: numberOr(source.masteredQuestions, 0),
    studyDays: numberOr(source.consecutiveStudyDays, 0),
    completion: numberOr(source.masteredPercent, 0),
    todayCount: numberOr(source.todayQuestions, 0),
    todayMinutes: minutes(source.todayStudySeconds),
    todayTarget: numberOr(source.dailyTarget, dailyTarget || EMPTY_STATS.todayTarget),
    totalQuestions: numberOr(source.totalQuestions, 0),
    completedArticles: numberOr(source.completedArticles, 0)
  };
}

function getResumePosition(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (snapshot.valid && snapshot.resume) return snapshot.resume;
  return snapshot.start || null;
}

Page({
  data: {
    theme: 'day',
    themeRevealStyle: '',
    themeTransition: false,
    revealTheme: 'day',
    revealContentStyle: '',
    revealNavbarStyle: '',
    loading: true,
    hasError: false,
    errorMessage: '',
    personalError: '',
    isGuest: true,
    statsReady: false,
    config: { pageSize: 20, dailyTarget: 20, examDate: null },
    stats: EMPTY_STATS,
    countdown: '--',
    targetLabel: '山东专升本',
    literatureCount: 0,
    classicalCount: 0,
    articleCount: 0,
    categoryCount: 0,
    todayPercent: 0,
    growthHint: '登录后查看学习统计',
    resume: null,
    firstCategoryId: '',
    resumeLabel: '开始学习：文学常识',
    resumeDescription: '从第一个文学分类开始学习',
    resumeAvailable: false,
    groupModalVisible: false,
    groupQrCode: GROUP_QR_IMAGE,
    groupWechatId: '',
    groupClaimCode: '',
    groupModalCopy: '扫码添加微信，邀请你进群',
    groupModalTip: '每日更新最新资料',
    groupModalNote: '进群有机会领取免费会员',
    groupResourceError: '',
    groupQrError: '',
    groupQrLoading: true,
    trendBars: [],
    trendHasData: false,
    trendHint: '登录后查看学习趋势'
  },

  onLoad() {
    this._loadVersion = 0;
    this._loaded = false;
    this.setData({ theme: themeStore.getTheme() });
    this.loadPublicData();
    this.loadGroupResource();
  },

  onShow() {
    this.syncTheme();
    if (this._loaded) {
      this.refreshLearningConfig().then(() => this.loadPersonalData());
      this.loadGroupResource();
    }
  },

  syncTheme() {
    const theme = themeStore.getTheme();
    if (theme !== this.data.theme) this.setData({ theme });
  },

  onPageScroll(event) {
    this._scrollTop = Math.max(0, Number(event.scrollTop) || 0);
  },

  // Rotation invalidates the viewport geometry of an in-flight theme reveal.
  onResize() { this.finishThemeTransition(); },

  onHide() { this.finishThemeTransition(); },

  onUnload() {
    clearTimeout(this._themeStartTimer);
    clearTimeout(this._themeFinishTimer);
    this._themeChanging = false;
  },

  toggleTheme(event) {
    if (this._themeChanging) return;
    this._themeChanging = true;
    const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const geometry = revealGeometry(event, info, this._scrollTop || 0);
    this._nextTheme = this.data.theme === 'day' ? 'night' : 'day';
    const circle = (radius) => `clip-path: circle(${radius}px at ${geometry.x}px ${geometry.y}px);`;
    // Mount the new palette over the unchanged old page. Offsetting with top
    // (never transform/scale) keeps viewport-fixed navigation in the same place.
    this.setData({
      themeTransition: true,
      revealTheme: this._nextTheme,
      themeRevealStyle: circle(0),
      revealContentStyle: `position: relative; top: -${this._scrollTop || 0}px;`,
      revealNavbarStyle: `position: relative; top: ${this._scrollTop || 0}px;`
    }, () => {
      if (!this._themeChanging) return;
      this._themeStartTimer = setTimeout(() => {
        if (!this._themeChanging) return;
        this.setData({ themeRevealStyle: circle(geometry.radius) + ' transition: clip-path 360ms cubic-bezier(.2,.75,.25,1);' });
        // Fallback for renderers that do not emit transitionend.
        this._themeFinishTimer = setTimeout(() => this.finishThemeTransition(), 420);
      }, 32);
    });
  },

  finishThemeTransition() {
    if (!this._themeChanging) return;
    clearTimeout(this._themeStartTimer);
    clearTimeout(this._themeFinishTimer);
    const theme = themeStore.setTheme(this._nextTheme);
    this._nextTheme = null;
    // Commit the lower page before removing its fully revealed upper copy.
    this.setData({ theme }, () => {
      this.setData({ themeTransition: false, themeRevealStyle: '' });
      this._themeChanging = false;
    });
  },

  async refreshLearningConfig() {
    const result = await settle(api.config.get());
    if (!result.ok || !result.value) return;
    const config = Object.assign({}, this.data.config, result.value);
    const countdown = daysUntil(config.examDate);
    this.setData({ config, countdown: countdown === null ? '--' : countdown,
      targetLabel: config.examDate ? String(config.examDate).slice(0, 4) + ' 山东专升本' : '山东专升本' });
  },

  async loadPublicData() {
    const version = ++this._loadVersion;
    this.setData({ loading: true, hasError: false, errorMessage: '' });
    let results = await Promise.all([
      settle(api.config.get()),
      settle(api.content.categories({ page: 1 })),
      settle(api.content.articles({ page: 1 }))
    ]);
    if (version !== this._loadVersion) return;

    // The simulator can temporarily lose access to the public API while the
    // project is being previewed. Keep the page usable with the bundled demo
    // data; real devices and release builds continue to use the API results.
    if (isDeveloperToolsPreview() && results.every((result) => !result.ok)) {
      const fallback = getPreviewFallback();
      results = [
        { ok: true, value: fallback.config },
        { ok: true, value: fallback.categories },
        { ok: true, value: fallback.articles }
      ];
    }

    const configResult = results[0];
    const categoriesResult = results[1];
    const articlesResult = results[2];
    const config = configResult.ok && configResult.value
      ? Object.assign({ pageSize: 20, dailyTarget: 20, examDate: null }, configResult.value)
      : this.data.config;
    const categories = categoriesResult.ok && categoriesResult.value
      ? (categoriesResult.value.results || [])
      : [];
    const articles = articlesResult.ok && articlesResult.value
      ? (articlesResult.value.results || [])
      : [];
    const categoryCount = categoriesResult.ok && categoriesResult.value
      ? numberOr(categoriesResult.value.count, categories.length)
      : categories.length;
    const literatureCount = categories.reduce(
      (sum, item) => sum + numberOr(item.publishedCount, numberOr(item.freeCount, 0)),
      0
    );
    const publicFailed = !configResult.ok && !categoriesResult.ok && !articlesResult.ok;
    const examCountdown = daysUntil(config.examDate);
    const stats = Object.assign({}, EMPTY_STATS, {
      todayTarget: numberOr(config.dailyTarget, EMPTY_STATS.todayTarget)
    });

    this._firstCategoryId = categories[0] ? categories[0].id : '';
    this.setData({
      config,
      stats,
      categoryCount,
      firstCategoryId: this._firstCategoryId,
      literatureCount,
      classicalCount: 0,
      articleCount: articlesResult.ok && articlesResult.value
        ? numberOr(articlesResult.value.count, articles.length)
        : articles.length,
      countdown: examCountdown === null ? '--' : examCountdown,
      targetLabel: config.examDate ? String(config.examDate).slice(0, 4) + ' 山东专升本' : '山东专升本',
      loading: false,
      hasError: publicFailed,
      errorMessage: publicFailed
        ? describeError(configResult.error, '学习配置暂不可用')
        : ''
    });
    this._loaded = true;
    await this.loadPersonalData(version);
  },

  async loadPersonalData(version) {
    if (version && version !== this._loadVersion) return;
    const personalVersion = this._personalVersion = (this._personalVersion || 0) + 1;
    if (!hasToken()) {
      this.setData({
        isGuest: true,
        statsReady: false,
        personalError: '',
        stats: Object.assign({}, EMPTY_STATS, {
          todayTarget: numberOr(this.data.config.dailyTarget, EMPTY_STATS.todayTarget)
        }),
        todayPercent: 0,
        growthHint: '登录后查看学习统计',
        trendBars: [], trendHasData: false, trendHint: '登录后查看学习趋势',
        resume: null,
        resumeAvailable: false,
        resumeLabel: '开始学习：文学常识',
        resumeDescription: '学习记录将在登录后同步'
      });
      return;
    }

    const token = api.auth.getToken();
    await studyTimer.settled();
    const results = await Promise.all([
      settle(api.learning.statistics()),
      settle(api.learning.resume())
    ]);
    if (version && version !== this._loadVersion) return;
    if (personalVersion !== this._personalVersion || token !== api.auth.getToken()) return;
    const statisticsResult = results[0];
    const resumeResult = results[1];
    const stats = statisticsResult.ok
      ? mapStatistics(statisticsResult.value, this.data.config.dailyTarget)
      : this.data.stats;
    const target = Math.max(1, stats.todayTarget || 1);
    const todayPercent = Math.min(100, Math.round(stats.todayCount / target * 100));
    const resume = resumeResult.ok ? getResumePosition(resumeResult.value) : null;
    const resumeAvailable = Boolean(resume && resume.questionId);
    this.setData({
      isGuest: false,
      statsReady: statisticsResult.ok,
      personalError: !statisticsResult.ok || !resumeResult.ok
        ? describeError(
          !statisticsResult.ok ? statisticsResult.error : resumeResult.error,
          '部分学习记录暂不可用'
        )
        : '',
      stats,
      ... (statisticsResult.ok ? learningTrend(statisticsResult.value)
        : { trendBars: [], trendHasData: false, trendHint: '学习趋势暂不可用，请重试' }),
      todayPercent,
      growthHint: statisticsResult.ok
        ? '今日 ' + stats.todayCount + ' / ' + target + ' 题'
        : '学习统计暂不可用',
      resume,
      resumeAvailable,
      resumeLabel: resumeAvailable
        ? (resume.source === 'literature' ? '继续学习：文学常识' : '继续学习：文言文考点')
        : '开始学习：文学常识',
      resumeDescription: resumeAvailable
        ? '从上次记录的位置继续学习'
        : '从第一个文学分类开始学习'
    });
  },

  retry() {
    this.loadPublicData();
    this.loadGroupResource();
  },

  openGroupModal() {
    this.setData({ groupModalVisible: true, groupQrLoading: true, groupQrError: '' });
    this.loadGroupResource();
  },

  async loadGroupResource() {
    if (!api.resources || typeof api.resources.group !== 'function') return;
    const version = this._groupVersion = (this._groupVersion || 0) + 1;
    const result = await settle(api.resources.group());
    if (version !== this._groupVersion) return false;
    if (!result.ok) {
      this.setData({ groupResourceError: describeError(result.error, '资料群配置暂时无法加载') });
      return false;
    }
    const resource = result.value && result.value.enabled ? result.value : {};
    const claimCode = resource.claimCode || '';
    const groupQrCode = GROUP_QR_IMAGE;
    const changed = groupQrCode !== this.data.groupQrCode;
    this.setData({
      groupQrCode,
      groupQrLoading: Boolean(groupQrCode) && (changed || this.data.groupQrLoading),
      groupQrError: changed ? '' : this.data.groupQrError,
      groupWechatId: resource.wechatId || '',
      groupClaimCode: claimCode,
      groupModalCopy: '截图扫一扫，邀请你进群',
      groupModalTip: '每日更新最新资料',
      groupModalNote: '进群有机会领取免费会员',
      groupResourceError: ''
    });
    return true;
  },

  previewGroupQr() {
    if (this.data.groupQrError) { this.retryGroupQr(); return; }
    if (this.data.groupQrCode && typeof wx !== 'undefined' && typeof wx.previewImage === 'function') {
      wx.previewImage({ urls: [this.data.groupQrCode] });
      return;
    }
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title: '二维码暂未配置', icon: 'none' });
    }
  },

  onGroupQrLoad(event) {
    if (event && event.currentTarget && event.currentTarget.dataset.src !== this.data.groupQrCode) return;
    this.setData({ groupQrLoading: false, groupQrError: '' });
  },

  onGroupQrError(event) {
    if (event && event.currentTarget && event.currentTarget.dataset.src !== this.data.groupQrCode) return;
    this.setData({ groupQrLoading: false, groupQrError: '二维码加载失败，请点击重试' });
  },

  async retryGroupQr() {
    const loaded = await this.loadGroupResource();
    if (loaded && this.data.groupQrCode) this.setData({ groupQrLoading: true, groupQrError: '' });
  },

  closeGroupModal() {
    this.setData({ groupModalVisible: false });
  },

  noop() {},

  openModule(event) {
    const dataset = event.currentTarget.dataset || {};
    if (!dataset.page) return;
    const params = dataset.source ? { source: dataset.source } : {};
    if (dataset.page === 'literature' || dataset.page === 'random' || dataset.page === 'classical') {
      params.mode = 'writing';
    }
    navigation.openPage(
      '/pages/' + dataset.page + '/index',
      params
    );
  },

  openNav(event) {
    const page = event.currentTarget.dataset.page;
    if (page) navigation.openPage('/pages/' + page + '/index');
  },

  continueLearning() {
    const resume = this.data.resume;
    if (!resume) {
      navigation.openPage('/pages/literature/index', {
        categoryId: this._firstCategoryId || undefined
      });
      return;
    }
    if (resume.roundId) {
      navigation.openPage('/pages/random/index', {
        source: resume.source,
        type: resume.type || undefined,
        articleId: resume.articleId || undefined,
        roundId: resume.roundId,
        groupIndex: resume.groupIndex,
        mode: resume.mode,
        resume: 1
      });
      return;
    }
    if (resume.source === 'literature') {
      navigation.openPage('/pages/literature/index', {
        categoryId: resume.categoryId || undefined,
        mode: resume.mode || undefined,
        questionId: resume.questionId || undefined
      });
      return;
    }
    if (resume.type) {
      navigation.openPage('/pages/practice/index', {
        articleId: resume.articleId || undefined,
        type: resume.type,
        mode: resume.mode || undefined,
        questionId: resume.questionId || undefined,
        resume: resume.questionId ? 1 : undefined
      });
      return;
    }
    navigation.openPage('/pages/classical/index', {
      articleId: resume.articleId || undefined,
      mode: resume.mode || undefined,
      questionId: resume.questionId || undefined
    });
  },
  onShareAppMessage() { return shareAppMessage(); },
  onShareTimeline() { return shareTimeline(); }
});

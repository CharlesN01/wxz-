const api = require('../../services/api');
const navigation = require('../../utils/navigation');

const EMPTY_STATS = {
  masteredCount: 0,
  studyDays: 0,
  completion: 0,
  todayCount: 0,
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
    studyDays: numberOr(source.studyDays, 0),
    completion: numberOr(source.masteredPercent, 0),
    todayCount: numberOr(source.todayQuestions, 0),
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
    trendBars: [
      { label: '一', height: 56 }, { label: '二', height: 82 }, { label: '三', height: 108, active: true },
      { label: '四', height: 70 }, { label: '五', height: 128, active: true }, { label: '六', height: 92 }, { label: '日', height: 60 }
    ]
  },

  onLoad() {
    this._loadVersion = 0;
    this._loaded = false;
    this.loadPublicData();
  },

  onShow() {
    if (this._loaded) this.loadPersonalData();
  },

  async loadPublicData() {
    const version = ++this._loadVersion;
    this.setData({ loading: true, hasError: false, errorMessage: '' });
    const results = await Promise.all([
      settle(api.config.get()),
      settle(api.content.categories({ page: 1 })),
      settle(api.content.articles({ page: 1 }))
    ]);
    if (version !== this._loadVersion) return;

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
        resume: null,
        resumeAvailable: false,
        resumeLabel: '开始学习：文学常识',
        resumeDescription: '学习记录将在登录后同步'
      });
      return;
    }

    const results = await Promise.all([
      settle(api.learning.statistics()),
      settle(api.learning.resume())
    ]);
    if (version && version !== this._loadVersion) return;
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
  },

  openGroupModal() {
    navigation.openPage('/pages/resources/index');
  },

  closeGroupModal() {
    this.setData({ groupModalVisible: false });
  },

  noop() {},

  moreSettings() {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title: '更多设置', icon: 'none' });
    }
  },

  openModule(event) {
    const dataset = event.currentTarget.dataset || {};
    if (!dataset.page) return;
    navigation.openPage(
      '/pages/' + dataset.page + '/index',
      dataset.source ? { source: dataset.source } : {}
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
        questionId: resume.questionId || undefined
      });
      return;
    }
    navigation.openPage('/pages/classical/index', {
      articleId: resume.articleId || undefined,
      mode: resume.mode || undefined,
      questionId: resume.questionId || undefined
    });
  }
});

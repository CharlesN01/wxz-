const { getNavigationMetrics } = require('../../utils/safe-top');

Component({
  properties: {
    title: String,
    region: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    centered: { type: Boolean, value: false },
    theme: { type: String, value: 'green' },
    back: { type: Boolean, value: true },
    customBack: { type: Boolean, value: false }
  },
  data: { statusHeight: 24, barHeight: 58, rightSpace: 100 },
  lifetimes: {
    attached() { this.refreshMetrics(); this.updateNavigationColor(); }
  },
  pageLifetimes: {
    show() { this.refreshMetrics(); this.updateNavigationColor(); }
  },
  observers: { theme() { this.updateNavigationColor(); } },
  methods: {
    refreshMetrics() {
      this.setData(getNavigationMetrics(typeof wx !== 'undefined' ? wx : null));
    },
    updateNavigationColor() {
      if (typeof wx === 'undefined' || !wx.setNavigationBarColor) return;
      const paper = this.data.theme === 'paper';
      wx.setNavigationBarColor({
        frontColor: paper ? '#000000' : '#ffffff',
        backgroundColor: paper ? '#FFFFFF' : '#12345B'
      });
    },
    goBack() {
      if (this.data.customBack) { this.triggerEvent('back'); return; }
      const pages = getCurrentPages();
      if (pages.length > 1) wx.navigateBack();
      else wx.reLaunch({ url: '/pages/home/index' });
    }
  }
});

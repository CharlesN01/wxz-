const store = require('./utils/study-store');
const agentAttribution = require('./utils/agent-attribution');

App({
  onLaunch(options) {
    store.getState();
    agentAttribution.capture(options || (wx.getLaunchOptionsSync ? wx.getLaunchOptionsSync() : null));
  },
  onShow(options) {
    agentAttribution.capture(options);
  }
});

const store = require('./utils/study-store');
const agentAttribution = require('./utils/agent-attribution');
const studyTimer = require('./utils/study-timer').clock;

App({
  onLaunch(options) {
    store.getState();
    agentAttribution.capture(options || (wx.getLaunchOptionsSync ? wx.getLaunchOptionsSync() : null));
  },
  onShow(options) {
    // onShow fires on every resume from background without a scene in options;
    // preserve the scene captured at onLaunch so an agent-scan session keeps
    // its attribution across background/foreground switches.
    agentAttribution.capture(options, { preserveOnEmpty: true });
    studyTimer.onAppShow();
  },
  onHide() { studyTimer.onAppHide(); }
});

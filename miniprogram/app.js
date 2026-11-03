const config = require('./config/index');
const auth = require('./utils/auth');
const channel = require('./utils/channel');
const track = require('./utils/track');

App({
  globalData: {
    brand: config.brand,
    user: null,
    // 金额遮挡：只影响屏幕显示，不替代接口权限（见框架文档 8.2）
    privacy: false
  },

  onLaunch(options) {
    // 分享链接/小程序码带来的渠道身份（顾客/同行/代理 + 分享人），后续请求都会带上
    channel.captureFromLaunch(options);
    this.globalData.user = auth.getCachedUser();
    this.globalData.privacy = !!wx.getStorageSync('privacy');
    auth.silentLogin().catch((err) => console.warn('[app] silent login failed', err));
  },

  onShow(options) {
    channel.captureFromLaunch(options);
  },

  onHide() {
    track.flush();
  },

  setPrivacy(on) {
    this.globalData.privacy = !!on;
    wx.setStorageSync('privacy', !!on);
  }
});

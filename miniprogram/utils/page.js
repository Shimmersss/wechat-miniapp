/**
 * 页面工厂：所有页面都用 createPage 代替 Page。
 *
 * 额外选项：
 *   requireStaff  {boolean}         仅员工可进入，未登录跳转员工登录页
 *   requireAgent  {boolean}         仅审核通过的代理可进入，否则跳转申请页
 *   permission    {string|string[]} 需要的权限点（constants/roles.js PERM）
 *   trackView     {boolean}         是否上报 PV，默认 true
 *
 * 注入的 data：user, privacy, brand
 * 注入的方法：$go(path, query)、$back()、$toast(title)、togglePrivacy()
 */
const config = require('../config/index');
const auth = require('./auth');
const router = require('./router');
const track = require('./track');
const events = require('./events');
const { isStaff, isAgent, can } = require('./permission');

function createPage(options) {
  const { requireStaff = false, requireAgent = false, permission = null, trackView = true, ...pageOptions } = options;
  const { onLoad, onReady, onShow, onUnload } = pageOptions;

  pageOptions.data = { user: null, privacy: false, brand: config.brand, ...(pageOptions.data || {}) };

  pageOptions.onLoad = function (query) {
    const user = auth.getCachedUser();
    // 守卫跳转放到 onReady 之后执行：页面还在转场时跳转（尤其 switchTab 到 tabBar 页）会被挂起，用户看到空白页
    if (requireStaff && !isStaff(user)) {
      const redirect = router.withQuery(`/${this.route}`, query);
      this.__guardRedirect = () => router.redirect(router.ROUTES.LOGIN, { redirect });
      return;
    }
    if (requireAgent && !isAgent(user)) {
      this.__guardRedirect = () => router.redirect(router.ROUTES.AGENT_LANDING);
      return;
    }
    if (permission && !can(user, permission)) {
      wx.showModal({ title: '无权限', content: '当前账号没有该功能的权限，请联系管理员开通。', showCancel: false, complete: () => router.back() });
      return;
    }
    this.__authOk = true;
    this.__offAuth = events.on('auth:changed', (u) => this.setData({ user: u }));
    this.setData({ user, privacy: getApp().globalData.privacy });
    if (onLoad) onLoad.call(this, query);
  };

  pageOptions.onReady = function () {
    if (this.__guardRedirect) {
      // 等页面转场动画结束再跳，否则跳 tabBar 页会被挂起约 10 秒
      setTimeout(this.__guardRedirect, 400);
      return;
    }
    if (this.__authOk && onReady) onReady.call(this);
  };

  pageOptions.onShow = function () {
    // 顾客端自定义 tabBar：每次显示时按当前路由同步选中项
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null;
    if (tabBar && tabBar.sync) tabBar.sync(this.route);
    if (!this.__authOk) return;
    const privacy = getApp().globalData.privacy;
    if (privacy !== this.data.privacy) this.setData({ privacy });
    if (trackView) track.pageView(this.route, this.trackExtra ? this.trackExtra() : undefined);
    if (onShow) onShow.call(this);
  };

  pageOptions.onUnload = function () {
    if (this.__offAuth) this.__offAuth();
    if (onUnload) onUnload.call(this);
  };

  pageOptions.$go = function (path, query) {
    return router.go(path, query);
  };
  pageOptions.$back = function () {
    return router.back();
  };
  pageOptions.$toast = function (title, icon = 'none') {
    wx.showToast({ title, icon });
  };
  /** WXML 中 bindtap="onNavigate" data-url="/packages/..." 直接跳转 */
  pageOptions.onNavigate = function (e) {
    const { url } = e.currentTarget.dataset;
    if (url) router.go(url);
  };
  pageOptions.togglePrivacy = function () {
    const next = !this.data.privacy;
    getApp().setPrivacy(next);
    this.setData({ privacy: next });
  };

  return Page(pageOptions);
}

module.exports = { createPage };

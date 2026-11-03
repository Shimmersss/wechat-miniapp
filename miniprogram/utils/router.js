/** 路由封装：拼接 query、处理 tabBar 页、页面栈溢出 */
const ROUTES = require('../constants/routes');

const TAB_PAGES = [ROUTES.SHOP, ROUTES.CATEGORY, ROUTES.AGENT_LANDING, ROUTES.MINE];
const MAX_STACK = 10;

function withQuery(path, query) {
  if (!query) return path;
  const qs = Object.keys(query)
    .filter((k) => query[k] !== undefined && query[k] !== null && query[k] !== '')
    .map((k) => `${k}=${encodeURIComponent(query[k])}`)
    .join('&');
  return qs ? `${path}?${qs}` : path;
}

function logFail(api, url) {
  return (err) => console.warn(`[router] ${api} 失败: ${url}`, err && err.errMsg);
}

function go(path, query) {
  if (TAB_PAGES.includes(path)) return wx.switchTab({ url: path, fail: logFail('switchTab', path) });
  const url = withQuery(path, query);
  if (getCurrentPages().length >= MAX_STACK) return wx.redirectTo({ url, fail: logFail('redirectTo', url) });
  return wx.navigateTo({ url, fail: logFail('navigateTo', url) });
}

function redirect(path, query) {
  if (TAB_PAGES.includes(path)) return wx.switchTab({ url: path, fail: logFail('switchTab', path) });
  const url = withQuery(path, query);
  return wx.redirectTo({ url, fail: logFail('redirectTo', url) });
}

function relaunch(path, query) {
  return wx.reLaunch({ url: withQuery(path, query) });
}

function back(delta = 1) {
  if (getCurrentPages().length > 1) return wx.navigateBack({ delta });
  return wx.switchTab({ url: ROUTES.SHOP });
}

/** 当前页面完整路径（含 query），用于登录后回跳 */
function currentUrl() {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page) return '';
  return withQuery(`/${page.route}`, page.options);
}

module.exports = { ROUTES, TAB_PAGES, go, redirect, relaunch, back, withQuery, currentUrl };

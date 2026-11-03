/**
 * 登录与身份。
 * - 顾客/同行/代理：wx.login 静默登录，服务端按 openid 识别身份与渠道。
 * - 员工：独立账号 + 微信绑定 + 可选二次验证（框架文档 需求 1），登录后 user.role 为员工角色。
 * user 结构（服务端下发）：
 *   { id, nickname, avatar, role, permissions: string[], agentStatus, storeId, staffNo }
 */
const config = require('../config/index');
const events = require('./events');
const { ROLE_PERMISSIONS } = require('../constants/roles');

const { storageKeys } = config;
let loginPromise = null;
let sessionRevision = 0;

function getCachedUser() {
  return wx.getStorageSync(storageKeys.user) || null;
}

function saveSession({ token, user }) {
  if (token) wx.setStorageSync(storageKeys.token, token);
  if (user) {
    // 服务端未下发 permissions 时回落到默认角色权限，仅用于显示入口
    if (!user.permissions) user.permissions = ROLE_PERMISSIONS[user.role] || [];
    wx.setStorageSync(storageKeys.user, user);
    const app = getApp();
    if (app) app.globalData.user = user;
  }
  events.emit('auth:changed', user);
  return user;
}

function wxCode() {
  return new Promise((resolve, reject) => {
    wx.login({ success: (res) => (res.code ? resolve(res.code) : reject(new Error('wx.login 无 code'))), fail: reject });
  });
}

/** 静默登录，多处并发调用时只发一次 */
function silentLogin() {
  if (loginPromise) return loginPromise;
  const api = require('../api/index');
  const revision = sessionRevision;
  loginPromise = wxCode()
    .then((code) => api.auth.wxLogin({ code }))
    .then((session) => revision === sessionRevision ? saveSession(session) : getCachedUser())
    .finally(() => {
      loginPromise = null;
    });
  return loginPromise;
}

/** 员工登录：账号 + 短信验证码（二次验证可选），成功后与当前微信绑定 */
function staffLogin(payload) {
  const revision = ++sessionRevision;
  const api = require('../api/index');
  return wxCode()
    .then((code) => api.auth.staffLogin({ ...payload, code }))
    .then((session) => {
      if (revision !== sessionRevision) throw new Error('登录操作已失效，请重试');
      return saveSession(session);
    });
}

function refreshMe() {
  const api = require('../api/index');
  return api.auth.me().then((user) => saveSession({ user }));
}

function logout() {
  const revision = ++sessionRevision;
  const api = require('../api/index');
  return api.auth
    .logout()
    .catch(() => null)
    .then(() => {
      if (revision !== sessionRevision) return;
      wx.removeStorageSync(storageKeys.token);
      wx.removeStorageSync(storageKeys.user);
      const app = getApp();
      if (app) app.globalData.user = null;
      events.emit('auth:changed', null);
    });
}

events.on('auth:expired', () => {
  sessionRevision += 1;
  wx.removeStorageSync(storageKeys.user);
  const app = getApp();
  if (app) app.globalData.user = null;
  events.emit('auth:changed', null);
});

module.exports = { getCachedUser, silentLogin, staffLogin, refreshMe, logout, saveSession };

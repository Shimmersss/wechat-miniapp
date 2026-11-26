/**
 * 登录与身份。
 * - 顾客/同行/代理：需要账号的操作按需调用 wx.login，公开浏览允许匿名。
 * - 员工：由服务端验证微信身份与在职员工绑定，登录后 user.role 为员工角色。
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

function ensureWechatSession() {
  if (wx.getStorageSync(storageKeys.token))
    return Promise.resolve();
  return silentLogin();
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

/** 云开发使用员工微信身份登录，旧后端使用短信登录。 */
async function staffLogin(payload) {
  const revision = ++sessionRevision;
  const api = require('../api/index');
  const code = await wxCode();
  const session = config.staffWechatLogin
    ? await api.auth.staffWechatLogin({ code })
    : await api.auth.staffLogin({ ...payload, code });
  if (revision !== sessionRevision) throw new Error('登录操作已失效，请重试');
  return saveSession(session);
}

async function refreshMe() {
  const api = require('../api/index');
  await ensureWechatSession();
  const revision = sessionRevision;
  const token = wx.getStorageSync(storageKeys.token);
  let user;
  try {
    user = await api.auth.me();
  } catch (error) {
    if (Number(error.code) === 401 && sessionRevision === revision + 1 && !wx.getStorageSync(storageKeys.token))
      return silentLogin();
    throw error;
  }
  if (revision !== sessionRevision || token !== wx.getStorageSync(storageKeys.token))
    throw new Error('登录状态已变化，请重试');
  return saveSession({ user });
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

module.exports = { getCachedUser, silentLogin, ensureWechatSession, staffLogin, refreshMe, logout, saveSession };

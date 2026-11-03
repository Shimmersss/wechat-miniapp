const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function pending() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function authHarness(api) {
  const storage = new Map(), callbacks = {}, app = { globalData: {} };
  const context = { module: { exports: {} }, getApp: () => app, wx: { login: o => o.success({ code: 'fixture' }), getStorageSync: k => storage.get(k), setStorageSync: (k,v) => storage.set(k,v), removeStorageSync: k => storage.delete(k) }, require(name) {
    if (name === '../api/index') return { auth: api };
    if (name === '../config/index') return { storageKeys: { token: 'token', user: 'user' } };
    if (name === './events') return { on: (name, fn) => { callbacks[name] = fn; }, emit: () => {} };
    if (name === '../constants/roles') return { ROLE_PERMISSIONS: {} };
    throw new Error(name);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/utils/auth'), 'utf8'), context);
  return { auth: context.module.exports, storage, callbacks, app };
}
const session = role => ({ token: role, user: { id: role, role, permissions: [] } });
test('迟到的静默登录结果不能覆盖已验证员工会话', async () => {
  const silent = pending();
  const { auth, storage } = authHarness({ wxLogin: () => silent.promise, staffLogin: async () => session('boss') });
  const first = auth.silentLogin();
  await auth.staffLogin({}); silent.resolve(session('customer')); await first;
  assert.equal(storage.get('user').role, 'boss'); assert.equal(storage.get('token'), 'boss');
});
test('旧退出请求不能清空新登录；过期事件清除缓存与全局身份', async () => {
  const outgoing = pending();
  const { auth, storage, callbacks, app } = authHarness({ logout: () => outgoing.promise, staffLogin: async () => session('boss') });
  auth.saveSession(session('sales'));const logout = auth.logout();await auth.staffLogin({});outgoing.resolve(true);await logout;
  assert.equal(storage.get('user').role, 'boss');
  callbacks['auth:expired']();assert.equal(storage.get('user'), undefined);assert.equal(app.globalData.user, null);
});

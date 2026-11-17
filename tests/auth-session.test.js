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

test('公开商品请求接受匿名访问并在旧会话失效时保留渠道重试', async () => {
  const storage = new Map([['visitor', 'guest-1']]);
  const sent = [], emitted = [];
  const context = {
    module: { exports: {} },
    require(name) {
      if (name === '../config/index') return {
        useCloud: true, cloudHttpBaseUrl: 'https://shop.example.com',
        storageKeys: { token: 'token', visitorId: 'visitor' }
      };
      if (name === './channel') return { getHeaderValue: () => 'share-1' };
      if (name === './events') return { emit: name => emitted.push(name) };
      throw new Error(name);
    },
    wx: {
      getStorageSync: key => storage.get(key),
      removeStorageSync: key => storage.delete(key),
      showToast: () => assert.fail('公开浏览不应提示登录'),
      request(options) {
        const { header } = options;
        sent.push({ ...header });
        options.success({ data: header.Authorization === 'Bearer expired'
          ? { code: 401, message: '请先登录' }
          : { code: 0, data: header.Authorization ? 'wholesale' : 'retail' } });
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/utils/request'), 'utf8'), context);
  const browse = () => context.module.exports.http.get('/shop/units', {}, { optionalSession: true });
  assert.equal(await browse(), 'retail');
  storage.set('token', 'expired');
  assert.equal(await browse(), 'retail');
  assert.deepEqual(emitted, ['auth:expired']);
  assert.equal(storage.has('token'), false);
  assert.deepEqual(sent.map(header => header.Authorization), [undefined, 'Bearer expired', undefined]);
  assert.ok(sent.every(header => header['X-Channel'] === 'share-1' && header['X-Visitor-Id'] === 'guest-1'));
  storage.set('token', 'valid');
  assert.equal(await browse(), 'wholesale');
});

const test = require('node:test');
const assert = require('node:assert/strict');
let role = 'customer';
global.wx = { getStorageSync: k => (k === 'xm_mock_role' ? role : undefined), setStorageSync() {}, removeStorageSync() {} };
const mock = require('../miniprogram/mock');
const db = require('../miniprogram/mock/data');
const { imeiOf } = require('../miniprogram/mock/test-seed');
const { isImei } = require('../miniprogram/utils/validate');
const { UNIT_STATUS } = require('../miniprogram/constants/status');
const call = (url, method = 'GET', data = {}) => mock.handle({ url, method, data });

test('角色测试预置数据：74 台设备覆盖全部状态，串码有效且不重复，重复加载无副作用', () => {
  assert.deepEqual(mock.loadTestSeed(), { loaded: true, units: 74 });
  assert.deepEqual(mock.loadTestSeed(), { loaded: false, units: 74 });
  assert.equal(db.units.length, 74);
  const statuses = new Set(db.units.map(u => u.status));
  Object.keys(UNIT_STATUS).forEach(s => assert.ok(statuses.has(s), `缺少状态 ${s}`));
  const imeis = db.units.map(u => u.imei1);
  assert.equal(new Set(imeis).size, imeis.length);
  db.units.filter(u => u.id.startsWith('t')).forEach(u => assert.ok(isImei(u.imei1), u.id));
  for (let n = 1001; n <= 1012; n += 1) {
    assert.ok(isImei(imeiOf(n)));
    assert.ok(!imeis.includes(imeiOf(n)), '备用串码不能被占用');
  }
});

test('预置单据与 docs/role-tests/00-预置数据.md 一致', async () => {
  const count = status => db.units.filter(u => u.status === status).length;
  assert.equal(count('in_stock'), 53);
  assert.equal(count('sold'), 7);
  assert.equal(db.salesTransactions.length, 8);
  assert.equal(db.loanTransactions.length, 3);
  assert.equal(db.repairTransactions.length, 8);
  assert.equal(db.customerRequests.length, 7);
  role = 'customer';
  assert.equal((await call('/shop/units', 'GET', { page: 1, pageSize: 100 })).data.total, 50);
  role = 'peer';
  assert.equal((await call('/shop/units', 'GET', { page: 1, pageSize: 100 })).data.total, 49);
  role = 'agent';
  const overview = (await call('/agent/overview')).data;
  assert.equal(overview.pendingAmount, 300);
  assert.equal(overview.settledAmount, 200);
  assert.equal((await call('/agent/units', 'GET', { page: 1, pageSize: 100 })).data.total, 48);
});

test('预置设备能走复检与收银：t55 复检通过，t64 留在待复检，字段按角色裁剪', async () => {
  role = 'warehouse';
  let form = (await call('/units/t55/recheck-form')).data;
  assert.equal((await call('/units/t55/recheck', 'POST', { inspectionVersion: form.inspectionVersion, result: 'pass', reason: '复检通过', attributes: form.values })).code, 0);
  assert.equal(db.units.find(u => u.id === 't55').status, 'in_stock');
  form = (await call('/units/t64/recheck-form')).data;
  assert.equal((await call('/units/t64/recheck', 'POST', { inspectionVersion: form.inspectionVersion, result: 'fail', reason: '屏幕异常', attributes: form.values })).code, 0);
  assert.equal(db.units.find(u => u.id === 't64').status, 'recheck');
  role = 'sales';
  const unit = (await call('/units/t03')).data;
  assert.equal(unit.cost, undefined);
  assert.equal(unit.supplier, undefined);
  assert.equal(unit.imei1, '35****0034');
});

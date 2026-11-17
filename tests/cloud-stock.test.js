const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'wx-server-sdk') return { init() {}, getWXContext: () => ({ OPENID: 'trusted-platform' }) };
  if (args[0]?.filename.startsWith(path.join(__dirname, '../cloudfunctions/common/')) && ['roles','status','template','validate'].some(k=>name==='./'+k)) {
    const key=name.slice(2);return load.call(this,path.join(__dirname,'../miniprogram', ['roles','status'].includes(key)?'constants':'utils',key),...args);
  }
  return load.call(this, name, ...args);
};
const { createHandler } = require('../cloudfunctions/common/gateway');
const { unit, view } = require('../cloudfunctions/common/stock-view');
const { prepare } = require('../cloudfunctions/common/stock-input');
const { suggest } = require('../cloudfunctions/common/pricing-suggest');
const { ROLE_PERMISSIONS, defaultVisibleFields } = require('../miniprogram/constants/roles');
Module._load = load;
const user = role => ({ id: 'user', staffNo: 'staff', role, permissions: ROLE_PERMISSIONS[role], visibleFields: defaultVisibleFields(role) });
const row = {
  id: 'unit', model_id: 'model', name: '设备', brand: '品牌', category_id: 'phone',
  status: 'in_stock', ownership: 'own', condition_type: 'used', imei1: '350000000000006',
  cost: 1000, retail: 1500, wholesale: 1400, agent_base: 1300, supplier_id: 'supplier',
  supplier_name: '内部供应商', internal_note: '内部备注', price_version: 1,
  attributes: { storage: '128G', supplier: '内部供应商', internalNote: '内部备注', battery: 90 },
  template_snapshot: { fields: [
    { key: 'storage', visibility: ['customer'], type: 'select' },
    { key: 'supplier', visibility: ['internal'], type: 'ref' },
    { key: 'internalNote', visibility: ['internal'], type: 'text' },
    { key: 'battery', visibility: ['customer'], type: 'number' }
  ] }, attached: [], share_flags: {}, created_at: new Date().toISOString()
};
test('云库存响应在字段和模板参数两层裁剪销售敏感数据', () => {
  const result = unit(row, user('sales'));
  for (const key of ['cost', 'supplier', 'supplierId', 'imei1', 'imei2', 'internalNote', 'agentBase']) assert.equal(Object.hasOwn(result, key), false, key);
  assert.equal(result.parameters.some(p => ['supplier', 'internalNote'].includes(p.key)), false);
  assert.equal(result.retail, 1500);
  assert.equal(result.wholesale, 1400);
  const boss = unit(row, user('boss'));
  assert.equal(boss.cost, 1000);
  assert.equal(boss.imei1, row.imei1);
});
test('角色自定义可见字段生效，库存汇总同样裁剪成本', () => {
  const sales = { ...user('sales'), visibleFields: ['cost'] };
  assert.equal(unit(row, sales).cost, 1000);
  assert.equal(Object.hasOwn(unit(row, sales), 'wholesale'), false);
  const result = view('units.list', { rows: [row], total: 1, counts: {}, summary: { costTotal: 1000, retailTotal: 1500 } }, { page: 1, pageSize: 20 }, user('sales'));
  assert.equal(Object.hasOwn(result.summary, 'costTotal'), false);
  assert.equal(result.summary.retailTotal, 1500);
});
test('参数路由精确匹配，身份只取平台上下文', async () => {
  const handler = createHandler([
    ['GET', '/units/share-flags', () => 'fixed'],
    ['GET', '/units/:id', ctx => ({ id: ctx.params.id, openid: ctx.openid })],
    ['GET', '/literal/1.0', () => true]
  ]);
  assert.deepEqual((await handler({ path: '/units/device', openid: 'forged', data: { openid: 'forged' } })).data, { id: 'device', openid: 'trusted-platform' });
  assert.equal((await handler({ path: '/units/share-flags' })).data, 'fixed');
  assert.equal((await handler({ path: '/units/' })).code, 404);
  assert.equal((await handler({ path: '/literal/1x0' })).code, 404);
  assert.equal((await handler({ path: '/literal/1.0' })).code, 0);
  assert.equal((await handler({ path: '/units/device', method: 'DELETE' })).code, 404);
});
test('改价必须有原因，盘点仅允许店内库存状态', () => {
  assert.throws(() => prepare('units.price', { retail: 1, priceVersion: 1 }, {}, user('boss')), /改价原因/);
  assert.throws(() => prepare('sessions.create', { requestKey: 'k', statuses: ['sold'] }, {}, user('boss')), /店内/);
  assert.throws(() => prepare('sales.create', { items: [{ unitId: 'u' }, { unitId: 'u' }] }, {}, user('boss')), /重复/);
});
test('无附件读取权时不返回内部文件标识和存储路径', () => {
  const result = unit({ ...row, attached: [{ id: 'private-proof', owner_id: 'other', scope: 'internal', stored_name: 'secret/object', field_key: 'receipt', mime: 'image/png' }] }, user('sales'));
  assert.equal(JSON.stringify(result).includes('private-proof'), false);
  assert.equal(JSON.stringify(result).includes('secret/object'), false);
});

test('真实云函数定价按分精确计算，支持独立利润及旧折扣规则', () => {
 assert.deepEqual(suggest({cost:'0.10',retailProfit:'0.20'}),{retail:0.3,retailProfit:0.2});
 assert.deepEqual(suggest({cost:4000,wholesaleProfit:300}),{wholesale:4300,wholesaleProfit:300,agentBase:4300,agentProfit:300});
 assert.equal(suggest({cost:4000,targetProfit:600},'300').wholesale,4300);
 assert.equal(suggest({cost:4000,wholesaleProfit:300,agentProfit:0}).agentBase,4000);
 assert.throws(()=>suggest({cost:'999999999999.99',retailProfit:'.01'}),/金额/);
 assert.throws(()=>prepare('pricing.suggest',{cost:100,retailProfit:-1},{},user('boss')),/金额/);
});

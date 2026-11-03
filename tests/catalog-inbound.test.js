const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../miniprogram/mock/data');
let role = 'boss';
global.wx = { getStorageSync: () => role };
const mock = require('../miniprogram/mock');
const call = (url, method = 'GET', data = {}) => mock.handle({ url, method, data });
// 全部 TAC / IMEI 均为测试夹具，不代表真实机型数据库。
function imei(serial) {
  const prefix = '99000000' + String(serial).padStart(6, '0');
  let sum = 0; [...prefix].forEach((v, i) => { let d = Number(v) * (i % 2 ? 2 : 1); sum += d > 9 ? d - 9 : d; });
  return prefix + (10 - sum % 10) % 10;
}
function values(fields) {
  const result = {};
  fields.forEach(f => { result[f.key] = f.type === 'select' ? f.options[0] : f.type === 'image' ? [{ fileId: 'fixture', url: 'fixture-private' }] : f.type === 'number' ? 96 : '测试输入'; });
  return result;
}
test('分类与型号管理、独立模板、核验映射、整批原子性', async () => {
  for (const r of ['customer', 'agent', 'sales', 'warehouse']) {
    role = r;
    assert.equal((await call('/catalog/categories', 'POST', { label: '不能创建' })).code, 403);
    assert.equal((await call('/models', 'POST', {})).code, 403);
  }
  role = 'boss';
  const category = (await call('/catalog/categories', 'POST', { label: '游戏掌机' })).data;
  assert.ok(category.value);
  assert.equal((await call('/catalog/categories', 'POST', { label: ' 游戏掌机 ' })).code, 400);
  assert.equal((await call(`/catalog/categories/${category.value}`, 'PUT', { label: '掌机' })).code, 0);
  const payload = { category: category.value, name: '测试设备', brandLabel: '测试品牌', series: '测试系列', copyTemplateId: 't_phone', tacs: [] };
  const model = (await call('/models', 'POST', payload)).data;
  assert.ok(model.id); assert.notEqual(model.templateId, 't_phone');
  const template = (await call(`/templates/${model.templateId}`)).data;
  assert.equal(template.version, 1);
  assert.equal((await call('/models', 'POST', payload)).code, 400);
  let result = await call('/inbound/identify-model', 'POST', { imei: imei(1) });
  assert.equal(result.data.matched, false);
  assert.equal((await call(`/models/${model.id}`, 'PUT', { ...payload, tacs: ['99000000'] })).code, 400);
  assert.equal((await call(`/models/${model.id}`, 'PUT', { ...payload, tacs: ['99000000'], tacSource: '自动化测试夹具，非真实映射' })).code, 0);
  result = await call('/inbound/identify-model', 'POST', { imei: imei(1) });
  assert.equal(result.data.matched, true); assert.equal(result.data.model.id, model.id);
  for (const key of ['storage', 'color', 'battery', 'cost', 'tacs']) assert.equal(result.data.model[key], undefined);
  assert.equal((await call('/models', 'POST', { ...payload, name: '另一个型号', tacs: ['99000000'], tacSource: '测试夹具' })).code, 409);
  const tree = (await call('/models/tree', 'GET', { category: category.value })).data;
  assert.equal(tree[0].series[0].models[0].id, model.id);
  role = 'warehouse';
  const warehouseTree = (await call('/models/tree', 'GET', { category: category.value })).data;
  assert.equal(warehouseTree[0].series[0].models[0].tacs, undefined);
  role = 'customer';
  const publicCategories = (await call('/shop/categories')).data;
  assert.equal(publicCategories.find(c => c.value === category.value).label, '掌机');
  assert.match(JSON.stringify(publicCategories), /测试设备/); assert.doesNotMatch(JSON.stringify(publicCategories), /99000000/);
  assert.equal((await call('/inbound/identify-model', 'POST', { imei: imei(1) })).code, 403);
  role = 'boss';
  const common = { modelId: model.id, templateVersion: template.version, condition: 'new', attributes: values(template.fields), cost: '200', retail: '300', wholesale: '260', agentBase: '260', flags: { showInShop: true, sharePeer: true, shareAgent: false } };
  const before = db.units.length;
  const wrongModel = await call('/inbound/units', 'POST', { ...common, modelId: 'm_17pm', templateVersion: db.templates.find(t => t.id === 't_phone').version, imei1: imei(4) });
  assert.equal(wrongModel.code, 400); assert.match(wrongModel.message, /型号不一致/);
  const badPresets = await call(`/templates/${model.templateId}/versions`, 'POST', { baseVersion: template.version, fields: template.fields, descriptionPresets: { peer: ['有效'], customer: Array(7).fill('过多描述') } });
  assert.equal(badPresets.code, 400);
  assert.equal(db.units.length, before);
  for (const units of [[], [{ imei1: imei(1) }, { imei1: imei(1) }], [{ imei1: imei(1) }, { imei1: imei(2), cost: -1 }], [{ imei1: imei(1), imei2: imei(1) }], [{ imei1: imei(1), attributes: { battery: 101 } }]]) {
    assert.equal((await call('/inbound/batch', 'POST', { common, units })).code, 400);
    assert.equal(db.units.length, before, '校验失败不得留下部分库存');
  }
  const committed = await call('/inbound/batch', 'POST', { common, units: [{ imei1: imei(1) }, { imei1: imei(2), cost: '210', attributes: { battery: 88, grade: '95新' } }] });
  assert.equal(committed.code, 0); assert.equal(committed.data.created, 2); assert.equal(new Set(committed.data.ids).size, 2);
  assert.equal(db.units.length, before + 2);
  const second = db.units.find(u => u.imei1 === imei(2));
  assert.ok(db.auditLogs.some(a => a.action === '新增分类' && a.operator === '老板'));
  assert.ok(db.auditLogs.some(a => a.action === '入库' && a.operator === '老板'));
  assert.equal(second.cost, 210); assert.equal(second.attributes.battery, 88); assert.equal(second.condition, 'new');
  const repairing = await call('/inbound/units', 'POST', { ...common, imei1: imei(3), attributes: { ...common.attributes, refurbishment: '正在整备' } });
  assert.equal(repairing.code, 0);
  const unit = db.units.find(u => u.id === repairing.data.id);
  assert.equal(unit.status, 'recheck'); assert.equal(unit.flags.showInShop, false);
  role = 'customer'; assert.equal((await call(`/shop/units/${unit.id}`)).code, 404);
  role = 'sales'; assert.equal((await call('/inbound/batch', 'POST', { common, units: [{ imei1: imei(4) }] })).code, 403);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../miniprogram/mock/data');
let role = 'boss';
global.wx = { getStorageSync: () => role };
const mock = require('../miniprogram/mock');
const call = (url, method = 'GET', data = {}) => mock.handle({ url, method, data });
// 全部 TAC / IMEI 均为测试夹具，不代表真实机型数据库。
function imei(serial, tac = '99000000') {
  const prefix = tac + String(serial).padStart(6, '0');
  let sum = 0; [...prefix].forEach((v, i) => { let d = Number(v) * (i % 2 ? 2 : 1); sum += d > 9 ? d - 9 : d; });
  return prefix + (10 - sum % 10) % 10;
}
function values(fields) {
  const result = {};
  fields.forEach(f => { result[f.key] = f.type === 'select' ? f.options[0] : f.type === 'image' ? [{ fileId: 'fixture', url: 'fixture-private' }] : f.type === 'number' ? 96 : f.type === 'date' ? '2027-01-01' : '测试输入'; });
  return result;
}
test('分类与型号管理、分类模板与型号规格、核验映射、整批原子性', async () => {
  for (const r of ['customer', 'agent', 'sales', 'warehouse']) {
    role = r;
    assert.equal((await call('/catalog/categories', 'POST', { label: '不能创建' })).code, 403);
    assert.equal((await call('/models', 'POST', {})).code, 403);
  }
  role = 'boss';
  assert.equal((await call('/catalog/categories', 'POST', { label: '游戏掌机' })).code, 400);
  // 新分类默认按序列号入库；这里沿用 IMEI 流程验证型号一致性与整批原子性
  const category = (await call('/catalog/categories', 'POST', { label: '游戏掌机', copyTemplateId: 't_phone', identifierMode: 'imei' })).data;
  assert.equal(category.identifierMode, 'imei');
  assert.equal((await call('/catalog/categories', 'POST', { label: '相机', copyTemplateId: 't_other' })).data.identifierMode, 'serial');
  assert.equal((await call('/catalog/categories', 'POST', { label: '无效方式', copyTemplateId: 't_other', identifierMode: 'barcode' })).code, 400);
  assert.ok(category.value); assert.ok(category.templateId); assert.notEqual(category.templateId, 't_phone');
  assert.equal((await call('/catalog/categories', 'POST', { label: ' 游戏掌机 ' })).code, 400);
  assert.equal((await call(`/catalog/categories/${category.value}`, 'PUT', { label: '掌机' })).code, 0);
  const payload = { category: category.value, name: '测试设备', brandLabel: '测试品牌', series: '测试系列', tacs: [] };
  const model = (await call('/models', 'POST', payload)).data;
  assert.ok(model.id); assert.equal(model.templateId, category.templateId);
  // 同分类的型号共用分类模板，只各自配置容量和颜色
  assert.equal((await call('/models', 'POST', { ...payload, name: '重复规格', specs: { color: ['红', '红'] } })).code, 400);
  const colored = (await call('/models', 'POST', { ...payload, name: '带颜色型号', specs: { storage: ['1T'], color: ['冰川白'] } })).data;
  assert.equal(colored.templateId, category.templateId);
  const coloredForm = (await call(`/models/${colored.id}/form`)).data;
  assert.deepEqual(coloredForm.fields.find(f => f.key === 'color').options, ['冰川白']);
  assert.deepEqual(coloredForm.fields.find(f => f.key === 'storage').options, ['1T']);
  assert.ok(coloredForm.fields.some(f => f.key === 'idLock') && !coloredForm.fields.find(f => f.key === 'grade').options.includes('未激活'));
  const template = (await call(`/models/${model.id}/form`)).data;
  assert.equal(template.version, 1); assert.equal(template.id, category.templateId);
  const colorBad = await call('/inbound/units', 'POST', { modelId: colored.id, templateVersion: coloredForm.version, condition: 'new', attributes: { ...values(coloredForm.fields), color: '黑色' }, cost: '1', retail: '2', wholesale: '2', agentBase: '2', imei1: imei(9), flags: { showInShop: false, sharePeer: false, shareAgent: false } });
  assert.equal(colorBad.code, 400);
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
  // 顾客目录只列有现货的型号：新型号还没入库，不应出现
  assert.doesNotMatch(JSON.stringify(publicCategories), /测试设备/); assert.doesNotMatch(JSON.stringify(publicCategories), /99000000/);
  assert.equal((await call('/inbound/identify-model', 'POST', { imei: imei(1) })).code, 403);
  role = 'boss';
  const common = { modelId: model.id, templateVersion: template.version, condition: 'new', attributes: values(template.fields), cost: '200', retail: '300', wholesale: '260', agentBase: '260', flags: { showInShop: true, sharePeer: true, shareAgent: false } };
  const before = db.units.length;
  const otherForm = (await call('/models/m_17pm/form')).data;
  const wrongModel = await call('/inbound/units', 'POST', { ...common, modelId: 'm_17pm', templateVersion: otherForm.version, attributes: values(otherForm.fields), imei1: imei(4) });
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
  role = 'customer';
  const stockedCategories = JSON.stringify((await call('/shop/categories')).data);
  assert.match(stockedCategories, /测试设备/, '入库并对外展示后进入顾客目录');
  assert.doesNotMatch(stockedCategories, /99000000/);
  role = 'boss';
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

test('手机和平板的运行内存独立于存储容量，批量可逐台覆盖且商品可搜索', async () => {
  role = 'boss';
  const modelData = { brandLabel: '测试品牌', series: '运行内存测试', specs: { storage: ['256G'], ram: ['8GB', '12GB'] } };
  const phone = (await call('/models', 'POST', { ...modelData, category: 'phone', name: '运行内存测试手机' })).data;
  const tablet = (await call('/models', 'POST', { ...modelData, category: 'tablet', name: '运行内存测试平板' })).data;
  const forms = await Promise.all([phone, tablet].map(async m => (await call(`/models/${m.id}/form`)).data));
  for (const form of forms) {
    const ram = form.fields.find(f => f.key === 'ram');
    assert.deepEqual(ram.options, ['8GB', '12GB']);
    assert.equal(ram.required, false);
    assert.deepEqual(form.fields.find(f => f.key === 'storage').options, ['256G']);
  }
  const common = {
    modelId: phone.id, templateVersion: forms[0].version, condition: 'new',
    attributes: { ...values(forms[0].fields), ram: '8GB' },
    cost: '200', retail: '300', wholesale: '260', agentBase: '260',
    flags: { showInShop: true, sharePeer: true, shareAgent: false }
  };
  const bad = await call('/inbound/batch', 'POST', { common, units: [{ imei1: imei(41, '99000001'), attributes: { ram: '16GB' } }] });
  assert.equal(bad.code, 400);
  const saved = await call('/inbound/batch', 'POST', { common, units: [{ imei1: imei(41, '99000001') }, { imei1: imei(42, '99000001'), attributes: { ram: '12GB' } }] });
  assert.equal(saved.code, 0, saved.message);
  const [first, second] = await Promise.all(saved.data.ids.map(id => call(`/units/${id}`)));
  assert.equal(first.data.ram, '8GB');
  assert.equal(second.data.ram, '12GB');
  assert.equal(second.data.storage, '256G');
  const supplier = (await call('/suppliers', 'GET', { active: true })).data.list[0];
  const purchase = await call('/purchase-orders', 'POST', {
    supplierId: supplier.id, expectedAt: '2027-01-01',
    lines: [{ modelId: tablet.id, quantity: 1, unitCost: '100', attributes: { ram: '12GB' } }],
  });
  assert.equal(purchase.code, 0, purchase.message);
  assert.equal(purchase.data.lines[0].attributes.ram, '12GB');
  role = 'customer';
  const filtered = await call('/shop/units', 'GET', { keyword: '12GB' });
  const result = filtered.data.list.find(u => u.id === second.data.id);
  assert.equal(result.ram, '12GB');
  assert.equal(result.publicFields.find(f => f.key === 'ram').value, '12GB');
  assert.ok(!filtered.data.list.some(u => u.id === first.data.id));
});

test('按品牌选系列、随型号新增系列、删除最后一个型号，以及引用保护', async () => {
  role = 'boss';
  const existing = db.models.find(m => m.category === 'phone' && m.brand === 'apple');
  const series = () => call('/models/series', 'GET', { category: 'phone', brand: 'apple' });
  assert.ok((await series()).data.includes(existing.series));
  assert.equal((await call('/models/series', 'GET', { category: 'phone' })).code, 400);

  const payload = { category: 'phone', brandId: 'apple', brandLabel: '苹果', series: 'Test Model Series' };
  const first = (await call('/models', 'POST', {
    ...payload, name: '系列测试一号', tacs: ['99000002'], tacSource: '自动化测试夹具'
  })).data;
  const second = (await call('/models', 'POST', {
    ...payload, name: '系列测试二号', series: payload.series.toLowerCase()
  })).data;
  assert.equal(first.brand, 'apple');
  assert.equal(second.series, first.series);
  assert.ok((await series()).data.includes(payload.series));
  const tabletSeries = await call('/models/series', 'GET', { category: 'tablet', brand: 'apple' });
  assert.ok(!tabletSeries.data.includes(payload.series));

  role = 'warehouse';
  assert.equal((await call(`/models/${first.id}`, 'DELETE')).code, 403);
  role = 'boss';
  assert.deepEqual((await call(`/models/${first.id}`, 'DELETE')).data, { id: first.id, deleted: true });
  assert.equal((await call('/inbound/identify-model', 'POST', { imei: imei(15, '99000002') })).data.matched, false);
  assert.ok((await series()).data.includes(payload.series));
  assert.equal((await call(`/models/${second.id}`, 'DELETE')).code, 0);
  assert.ok(!(await series()).data.includes(payload.series));
  assert.equal((await call(`/models/${second.id}/form`)).code, 404);
  assert.ok(db.auditLogs.some(a => a.action === '删除型号' && a.detail === second.name));

  const purchased = db.purchaseOrders.flatMap(po => po.lines).find(line => line.modelId);
  assert.equal((await call(`/models/${purchased.modelId}`, 'DELETE')).code, 409);
  const soldOrStocked = db.units.find(unit => unit.modelId);
  assert.equal((await call(`/models/${soldOrStocked.modelId}`, 'DELETE')).code, 409);
});

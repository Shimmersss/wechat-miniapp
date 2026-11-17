const test = require('node:test');
const assert = require('node:assert/strict');
let role = 'boss';
global.wx = { getStorageSync: () => role };
const mock = require('../miniprogram/mock');
const db = require('../miniprogram/mock/data');
const { normalizeSerial, serialError, isSerial, noSerialReasonError } = require('../miniprogram/utils/validate');
const { IDENTIFIER_MODES, NO_SERIAL_REASONS, CONDITION_TYPE_DEVICE } = require('../miniprogram/constants/status');
const call = (url, method = 'GET', data = {}) => mock.handle({ url, method, data, header: {} });

/** 按模板为每个必填项填一个可用值；供应商和凭证按 mock 规则填写 */
function values(fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'select') out[f.key] = f.default || f.options[0];
    else if (f.type === 'number') out[f.key] = 90;
    else if (f.type === 'image') out[f.key] = [{ fileId: 'seed', url: '/x.jpg' }];
    else if (f.key === 'supplier') out[f.key] = '深圳严选供应链';
    else if (f.required) out[f.key] = '测试';
  }
  return out;
}

async function modelIn(category, name) {
  const created = await call('/models', 'POST', { category, brandLabel: '测试品牌', series: '测试系列', name, specs: { storage: [], color: [] } });
  assert.equal(created.code, 0, created.message);
  const form = (await call(`/models/${created.data.id}/form`)).data;
  return { model: created.data, form };
}

function common({ model, form }) {
  return { modelId: model.id, templateVersion: form.version, condition: 'used', attributes: values(form.fields), cost: '100', retail: '150', wholesale: '140', agentBase: '140', flags: { showInShop: true, sharePeer: false, shareAgent: false } };
}

test('序列号校验：规范化、长度与字符、IMEI 误填、无序列号原因', () => {
  assert.equal(normalizeSerial('  ab-12x '), 'AB-12X');
  assert.equal(serialError('ab-12x'), '');
  assert.equal(isSerial('AB1'), false);
  assert.match(serialError('AB_123'), /4～40 位/);
  assert.match(serialError('490154203237518'), /IMEI/);
  assert.equal(serialError('490154203237519'), '', '校验位不对的 15 位数字仍可作序列号');
  assert.match(noSerialReasonError(' 无 '), /2～100字/);
  assert.equal(noSerialReasonError('配件无序列号'), '');
  assert.deepEqual(IDENTIFIER_MODES.map(m => m.value), ['imei', 'serial', 'serial_imei']);
  assert.ok(NO_SERIAL_REASONS.includes('其他'));
  assert.deepEqual(CONDITION_TYPE_DEVICE.map(c => c.label), ['二手', '全新']);
});

test('mock 分类：顺序、串码方式、模板按品类裁剪；有设备时不能改串码方式', async () => {
  role = 'boss';
  const list = (await call('/catalog/categories')).data.list;
  assert.deepEqual(list.map(c => c.value), ['phone', 'tablet', 'audio', 'accessory', 'other']);
  assert.deepEqual(list.map(c => c.identifierMode), ['imei', 'serial_imei', 'serial', 'serial', 'serial']);
  const accessory = db.templates.find(t => t.id === 't_accessory');
  assert.ok(!accessory.fields.some(f => f.key === 'battery'));
  assert.equal(accessory.fields[accessory.fields.length - 1].key, 'receipt');
  assert.ok(db.templates.find(t => t.id === 't_audio').fields.some(f => f.key === 'kitStatus'));
  assert.equal((await call('/catalog/categories/phone', 'PUT', { label: '手机', identifierMode: 'serial' })).code, 409);
  const shop = (await call('/shop/categories')).data;
  assert.equal(shop.find(c => c.value === 'tablet').identifierMode, 'serial_imei');
});

test('mock 非手机入库：推荐序列号，同型号查重，无序列号须说明原因，可按数量入库', async () => {
  role = 'boss';
  const audio = await modelIn('audio', '测试耳机 A');
  const other = await modelIn('audio', '测试耳机 B');
  const base = common(audio);
  const ok = await call('/inbound/units', 'POST', { ...base, serialNo: ' sn-0001 ' });
  assert.equal(ok.code, 0, ok.message);
  assert.equal(db.units.find(u => u.id === ok.data.id).serialNo, 'SN-0001');
  assert.equal((await call('/inbound/units', 'POST', { ...base, serialNo: 'SN-0001' })).code, 409);
  assert.equal((await call('/inbound/check-serial', 'POST', { modelId: audio.model.id, serialNo: 'sn-0001' })).data.unique, false);
  assert.equal((await call('/inbound/check-serial', 'POST', { modelId: other.model.id, serialNo: 'SN-0001' })).data.unique, true, '跨型号相同序列号不算重复');
  assert.equal((await call('/inbound/units', 'POST', { ...common(other), serialNo: 'SN-0001' })).code, 0);
  assert.match((await call('/inbound/units', 'POST', base)).message, /原因/);
  assert.match((await call('/inbound/units', 'POST', { ...base, imei1: '490154203237518' })).message, /不登记 IMEI/);
  const before = db.units.length;
  const lot = await call('/inbound/units', 'POST', { ...base, noSerialReason: '配件无序列号', quantity: 3 });
  assert.equal(lot.code, 0, lot.message);
  assert.equal(lot.data.created, 3);
  assert.equal(db.units.length, before + 3);
  assert.equal(new Set(db.units.filter(u => u.lotId === lot.data.lotId).map(u => u.id)).size, 3);
  assert.equal((await call('/inbound/units', 'POST', { ...base, noSerialReason: '配件无序列号', quantity: 2, serialNo: 'SN-9' })).code, 400);
  assert.equal((await call('/inbound/units', 'POST', { ...base, noSerialReason: '配件无序列号', quantity: 101 })).code, 400);

  // 顾客端：同批折叠为一张卡片
  role = 'customer';
  const shop = (await call('/shop/units', 'GET', { brandKey: 'audio', pageSize: 100 })).data;
  const folded = shop.list.filter(u => u.lotCount);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].lotCount, 3);
  assert.ok(shop.list.every(u => u.serialNo === undefined && u.noSerialReason === undefined));
  assert.match(shop.list.find(u => u.serialMasked).serialMasked, /^\w{2}\*{4}\w{3}$/);

  // 员工端：按批次、无串码筛选，按序列号收银查找
  role = 'boss';
  assert.equal((await call('/units', 'GET', { lotId: lot.data.lotId, pageSize: 50 })).data.total, 3);
  assert.ok((await call('/units', 'GET', { noSerial: 'true', pageSize: 200 })).data.list.every(u => !u.imei1 && !u.serialMasked));
  assert.equal((await call('/sales/lookup', 'GET', { code: 'SN-0001' })).code, 409, '两台不同型号同序列号时要求改扫标签');
});

test('mock 平板：序列号外可选填 IMEI；手机仍须 IMEI', async () => {
  role = 'boss';
  const tablet = await modelIn('tablet', '测试平板');
  const base = common(tablet);
  assert.equal((await call('/inbound/units', 'POST', { ...base, serialNo: 'TAB-1', imei1: '490154203237518' })).code, 0);
  assert.match((await call('/inbound/units', 'POST', { ...base, serialNo: 'TAB-2', imei2: '356938035643809' })).message, /IMEI2/);
  const phoneForm = (await call('/models/m_17p/form')).data;
  const phone = { ...common({ model: { id: 'm_17p' }, form: phoneForm }) };
  assert.match((await call('/inbound/units', 'POST', { ...phone, serialNo: 'PHONE-1' })).message, /手机请填写 IMEI/);
});

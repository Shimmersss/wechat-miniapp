const test = require('node:test');
const assert = require('node:assert/strict');
const { firstError } = require('../miniprogram/utils/validate');
const pageModule = require('../miniprogram/utils/page');

function controller(file, overrides = {}) {
  let definition;
  const register = pageModule.createPage;
  pageModule.createPage = page => { definition = page; };
  try { require('../miniprogram/packages/' + file); }
  finally { pageModule.createPage = register; }
  return instance(definition, overrides);
}

function instance(definition, overrides) {
  const scroll = [];
  global.wx = { pageScrollTo: options => scroll.push(options.selector) };
  return {
    ...definition, data: { ...structuredClone(definition.data), ...overrides }, scroll,
    setData(update, then) { Object.assign(this.data, update); then?.(); },
  };
}

test('firstError 按字段顺序并保留零与 false', () => {
  const rules = [['amount', value => value === '' && '金额必填'], ['agree', value => !value && '请同意']];
  assert.deepEqual(firstError(rules, { amount: '', agree: false }), { field: 'amount', message: '金额必填' });
  assert.deepEqual(firstError(rules, { amount: 0, agree: false }), { field: 'agree', message: '请同意' });
});

test('单台和批量入库跳到缺少型号的位置', async () => {
  const create = require('../miniprogram/packages/staff/inbound/form');
  for (const batch of [false, true]) {
    const page = instance(create(batch), {});
    await page.onSubmit();
    assert.deepEqual(page.data.errors, { model: '请先选择型号' });
    assert.deepEqual(page.scroll, ['#field-model']);
  }
});

test('收银标出空设备列表和有格式错误的成交价', async () => {
  const page = controller('staff/pos/index');
  await page.onCheckout();
  assert.deepEqual(page.scroll, ['#field-cart']);
  page.data.cart = [{ price: '3.333' }];
  await page.onCheckout();
  assert.deepEqual(page.data.errors, { 'price-0': '请输入有效成交价，最多两位小数' });
});

test('采购先标供应商，再定位出错的明细数量或单价', async () => {
  const page = controller('staff/purchase/edit');
  await page.onSubmit();
  assert.deepEqual(page.scroll, ['#field-supplierId']);
  Object.assign(page.data.form, { supplierId: 'supplier', expectedAt: '2026-11-19' });
  page.data.lines = [{ modelId: 'model', quantity: 0, unitCost: '' }];
  await page.onSubmit();
  assert.deepEqual(Object.keys(page.data.errors), ['line-0-quantity']);
  page.data.lines[0].quantity = 1;
  await page.onSubmit();
  assert.deepEqual(Object.keys(page.data.errors), ['line-0-unitCost']);
});

test('借还表单标出对方、电话和借入串码', () => {
  const page = controller('staff/loans/edit');
  page.onSubmit();
  assert.deepEqual(page.scroll, ['#field-counterparty']);
  Object.assign(page.data.form, { counterparty: '门店', phone: '123' });
  page.onSubmit();
  assert.deepEqual(Object.keys(page.data.errors), ['phone']);
  Object.assign(page.data.form, { phone: '13900000000', dueAt: '2026-11-19', reason: '演示', type: 'borrow_in' });
  page.data.devices = [{ model: { id: 'm' }, identifierMode: 'imei', imei1: '123', imei2: '' }];
  page.onSubmit();
  assert.deepEqual(Object.keys(page.data.errors), ['device-0-imei1']);
});

test('代理申请和员工新增分别标出姓名及错误手机号', async () => {
  const apply = controller('agent/apply/index');
  await apply.onSubmit();
  assert.deepEqual(apply.scroll, ['#field-name']);
  apply.data.form.name = '联系人';
  await apply.onSubmit();
  assert.deepEqual(Object.keys(apply.data.errors), ['phone']);

  const staff = controller('staff/staff/index', {
    staffWechatLogin: true, editor: { mode: 'create', name: '', phone: '123', roleIndex: 0 },
  });
  await staff.onSaveEditor();
  assert.deepEqual(staff.scroll, ['#field-name']);
  staff.data.editor.name = '员工';
  await staff.onSaveEditor();
  assert.deepEqual(Object.keys(staff.data.errors), ['phone']);
});

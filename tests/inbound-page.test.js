const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const schema = require('../miniprogram/utils/template');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function page(inbound) {
  const context = { module: { exports: {} }, setTimeout, clearTimeout, getCurrentPages: () => [], wx: { showModal: o => o.success({ confirm: true }) }, require(name) {
    if (name.endsWith('/api/index')) return { inbound, template: {} };
    if (name.endsWith('/constants/roles')) return { PERM: { INBOUND: 'inbound:do' } };
    if (name.endsWith('/utils/router')) return { ROUTES: {} };
    if (name.endsWith('/utils/template')) return schema;
    if (name.endsWith('/utils/validate')) return require('../miniprogram/utils/validate');
    return {};
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/packages/staff/inbound/form'), 'utf8'), context);
  const p = context.module.exports(true); p.data = JSON.parse(JSON.stringify(p.data)); p.notices = [];
  p.$toast = text => p.notices.push(text);
  p.setData = patch => Object.entries(patch).forEach(([key, value]) => {
    const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = p.data;
    parts.slice(0, -1).forEach(k => { target = target[k]; }); target[parts.at(-1)] = value;
  });
  return p;
}
test('IMEI 输入修改后忽略迟到的识别与校验结果', async () => {
  const check = deferred(), identify = deferred();
  const p = page({ checkImei: () => check.promise, identifyModel: () => identify.promise });
  const key = p.data.rows[0].key;
  p.data.rows[0].imei1 = '490154203237518';
  const request = p.checkRow(key);
  p.onRowInput({ currentTarget: { dataset: { row: key, field: 'imei1' } }, detail: { value: '123' } });
  check.resolve({ unique: true }); identify.resolve({ matched: true, model: { id: 'different' } }); await request;
  assert.equal(p.data.rows[0].state, ''); assert.equal(p.data.rows[0].matchModelId, ''); assert.equal(p.data.model, null);
});
test('批量提交保留已校验快照、公共参数与逐台覆盖；上传中不能提交', async () => {
  let payload;
  const p = page({ createBatch: async d => { payload = d; return { created: d.units.length }; } });
  p.data.model = { id: 'test-model', name: '测试机' }; p.data.templateVersion = 2;
  p.data.templateFields = [{ key: 'battery', label: '电池', type: 'number', required: true, min: 0, max: 100 }];
  p.data.attributes = { battery: 90 };
  Object.assign(p.data.form, { cost: '200', retail: '300', wholesale: '250', agentBase: '250' });
  Object.assign(p.data.rows[0], { imei1: '490154203237518', state: 'ok', attributes: { battery: 85 } });
  p.onSubmit(); assert.equal(payload, undefined);
  p.data.form.inspectionConfirmed = true;
  p.data.fieldUploads = 1; p.onSubmit(); assert.equal(payload, undefined);
  p.data.fieldUploads = 0; p.onSubmit(); await new Promise(setImmediate);
  assert.equal(payload.common.modelId, 'test-model'); assert.equal(payload.common.templateVersion, 2);
  assert.equal(payload.common.inspectionConfirmed, true);
  assert.equal(payload.units[0].attributes.battery, 85); assert.equal(payload.units[0].cost, '200');
  assert.equal(p.data.rows[0].imei1, ''); assert.equal(p.data.submitting, false);
});

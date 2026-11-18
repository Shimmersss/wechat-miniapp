const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../miniprogram/api/index');
const { detailPage } = require('../miniprogram/utils/customer-request-page');

test('员工跟进立即保存；撤销沿用成功的版本和原操作标识，提示五秒后消失', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  let status = 'new', version = 1;
  t.mock.method(api.customerRequest, 'updateStatus', async (_id, input) => {
    calls.push(input);
    status = input.status;
    return { status, version: ++version };
  });
  t.mock.method(api.customerRequest, 'detail', async () => ({
    kind: 'consult', status, version, actions: status === 'new' ? ['contacted', 'closed'] : ['closed'],
  }));
  const definition = detailPage(true);
  const page = {
    ...definition, data: structuredClone(definition.data),
    setData(update) { Object.assign(this.data, update); },
  };
  await page.onLoad({ id: 'consult' });
  await page.onChange();
  assert.equal(calls[0].reason, '跟进状态变更');
  assert.equal(page.data.undo.label, '已联系');
  t.mock.timers.tick(4999);
  assert.ok(page.data.undo);
  await page.onUndo();
  assert.equal(calls[1].reason, '撤销跟进状态变更');
  assert.equal(calls[1].undoOf, calls[0].requestKey);
  assert.equal(calls[1].version, 2);
  assert.equal(page.data.detail.status, 'new');

  await page.onChange();
  t.mock.timers.tick(5000);
  assert.equal(page.data.undo, null);
  await page.onUndo();
  assert.equal(calls.length, 3);
  page.onUnload();
});

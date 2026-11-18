const test = require('node:test');
const assert = require('node:assert/strict');

function withModal(answer, fn) {
  const calls = [];
  global.wx = { showModal: (o) => { calls.push(o); o.success({ confirm: answer }); }, showToast() {} };
  delete require.cache[require.resolve('../miniprogram/utils/confirm')];
  return fn(require('../miniprogram/utils/confirm'), calls);
}

test('敏感操作只需二次点击：不弹输入框，原因用操作标题', () =>
  withModal(true, async ({ confirmSensitive }, calls) => {
    const r = await confirmSensitive({ title: '确认修改单机价格', content: '填写改价原因，将记录原价与新价', needReason: true });
    assert.deepEqual(r, { confirmed: true, reason: '确认修改单机价格' });
    assert.ok(!calls[0].editable);
    assert.equal(calls[0].content, '将记录原价与新价');
  }));

test('取消时不提交', () =>
  withModal(false, async ({ confirmSensitive }) => {
    assert.deepEqual(await confirmSensitive({ title: '撤销分享', needReason: true }), { confirmed: false, reason: '' });
  }));

test('提示去掉输入要求和示例', () =>
  withModal(true, ({ describe }) => {
    assert.equal(describe('请填写处理说明，如：在维修柜找到、已报警'), '确认后将记录到操作日志');
    assert.equal(describe('确认已收到该运单，填写签收说明'), '确认已收到该运单');
    assert.equal(describe(''), '确认后将记录到操作日志');
  }));

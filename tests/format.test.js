const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const format = require('../miniprogram/utils/format');
const context = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/utils/filters.wxs'), 'utf8'), context);
const wxs = context.module.exports;
test('采购与售价保留分，JS/WXS 金额显示一致且可遮挡', () => {
  for (const [value, expected] of [[2012.58, '2,012.58'], ['1000.12', '1,000.12'], [12.5, '12.50'], [1200, '1,200'], [0, '0'], [-12.34, '-12.34'], [0.01, '0.01'], [null, '--'], ['', '--'], [Infinity, '--']]) {
    assert.equal(format.money(value), expected);
    assert.equal(wxs.money(value), expected);
    assert.equal(format.maskMoney(value, true), '••••'); assert.equal(wxs.maskMoney(value, true), '••••');
  }
  assert.equal(format.money(12.5, 0), '13'); assert.equal(wxs.money(12.5, 0), '13');
});

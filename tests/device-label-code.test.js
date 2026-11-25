const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeDeviceLabel } = require('../miniprogram/utils/device-label-code');
const { unitCode } = require('../miniprogram/utils/scan');
const { deviceBarcode } = require('../miniprogram/packages/staff/inventory/label-pdf');

test('设备标签在保留完整 UUID 的同时使用紧凑的数字型 Code 128', () => {
  for (const id of [
    '00000000-0000-0000-0000-000000000000',
    '00000001-0000-4000-8000-000000000001',
    'f5929e28-4132-45b5-be87-0d45a9d9f19e',
    'ffffffff-ffff-ffff-ffff-ffffffffffff'
  ]) {
    const value = encodeDeviceLabel(id);
    assert.match(value, /^98\d{40}$/);
    assert.equal(unitCode(value), id);
    assert.equal(deviceBarcode({ unitId: id, qrcodeText: id }).modules, 266);
  }
});

test('收银兼容旧二维码、IMEI、序列号，且不会重写超出 UUID 范围的数字串', () => {
  const id = 'f5929e28-4132-45b5-be87-0d45a9d9f19e';
  const overflow = '98' + '9'.repeat(40);
  const serial = '98' + '0'.repeat(38);
  assert.equal(unitCode(id), id);
  assert.equal(unitCode('IMEI 865000000000001'), '865000000000001');
  assert.equal(unitCode('SN-AX122399'), 'SN-AX122399');
  assert.equal(unitCode(serial), serial);
  assert.equal(unitCode(overflow), overflow);
  assert.throws(() => deviceBarcode({ unitId: id, qrcodeText: 'different-id' }), /扫码编号/);
});

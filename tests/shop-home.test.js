const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let role = 'customer';
global.wx = { getStorageSync: () => role };
const mock = require('../miniprogram/mock');
const { SHOP_BRANDS } = require('../miniprogram/constants/shop-brands');
const { EMPTY_FILTERS, brandTiles, toQuery, priceError, filterCount } = require('../miniprogram/utils/shop-filter');
const units = async (query) => (await mock.handle({ url: '/shop/units', method: 'GET', data: { pageSize: 100, ...query }, header: {} }));

test('品牌入口：每个品牌都有图片位，品牌值跟随接口，兼容中文品牌值', () => {
  SHOP_BRANDS.forEach((b) => assert.ok(fs.existsSync(path.join(__dirname, '../miniprogram/assets/brands', b.key + '.png')), b.key));
  const tiles = brandTiles([{ value: 'all', label: '全部' }, { value: '苹果', label: '苹果' }, { value: 'xiaomi', label: '小米' }]);
  assert.equal(tiles.length, 8);
  assert.equal(tiles[0].value, '苹果');
  assert.equal(tiles.find((t) => t.key === 'xiaomi').value, 'xiaomi');
  assert.equal(tiles.find((t) => t.key === 'vivo').value, 'vivo');
});

test('筛选条件：空值和显示用字段不进查询，价格校验，抽屉角标计数', () => {
  assert.deepEqual(toQuery({ ...EMPTY_FILTERS, grade: '99新', modelId: 'm1', modelName: 'iPhone', sort: 'price_asc' }), { modelId: 'm1', grade: '99新', sort: 'price_asc' });
  assert.equal(priceError('', ''), '');
  assert.equal(priceError('abc', ''), '价格须为非负金额，最多两位小数');
  assert.equal(priceError('6000', '5000'), '最低价不能高于最高价');
  assert.equal(filterCount({ ...EMPTY_FILTERS, grade: '99新', priceMax: '5000', sort: 'price_asc' }), 2);
});

test('价格排序按当前渠道价，非法排序被拒绝', async () => {
  const asc = (await units({ sort: 'price_asc' })).data.list.map((u) => u.price);
  assert.ok(asc.length > 1);
  assert.deepEqual(asc, asc.slice().sort((a, b) => a - b));
  const desc = (await units({ sort: 'price_desc' })).data.list.map((u) => u.price);
  assert.deepEqual(desc, asc.slice().reverse());
  assert.equal((await units({ sort: 'cheap' })).code, 400);
});

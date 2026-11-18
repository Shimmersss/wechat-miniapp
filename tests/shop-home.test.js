const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let role = 'customer';
global.wx = { getStorageSync: () => role };
const mock = require('../miniprogram/mock');
const { SHOP_BRANDS, expandBrandKey, knownBrandNames, brandRank } = require('../miniprogram/constants/shop-brands');
const { EMPTY_FILTERS, brandTiles, applyBrandTile, scopeCategory, showBattery, toQuery, priceError, filterCount } = require('../miniprogram/utils/shop-filter');
const units = async (query) => (await mock.handle({ url: '/shop/units', method: 'GET', data: { pageSize: 100, ...query }, header: {} }));

test('首页入口：16 个入口分两页，每个都有图片，体积在上限内', () => {
  assert.equal(SHOP_BRANDS.length, 16);
  assert.equal(new Set(SHOP_BRANDS.map((b) => b.key)).size, 16);
  SHOP_BRANDS.forEach((b) => {
    const file = path.join(__dirname, '../design-demos/brand-icons/images', b.key + '.png');
    assert.ok(fs.existsSync(file), b.key);
    assert.ok(fs.statSync(file).size <= 30 * 1024, b.key + ' 超过 30KB');
  });
  const pages = brandTiles();
  assert.deepEqual(pages.map((p) => p.tiles.length), [8, 8]);
  assert.deepEqual(pages[0].tiles.map((t) => t.key), ['apple', 'huawei', 'xiaomi', 'honor', 'oppo', 'vivo', 'samsung', 'oneplus']);
  assert.deepEqual(pages[1].tiles.map((t) => t.label), ['红米手机', 'iQOO手机', 'realme手机', '其他手机', '平板', '配件', '耳机耳麦', '其他设备']);
});

test('首页入口展开：红米、iQOO 独立，其他手机排除全部已列品牌，分类入口按分类', () => {
  assert.deepEqual(expandBrandKey('xiaomi'), { category: 'phone', brandNames: ['xiaomi', '小米'] });
  assert.ok(!expandBrandKey('xiaomi').brandNames.includes('redmi'));
  assert.ok(!expandBrandKey('vivo').brandNames.includes('iqoo'));
  assert.deepEqual(expandBrandKey('redmi').brandNames, ['redmi', '红米']);
  const other = expandBrandKey('other-phone');
  assert.equal(other.category, 'phone');
  assert.deepEqual(other.excludeBrandNames, knownBrandNames());
  ['redmi', 'iqoo', 'realme', '苹果'].forEach((name) => assert.ok(other.excludeBrandNames.includes(name), name));
  assert.deepEqual(expandBrandKey('other-device'), { category: 'other' });
  assert.equal(expandBrandKey('nope'), null);
  assert.ok(brandRank('苹果', '苹果') < brandRank('redmi', '红米'));
  assert.equal(brandRank('meizu', '魅族'), SHOP_BRANDS.length);
});

test('点首页入口：再点取消，与品牌、分类、型号互斥，非手机分类清掉电池条件', () => {
  const start = { ...EMPTY_FILTERS, brand: 'apple', modelId: 'm1', modelName: 'X', batteryMin: '90' };
  const picked = applyBrandTile(start, 'redmi');
  assert.equal(picked.brandKey, 'redmi');
  assert.equal(picked.brand, '');
  assert.equal(picked.modelId, '');
  assert.equal(picked.batteryMin, '90');
  assert.equal(scopeCategory(picked), 'phone');
  assert.equal(applyBrandTile(picked, 'redmi').brandKey, '');
  const audio = applyBrandTile(picked, 'audio');
  assert.equal(scopeCategory(audio), 'audio');
  assert.equal(showBattery(audio), false);
  assert.equal(audio.batteryMin, '');
  assert.deepEqual(toQuery(audio), { brandKey: 'audio' });
  assert.equal(filterCount(audio), 0);
});

test('mock 列表：品牌入口按服务端展开，非法入口被拒绝', async () => {
  assert.equal((await units({ brandKey: 'apple' })).data.total, 3);
  assert.equal((await units({ brandKey: 'redmi' })).data.total, 0);
  assert.equal((await units({ brandKey: 'other-phone' })).data.total, 0);
  assert.equal((await units({ brandKey: 'hacker' })).code, 400);
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

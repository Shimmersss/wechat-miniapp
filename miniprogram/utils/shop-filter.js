/** 首页筛选的纯逻辑：品牌入口匹配、筛选条件转查询参数。价格和结果都以服务端为准。 */
const { SHOP_BRANDS, PAGE_SIZE, PHONE_CATEGORY, findBrandEntry } = require('../constants/shop-brands');

// brandKey 是首页入口（见 constants/shop-brands.js），category 为分类入口或筛选抽屉选的分类
const EMPTY_FILTERS = { brand: '', brandKey: '', category: '', modelId: '', modelName: '', condition: '', grade: '', batteryMin: '', priceMin: '', priceMax: '', sort: '' };

const PRICE_RANGES = [
  { label: '不限价格', min: '', max: '' },
  { label: '2000以下', min: '', max: '1999' },
  { label: '2000-3999', min: '2000', max: '3999' },
  { label: '4000-5999', min: '4000', max: '5999' },
  { label: '6000-7999', min: '6000', max: '7999' },
  { label: '8000以上', min: '8000', max: '' }
];

const BATTERY_OPTIONS = [
  { value: '', label: '不限' },
  { value: '90', label: '90%以上' },
  { value: '85', label: '85%以上' },
  { value: '80', label: '80%以上' }
];

/** 首页入口固定展示，按 8 个一页分组；品牌展开由服务端完成，前端只传入口 key */
function brandTiles() {
  const tiles = SHOP_BRANDS.map((tile) => ({ key: tile.key, label: tile.label, type: tile.type, image: `/assets/brands/${tile.key}.png` }));
  const pages = [];
  for (let i = 0; i < tiles.length; i += PAGE_SIZE) pages.push({ index: pages.length, tiles: tiles.slice(i, i + PAGE_SIZE) });
  return pages;
}

/** 点首页入口后的筛选条件：再点一次取消；入口、品牌、分类、型号互斥 */
function applyBrandTile(filters, key) {
  const next = { ...filters, brand: '', brandKey: '', category: '', modelId: '', modelName: '' };
  if (filters.brandKey === key || !findBrandEntry(key)) return withoutPhoneOnly(next);
  return withoutPhoneOnly({ ...next, brandKey: key });
}

/** 当前条件限定的分类：入口优先，其次是筛选抽屉选的分类；空串表示不限 */
function scopeCategory(filters) {
  const entry = filters.brandKey ? findBrandEntry(filters.brandKey) : null;
  if (entry) return entry.type === 'category' ? entry.category : PHONE_CATEGORY;
  return filters.category || '';
}

/** 电池健康只对手机有意义；范围不含手机时隐藏并清掉电池条件 */
function showBattery(filters) {
  const category = scopeCategory(filters);
  return !category || category === PHONE_CATEGORY;
}

function withoutPhoneOnly(filters) {
  return showBattery(filters) ? filters : { ...filters, batteryMin: '' };
}

/** 去掉空值后作为 /shop/units 的查询参数；modelName 只用于显示 */
function toQuery(filters) {
  const query = {};
  Object.keys(EMPTY_FILTERS).forEach((k) => {
    if (k !== 'modelName' && filters[k] !== '' && filters[k] !== undefined) query[k] = filters[k];
  });
  return query;
}

function priceError(min, max) {
  const valid = (v) => v === '' || /^\d{1,9}(\.\d{1,2})?$/.test(String(v));
  if (!valid(min) || !valid(max)) return '价格须为非负金额，最多两位小数';
  if (min !== '' && max !== '' && Number(min) > Number(max)) return '最低价不能高于最高价';
  return '';
}

/** 筛选抽屉角标：抽屉里能改的条件数量 */
function filterCount(f) {
  return ['modelId', 'condition', 'grade', 'batteryMin'].filter((k) => f[k]).length + (f.priceMin !== '' || f.priceMax !== '' ? 1 : 0);
}

module.exports = { EMPTY_FILTERS, PRICE_RANGES, BATTERY_OPTIONS, brandTiles, applyBrandTile, scopeCategory, showBattery, toQuery, priceError, filterCount };

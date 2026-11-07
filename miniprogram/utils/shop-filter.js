/** 首页筛选的纯逻辑：品牌入口匹配、筛选条件转查询参数。价格和结果都以服务端为准。 */
const { SHOP_BRANDS } = require('../constants/shop-brands');

const EMPTY_FILTERS = { brand: '', modelId: '', modelName: '', condition: '', grade: '', batteryMin: '', priceMin: '', priceMax: '', sort: '' };

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

/** 品牌入口固定展示，有现货的品牌带上接口真实的品牌值；没现货的点进去显示空结果 */
function brandTiles(homeBrands) {
  const brands = (homeBrands || []).filter((b) => b.value !== 'all');
  return SHOP_BRANDS.map((tile) => {
    const hit = brands.find((b) => [b.value, b.label].some((v) => tile.names.includes(String(v).toLowerCase())));
    return { key: tile.key, label: tile.label, value: hit ? hit.value : tile.key, image: `/assets/brands/${tile.key}.png` };
  });
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

module.exports = { EMPTY_FILTERS, PRICE_RANGES, BATTERY_OPTIONS, brandTiles, toQuery, priceError, filterCount };

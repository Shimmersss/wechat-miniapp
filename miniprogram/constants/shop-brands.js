/**
 * 首页入口（左右滑动，每页 8 个）。配图放在 assets/brands/<key>.png，直接替换同名文件即可，页面不用改：
 * 建议 240×240 透明底 PNG，主体居中，单张不超过 30KB（主包上限 2MB）。
 * 现有配图是原创插画（不含品牌商标）：手机为各品牌 2026 年秋季旗舰背面，其余为品类示意，
 * 由 design-demos/brand-icons/build.py 生成；新机发布或新增入口时改那里再运行。
 *
 * type：
 * - brand       品牌入口，限定在手机分类，按 names 匹配型号的品牌值或品牌名（不区分大小写）
 * - otherBrand  手机分类里不属于任何品牌入口的设备
 * - category    分类入口，按分类 ID 筛选
 * 本文件同时被云函数 shop 读取（scripts/sync-cloudfunctions.js 复制到 shared/），品牌展开以服务端为准。
 */
const PHONE_CATEGORY = 'phone';

const SHOP_BRANDS = [
  { key: 'apple', label: '苹果手机', type: 'brand', names: ['apple', '苹果', 'iphone'] },
  { key: 'huawei', label: '华为手机', type: 'brand', names: ['huawei', '华为'] },
  { key: 'xiaomi', label: '小米手机', type: 'brand', names: ['xiaomi', '小米'] },
  { key: 'honor', label: '荣耀手机', type: 'brand', names: ['honor', '荣耀'] },
  { key: 'oppo', label: 'OPPO手机', type: 'brand', names: ['oppo'] },
  { key: 'vivo', label: 'vivo手机', type: 'brand', names: ['vivo'] },
  { key: 'samsung', label: '三星手机', type: 'brand', names: ['samsung', '三星'] },
  { key: 'oneplus', label: '一加手机', type: 'brand', names: ['oneplus', '一加'] },
  { key: 'redmi', label: '红米手机', type: 'brand', names: ['redmi', '红米'] },
  { key: 'iqoo', label: 'iQOO手机', type: 'brand', names: ['iqoo'] },
  { key: 'realme', label: 'realme手机', type: 'brand', names: ['realme', '真我'] },
  { key: 'other-phone', label: '其他手机', type: 'otherBrand' },
  { key: 'tablet', label: '平板', type: 'category', category: 'tablet' },
  { key: 'accessory', label: '配件', type: 'category', category: 'accessory' },
  { key: 'audio', label: '耳机耳麦', type: 'category', category: 'audio' },
  { key: 'other-device', label: '其他设备', type: 'category', category: 'other' }
];

const PAGE_SIZE = 8;

function findBrandEntry(key) {
  return SHOP_BRANDS.find((b) => b.key === key);
}

/** 所有品牌入口的匹配名（小写），用于“其他手机”排除 */
function knownBrandNames() {
  return SHOP_BRANDS.filter((b) => b.type === 'brand').reduce((all, b) => all.concat(b.names), []);
}

/**
 * 把首页入口 key 展开成查询条件。返回 null 表示 key 无效。
 * { category, brandNames?, excludeBrandNames? }
 */
function expandBrandKey(key) {
  const entry = findBrandEntry(key);
  if (!entry) return null;
  if (entry.type === 'brand') return { category: PHONE_CATEGORY, brandNames: entry.names.slice() };
  if (entry.type === 'otherBrand') return { category: PHONE_CATEGORY, excludeBrandNames: knownBrandNames() };
  return { category: entry.category };
}

/** 品牌在手机分类里的展示顺序：按入口顺序，未列入的排最后 */
function brandRank(value, label) {
  const names = [value, label].map((v) => String(v || '').toLowerCase());
  const index = SHOP_BRANDS.findIndex((b) => b.type === 'brand' && b.names.some((n) => names.includes(n)));
  return index === -1 ? SHOP_BRANDS.length : index;
}

module.exports = { SHOP_BRANDS, PHONE_CATEGORY, PAGE_SIZE, findBrandEntry, knownBrandNames, expandBrandKey, brandRank };

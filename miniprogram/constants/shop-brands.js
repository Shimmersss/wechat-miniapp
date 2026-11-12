/**
 * 首页品牌入口。配图放在 assets/brands/<key>.png，直接替换同名文件即可，页面不用改：
 * 建议 240×240 透明底 PNG，手机居中，单张不超过 30KB（主包上限 2MB）。
 * 现有配图是各品牌 2026 年秋季旗舰背面的原创插画（不含品牌商标），由 design-demos/brand-icons/build.py 生成；
 * 新机发布或新增品牌时改那里再运行。
 * names 用来匹配接口返回的品牌：mock 的品牌值是 apple，真实后端的品牌值可能是“苹果”。
 */
const SHOP_BRANDS = [
  { key: 'apple', label: '苹果手机', names: ['apple', '苹果', 'iphone'] },
  { key: 'huawei', label: '华为手机', names: ['huawei', '华为'] },
  { key: 'xiaomi', label: '小米手机', names: ['xiaomi', '小米', 'redmi', '红米'] },
  { key: 'honor', label: '荣耀手机', names: ['honor', '荣耀'] },
  { key: 'oppo', label: 'OPPO手机', names: ['oppo'] },
  { key: 'vivo', label: 'vivo手机', names: ['vivo', 'iqoo'] },
  { key: 'samsung', label: '三星手机', names: ['samsung', '三星'] },
  { key: 'oneplus', label: '一加手机', names: ['oneplus', '一加'] }
];

module.exports = { SHOP_BRANDS };

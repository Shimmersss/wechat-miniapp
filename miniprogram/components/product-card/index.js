/** 商品卡片（顾客端双列）。unit 为 /shop/units 返回的公开视图 */
const { SHOP_BRANDS, PHONE_CATEGORY } = require('../../constants/shop-brands');

/** 没有实拍图时用首页入口配图占位：手机按品牌，其他按分类；匹配不到用“其他手机/其他设备” */
function placeholderOf(unit) {
  const category = unit.category || PHONE_CATEGORY;
  if (category === PHONE_CATEGORY) {
    const brand = String(unit.brand || '').toLowerCase();
    const entry = SHOP_BRANDS.find(b => b.type === 'brand' && b.names.includes(brand));
    return `/assets/brands/${entry ? entry.key : 'other-phone'}.png`;
  }
  const entry = SHOP_BRANDS.find(b => b.type === 'category' && b.category === category);
  return `/assets/brands/${entry ? entry.key : 'other-device'}.png`;
}

Component({
  properties: {
    unit: { type: Object, value: {} }
  },
  data: { placeholder: '' },
  observers: {
    unit(unit) { this.setData({ placeholder: unit && !unit.cover ? placeholderOf(unit) : '' }); }
  },
  methods: {
    onTap() {
      this.triggerEvent('select', { id: this.data.unit.id });
    }
  }
});

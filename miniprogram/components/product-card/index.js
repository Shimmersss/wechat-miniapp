/** 商品卡片（顾客端双列）。unit 为 /shop/units 返回的公开视图 */
Component({
  properties: {
    unit: { type: Object, value: {} }
  },
  methods: {
    onTap() {
      this.triggerEvent('select', { id: this.data.unit.id });
    }
  }
});

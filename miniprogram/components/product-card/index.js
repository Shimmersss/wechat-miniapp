/** 商品卡片（顾客端双列）。unit 为 /shop/units 返回的公开视图 */
const PLACEHOLDER = '/assets/images/device-placeholder.png';

Component({
  properties: {
    unit: { type: Object, value: {} }
  },
  data: { placeholder: PLACEHOLDER, imageFailed: false, batteryLabel: '' },
  observers: {
    unit(unit) { this.setData({ placeholder: PLACEHOLDER, imageFailed: false, batteryLabel: unit?.battery !== undefined && unit?.battery !== null && unit?.battery !== '' ? String(unit.battery).replace(/%$/, '') + '%' : '' }); }
  },
  methods: {
    onImageError() { this.setData({ imageFailed: true }); },
    onTap() {
      this.triggerEvent('select', { id: this.data.unit.id });
    }
  }
});

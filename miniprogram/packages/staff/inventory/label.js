const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { deviceQr, writeLabelPdf } = require('./label-pdf');

/** 标签只编码内部设备 ID，供库存盘点和收银扫码使用。 */
createPage({
  requireStaff: true,
  permission: PERM.LABEL_PRINT,
  data: { label: null, loading: false, exporting: false, qrSrc: '', error: '' },

  onLoad(query) {
    this.unitId = query.id;
    return this.loadLabel();
  },

  async loadLabel() {
    if (this.data.loading) return;
    if (!this.unitId) return this.setData({ error: '缺少设备编号' });
    this.setData({ loading: true, error: '' });
    try {
      const label = await api.inventory.label(this.unitId);
      this.setData({ label, qrSrc: deviceQr(label).createDataURL(6, 24) });
    } catch (error) {
      this.setData({ error: error.message || '设备标签加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onPrint() {
    if (!this.data.label || this.data.exporting) return;
    wx.showActionSheet({
      itemList: ['60 × 40 毫米标签纸', 'A4 纸（标签保持原尺寸）'],
      success: ({ tapIndex }) => this.exportPdf(tapIndex === 1)
    });
  },

  async exportPdf(a4) {
    if (!this.data.label || this.data.exporting) return;
    this.setData({ exporting: true });
    try {
      const filePath = await writeLabelPdf(this.data.label, this.data.brand.name, a4);
      await new Promise((resolve, reject) => wx.openDocument({
        filePath, fileType: 'pdf', showMenu: true, success: resolve, fail: reject
      }));
    } catch (error) {
      this.$toast(error.message || 'PDF 打开失败，请重试');
    } finally {
      this.setData({ exporting: false });
    }
  }
});

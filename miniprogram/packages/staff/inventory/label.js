const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { barcodePreview, writeLabelPdf } = require('./label-pdf');
const papers = [
  { title: '60 × 40 毫米（建议 300 DPI）', key: '60x40' },
  { title: '80 × 40 毫米（适合 203 DPI）', key: '80x40' },
  { title: 'A4 纸（标签保持原尺寸）', key: 'A4' }
];

/** 标签只编码内部设备 ID，供库存盘点和收银扫码使用。 */
createPage({
  requireStaff: true,
  permission: PERM.LABEL_PRINT,
  data: { label: null, loading: false, exporting: false, barcodeSrc: '', error: '' },

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
      this.setData({ label, barcodeSrc: barcodePreview(label) });
    } catch (error) {
      this.setData({ error: error.message || '设备标签加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onPrint() {
    if (!this.data.label || this.data.exporting) return;
    wx.showActionSheet({
      itemList: papers.map(paper => paper.title),
      success: ({ tapIndex }) => this.exportPdf(papers[tapIndex].key)
    });
  },

  async exportPdf(paper) {
    if (!this.data.label || this.data.exporting) return;
    this.setData({ exporting: true });
    try {
      const filePath = await writeLabelPdf(this.data.label, this.data.brand.name, paper);
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

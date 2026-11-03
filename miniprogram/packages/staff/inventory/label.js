const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');

/** 标签打印：标签二维码只编码内部设备 ID，扫码收银/盘点时用 api.sales.lookup 解析 */
createPage({
  requireStaff: true,
  permission: PERM.LABEL_PRINT,
  data: {
    label: null
  },

  onLoad(query) {
    api.inventory.label(query.id).then((label) => this.setData({ label }));
  },

  /** TODO(codex): 对接蓝牙标签打印机（wx.openBluetoothAdapter → 写入 ESC/TSPL 指令） */
  onPrint() {
    this.$toast('打印机对接待实现');
  }
});

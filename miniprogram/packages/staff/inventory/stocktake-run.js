const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { ROUTES } = require('../../../utils/router');
const { UNIT_STATUS } = require('../../../constants/status');
const { scan, unitCode } = require('../../../utils/scan');
const { confirmSensitive } = require('../../../utils/confirm');
const { date } = require('../../../utils/format');
const TONE = { matched: 'green', duplicate: 'gray', out_of_scope: 'red', unknown: 'red', error: 'red' };
/** 扫码盘点：每扫一台立即比对应盘清单并保存，显示进度；待盘/已盘/异常三张清单 */
createPage({
  requireStaff: true, permission: PERM.STOCKTAKE,
  data: {
    id: '', session: null, input: '', last: null, scanning: false, busy: false, error: '', statusMap: UNIT_STATUS,
    tab: 'pending', tabs: [{ value: 'pending', label: '待盘' }, { value: 'scanned', label: '已盘' }, { value: 'extra', label: '异常' }],
    list: [], page: 0, more: true, listLoading: false
  },
  onLoad(query) { this.setData({ id: query.id }); return this.refresh(); },
  onShow() { if (this.loaded && !this.data.scanning) return this.refresh(); },
  onPullDownRefresh() { return this.refresh().finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.more && !this.data.listLoading) return this.loadList(false); },
  async refresh() {
    try { this.setData({ session: await api.inventory.stocktakeSession(this.data.id), error: '' }); } catch (e) { return this.setData({ error: e.message }); }
    this.loaded = true;
    return this.loadList(true);
  },
  async loadList(reset) {
    const revision = this.listRevision = (this.listRevision || 0) + 1, page = reset ? 1 : this.data.page + 1;
    this.setData({ listLoading: true, ...(reset ? { list: [], more: true } : {}) });
    try {
      const res = await api.inventory.stocktakeUnits(this.data.id, { state: this.data.tab, page, pageSize: 20 });
      if (revision !== this.listRevision) return;
      const rows = res.list.map(r => ({ ...r, timeText: date(r.scannedAt, 'MM-DD HH:mm') })), list = reset ? rows : this.data.list.concat(rows);
      this.setData({ list, page, more: list.length < res.total });
    } catch (e) { if (revision === this.listRevision) this.setData({ error: e.message }); }
    finally { if (revision === this.listRevision) this.setData({ listLoading: false }); }
  },
  onTab(e) { if (e.currentTarget.dataset.value !== this.data.tab) { this.setData({ tab: e.currentTarget.dataset.value }); return this.loadList(true); } },
  onInput(e) { this.setData({ input: e.detail.value }); },
  open() { return this.data.session && this.data.session.status === 'open'; },
  onAdd() {
    const code = unitCode(this.data.input);
    if (!code || code.length > 80) return this.$toast('请输入有效设备编号或串码');
    return this.submit(code, true);
  },
  /** 提交一个编号；返回服务端比对结果，失败返回 null */
  async submit(code, reload) {
    if (this.data.busy || !this.open()) return null;
    this.setData({ busy: true, error: '' });
    try {
      const r = await api.inventory.scanStocktake(this.data.id, { code });
      const { result, message, unit, expectedCount, scannedCount, extraCount } = r;
      this.setData({ input: '', last: { result, message, code: r.code, name: unit ? unit.name : '', imeiMasked: unit ? unit.imeiMasked : '', tone: TONE[result] }, session: { ...this.data.session, expectedCount, scannedCount, extraCount } });
      try { if (result === 'matched') wx.vibrateShort({ type: 'light' }); else if (result !== 'duplicate') wx.vibrateLong(); } catch (_) { /* 无震动能力时忽略 */ }
      if (reload) this.loadList(true);
      return r;
    } catch (e) {
      this.setData({ last: { result: 'error', message: e.message, code, tone: 'red' } });
      return null;
    } finally { this.setData({ busy: false }); }
  },
  async onScan() {
    if (!this.open()) return;
    let raw;
    try { raw = await scan(); } catch (_) { return; }
    return this.submit(unitCode(raw), true);
  },
  /** 连续扫码：每扫一台自动保存并再次打开扫码框，取消扫码即停止 */
  async onScanLoop() {
    if (!this.open() || this.data.scanning) return;
    this.setData({ scanning: true });
    try {
      for (;;) {
        let raw;
        try { raw = await scan(); } catch (_) { break; }
        if (!(await this.submit(unitCode(raw), false))) break;
      }
    } finally {
      this.setData({ scanning: false });
      this.loadList(true);
    }
  },
  onUnit(e) { if (e.currentTarget.dataset.id) this.$go(ROUTES.INVENTORY_DETAIL, { id: e.currentTarget.dataset.id }); },
  onClose() {
    const s = this.data.session;
    if (!this.open() || this.data.busy) return;
    const rest = s.expectedCount - s.scannedCount;
    wx.showModal({
      title: '结束盘点',
      content: `应盘 ${s.expectedCount} 台，已盘 ${s.scannedCount} 台。` + (rest ? `未盘的 ${rest} 台将记为缺失（盘点期间已售出、出借的单独列出）。` : '') + '结束后不能继续扫码。',
      confirmText: '结束盘点',
      success: r => { if (r.confirm) this.close(); }
    });
  },
  /** 结束接口可重复调用：已结束的单返回同一结果 */
  async close() {
    this.setData({ busy: true, error: '' });
    try {
      const result = await api.inventory.closeStocktake(this.data.id);
      this.setData({ session: { ...this.data.session, status: 'closed', stocktakeId: result.id } });
      this.$go(ROUTES.STOCKTAKE_RESULT, { id: result.id });
    } catch (e) { this.setData({ error: e.message }); } finally { this.setData({ busy: false }); }
  },
  onResult() { if (this.data.session && this.data.session.stocktakeId) this.$go(ROUTES.STOCKTAKE_RESULT, { id: this.data.session.stocktakeId }); },
  async onCancel() {
    if (!this.open() || this.data.busy) return;
    const confirmation = await confirmSensitive({ title: '作废盘点单', content: '请填写作废原因，扫码记录不会生成盘点结果', needReason: true, confirmText: '作废' });
    if (!confirmation.confirmed) return;
    this.setData({ busy: true, error: '' });
    try {
      this.setData({ session: await api.inventory.cancelStocktake(this.data.id, { reason: confirmation.reason }) });
      this.$toast('已作废');
    } catch (e) { this.setData({ error: e.message }); } finally { this.setData({ busy: false }); }
  }
});

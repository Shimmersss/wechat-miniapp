const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { ROUTES } = require('../../../utils/router');
const { UNIT_STATUS, STOCKTAKE_RESOLUTION } = require('../../../constants/status');
const { confirmSensitive } = require('../../../utils/confirm');
const { date } = require('../../../utils/format');
const CHOICES = {
  unit: [{ value: 'found', label: '已找到' }, { value: 'pending', label: '待查' }, { value: 'lost', label: '确认丢失' }],
  extra: [{ value: 'handled', label: '已处理' }, { value: 'pending', label: '待查' }]
};
/** 盘点结果：缺失、盘点期间离店、异常编号；差异逐项记录处理结论（只追加记录，不改库存） */
createPage({
  requireStaff: true, permission: PERM.STOCKTAKE,
  data: { id: '', result: null, error: '', busy: false, statusMap: UNIT_STATUS, resolutionMap: STOCKTAKE_RESOLUTION },
  onLoad(query) { this.setData({ id: query.id }); return this.load(); },
  onPullDownRefresh() { return this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    try { this.show(await api.inventory.stocktakeDetail(this.data.id)); } catch (e) { this.setData({ error: e.message }); }
  },
  show(result) {
    const stamp = r => r ? { ...r, timeText: date(r.time) } : null;
    this.setData({
      error: '',
      result: { ...result, timeText: date(result.time), startedText: date(result.scope && result.scope.startedAt), missing: result.missing.map(u => ({ ...u, resolution: stamp(u.resolution) })), extra: result.extra.map(e => ({ ...e, resolution: stamp(e.resolution) })) }
    });
  },
  onUnit(e) { if (e.currentTarget.dataset.id) this.$go(ROUTES.INVENTORY_DETAIL, { id: e.currentTarget.dataset.id }); },
  /** 选择处理结论并填写说明；同一项可多次处理，以最后一次为准 */
  onResolve(e) {
    if (this.data.busy) return;
    const { type, target } = e.currentTarget.dataset, choices = CHOICES[type];
    wx.showActionSheet({ itemList: choices.map(c => c.label), success: r => this.resolve(type, target, choices[r.tapIndex]) });
  },
  async resolve(type, target, choice) {
    if (!choice) return;
    const confirmation = await confirmSensitive({ title: choice.label, content: '请填写处理说明，如：在维修柜找到、已报警', needReason: true });
    if (!confirmation.confirmed) return;
    this.setData({ busy: true, error: '' });
    try { this.show(await api.inventory.resolveStocktake(this.data.id, { type, target, resolution: choice.value, note: confirmation.reason })); }
    catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ busy: false }); }
  }
});

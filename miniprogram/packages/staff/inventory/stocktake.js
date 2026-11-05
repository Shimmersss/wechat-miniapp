const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { ROUTES } = require('../../../utils/router');
const { UNIT_STATUS, STOCKTAKE_SCOPE, STOCKTAKE_DEFAULT_SCOPE } = require('../../../constants/status');
const events = require('../../../utils/events');
const { date } = require('../../../utils/format');
let sequence = 0;
/**
 * 库存盘点入口：进行中的盘点单、新建盘点单（范围快照应盘清单）、已结束的盘点历史。
 * 扫码在 stocktake-run 页，结果与差异处理在 stocktake-result 页。
 */
createPage({
  requireStaff: true, permission: PERM.STOCKTAKE,
  data: {
    sessions: [], categories: [], category: '', model: null, note: '',
    statuses: STOCKTAKE_DEFAULT_SCOPE.slice(),
    choices: STOCKTAKE_SCOPE.map(value => ({ value, label: UNIT_STATUS[value].label, checked: STOCKTAKE_DEFAULT_SCOPE.includes(value) })),
    pending: null, saving: false, error: '',
    history: [], historyPage: 0, historyMore: true, historyLoading: false
  },
  onLoad(query) {
    if (query.modelId) this.setData({ model: { id: query.modelId, name: decodeURIComponent(query.modelName || '所选型号') } });
    this.offModel = events.on('stocktake:model-selected', m => { const p = getCurrentPages(); if (p[p.length - 2] === this && !this.locked()) this.setData({ model: { id: m.id, name: m.name }, category: '' }); });
    return this.load();
  },
  onShow() { if (this.loaded) return this.refresh(); },
  onUnload() { if (this.offModel) this.offModel(); },
  onPullDownRefresh() { return this.refresh().finally(() => wx.stopPullDownRefresh()); },
  locked() { return this.data.saving || !!this.data.pending; },
  async load() {
    try { const res = await api.template.categories(); this.setData({ categories: res.list }); } catch (e) { this.setData({ error: e.message }); }
    await this.refresh();
    this.loaded = true;
  },
  async refresh() {
    try { const res = await api.inventory.stocktakeSessions({ status: 'open', page: 1, pageSize: 50 }); this.setData({ sessions: res.list.map(s => ({ ...s, timeText: date(s.createdAt) })) }); } catch (e) { this.setData({ error: e.message }); }
    return this.loadHistory(true);
  },
  onCategory(e) { if (!this.locked()) this.setData({ category: e.currentTarget.dataset.value, model: null }); },
  onChooseModel() { if (!this.locked()) this.$go(ROUTES.TEMPLATES, { select: '1', from: 'stocktake' }); },
  onClearModel() { if (!this.locked()) this.setData({ model: null }); },
  onStatuses(e) { if (!this.locked()) this.setData({ statuses: e.detail.value, choices: this.data.choices.map(c => ({ ...c, checked: e.detail.value.includes(c.value) })) }); },
  onNote(e) { if (!this.locked()) this.setData({ note: e.detail.value }); },
  onStart() {
    if (this.locked()) return;
    if (!this.data.statuses.length) return this.$toast('请至少选择一种库存状态');
    const pending = { requestKey: 'stocktake_' + Date.now() + '_' + ++sequence + '_' + Math.random().toString(36).slice(2), statuses: this.data.statuses.slice(), note: this.data.note.trim() };
    if (this.data.model) pending.modelId = this.data.model.id;
    else if (this.data.category) pending.category = this.data.category;
    this.setData({ pending });
    return this.send();
  },
  /** 开单结果未知时保留同一提交标识原样重试，避免重复开单 */
  async send() {
    if (this.data.saving || !this.data.pending) return;
    this.setData({ saving: true, error: '' });
    try {
      const session = await api.inventory.startStocktake(this.data.pending);
      this.setData({ pending: null, note: '' });
      this.$go(ROUTES.STOCKTAKE_RUN, { id: session.id });
    } catch (e) {
      this.setData({ error: e.message });
      if (Number(e.code) >= 400 && Number(e.code) < 500) this.setData({ pending: null });
    } finally { this.setData({ saving: false }); }
  },
  onSession(e) { this.$go(ROUTES.STOCKTAKE_RUN, { id: e.currentTarget.dataset.id }); },
  onRecord(e) { this.$go(ROUTES.STOCKTAKE_RESULT, { id: e.currentTarget.dataset.id }); },
  async loadHistory(reset) {
    if (this.data.historyLoading) return;
    this.setData({ historyLoading: true });
    const page = reset ? 1 : this.data.historyPage + 1;
    try {
      const res = await api.inventory.stocktakes({ page, pageSize: 20 });
      const rows = res.list.map(r => ({ ...r, timeText: date(r.time) })), history = reset ? rows : this.data.history.concat(rows);
      this.setData({ history, historyPage: page, historyMore: history.length < res.total });
    } catch (e) { this.setData({ error: e.message }); } finally { this.setData({ historyLoading: false }); }
  },
  onMore() { return this.loadHistory(false); }
});

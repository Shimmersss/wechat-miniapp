const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { SETTLEMENT_STATUS } = require('../../../constants/status');
const { can } = require('../../../utils/permission');
const { confirmSensitive } = require('../../../utils/confirm');
const { date } = require('../../../utils/format');

/**
 * 代理收益转账（框架文档 十三.1）：按单记账，公司线下转账后勾选记录标记“已转账”；
 * 冲回记录（负数）一并勾选即表示已在本次转账中抵扣。需二次确认并填写转账说明，逐条写审计。
 */
createPage({
  requireStaff: true,
  permission: [PERM.AGENT_SETTLE, PERM.AGENT_REVIEW],
  data: {
    list: [], summary: null, selected: {}, selectedCount: 0, selectedAmount: 0, page: 1, total: 0, hasMore: true,
    loading: false, saving: false, error: '', canSettle: false, status: 'pending',
    filters: [{ value: 'pending', label: '待转账' }, { value: 'settled', label: '已转账' }, { value: 'reversed', label: '已冲回' }, { value: '', label: '全部' }]
  },
  onLoad(query = {}) {
    this.setData({ statusMap: SETTLEMENT_STATUS, canSettle: can(this.data.user, PERM.AGENT_SETTLE), status: query.status !== undefined && (SETTLEMENT_STATUS[query.status] || query.status === '') ? query.status : 'pending' });
    return this.load(true);
  },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },
  async load(reset) {
    const revision = this.revision = (this.revision || 0) + 1, page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '', ...(reset ? { selected: {}, selectedCount: 0, selectedAmount: 0 } : {}) });
    try {
      const res = await api.adminAgent.settlements({ status: this.data.status || undefined, page, pageSize: 50 });
      if (revision !== this.revision) return;
      const rows = res.list.map((e) => ({ ...e, createdText: date(new Date(e.createdAt)), settledText: e.settledAt ? date(new Date(e.settledAt)) : '' }));
      const list = reset ? rows : this.data.list.concat(rows);
      this.setData({ list, summary: res.summary, page, total: res.total, hasMore: list.length < res.total });
    } catch (e) { if (revision === this.revision) this.setData({ error: e.message }); }
    finally { if (revision === this.revision) this.setData({ loading: false }); }
  },
  onFilter(e) { this.setData({ status: e.currentTarget.dataset.value }); return this.load(true); },
  pick(selected) {
    const rows = this.data.list.filter((e) => selected[e.id]);
    this.setData({ selected, selectedCount: rows.length, selectedAmount: Math.round(rows.reduce((n, e) => n + e.amount * 100, 0)) / 100 });
  },
  onToggle(e) {
    const item = this.data.list.find((x) => x.id === e.currentTarget.dataset.id);
    if (!this.data.canSettle || !item || item.status !== 'pending') return;
    const selected = { ...this.data.selected };
    if (selected[item.id]) delete selected[item.id]; else selected[item.id] = true;
    this.pick(selected);
  },
  onSelectAll() {
    const pending = this.data.list.filter((e) => e.status === 'pending').slice(0, 100);
    const all = pending.length && pending.every((e) => this.data.selected[e.id]);
    this.pick(all ? {} : Object.fromEntries(pending.map((e) => [e.id, true])));
  },
  async onSettle() {
    const ids = Object.keys(this.data.selected);
    if (!this.data.canSettle || this.data.saving || !ids.length) return;
    const c = await confirmSensitive({ title: `标记 ${ids.length} 笔已转账`, content: `合计 ¥${this.data.selectedAmount}，填写转账说明（如转账方式、流水号）`, needReason: true });
    if (!c.confirmed) return;
    this.setData({ saving: true, error: '' });
    try { const r = await api.adminAgent.settle({ ids, reason: c.reason }); this.$toast(`已标记 ${r.settled} 笔`); await this.load(true); }
    catch (e) { this.setData({ error: e.message }); if (Number(e.code) === 409) await this.load(true); }
    finally { this.setData({ saving: false }); }
  }
});

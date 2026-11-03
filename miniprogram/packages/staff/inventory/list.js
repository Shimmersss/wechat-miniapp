const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');
const { UNIT_STATUS } = require('../../../constants/status');
const { can } = require('../../../utils/permission');
const { scan, unitCode } = require('../../../utils/scan');
const events = require('../../../utils/events');
createPage({
  requireStaff: true, permission: PERM.INVENTORY_VIEW,
  data: { list: [], page: 1, hasMore: true, loading: false, error: '', keyword: '', counts: {}, total: 0,
    canInbound: false, canStocktake: false, canSell: false, canShare: false, summary: null, picking: false, pickMode: '', pickFor: '', saving: false, selected: {}, selectedCount: 0, filterOpen: false, model: null, ageingOver: '', minPrice: '', maxPrice: '',
    filters: [{ value: '', label: '全部' }, ...['in_stock','recheck','locked','repairing','loaned_out','borrowed_in','sold','returned'].map(value => ({ value, label: UNIT_STATUS[value].label }))], activeFilter: '' },
  onLoad(query) {
    const pickFor = (query.pick === 'pos' && can(this.data.user, PERM.SALES_CREATE)) || (query.pick === 'loan' && can(this.data.user, PERM.LOAN_MANAGE)) ? query.pick : '';
    this.setData({ statusMap: UNIT_STATUS, activeFilter: pickFor ? 'in_stock' : query.status || '', ageingOver: query.ageingOver || '', canInbound: can(this.data.user, PERM.INBOUND), canStocktake: can(this.data.user, PERM.STOCKTAKE), canSell: can(this.data.user, PERM.SALES_CREATE), canShare: can(this.data.user, PERM.SHARE), picking: !!pickFor, pickMode: pickFor ? 'sell' : '', pickFor });
    this.offModel = events.on('inventory:model-selected', model => {
      const pages = getCurrentPages(); if (pages[pages.length - 2] === this) { this.setData({ model }); this.load(true); }
    });
    return this.load(true);
  },
  onShow() { if (this.loaded) this.load(true); },
  onUnload() { this.destroyed = true; if (this.offModel) this.offModel(); },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },
  async load(reset) {
    const revision = this.revision = (this.revision || 0) + 1, page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.inventory.list({ keyword: this.data.keyword.trim(), modelId: this.data.model ? this.data.model.id : undefined, status: this.data.activeFilter || undefined,
        ageingOver: this.data.ageingOver === '' ? undefined : this.data.ageingOver, minPrice: this.data.minPrice === '' ? undefined : this.data.minPrice, maxPrice: this.data.maxPrice === '' ? undefined : this.data.maxPrice, page, pageSize: 20 });
      if (this.destroyed || revision !== this.revision) return;
      const list = reset ? res.list : this.data.list.concat(res.list);
      this.setData({ list, page, total: res.total, hasMore: list.length < res.total, counts: res.counts || {}, summary: res.summary || null }); this.loaded = true;
    } catch (e) { if (!this.destroyed && revision === this.revision) this.setData({ error: e.message }); }
    finally { if (!this.destroyed && revision === this.revision) this.setData({ loading: false }); }
  },
  onKeyword(e) { this.setData({ keyword: e.detail.value }); },
  onSearch() { return this.load(true); },
  async onScan() { try { const keyword = unitCode(await scan()); this.setData({ keyword }); return this.load(true); } catch (_) {} },
  onFilterTap(e) { this.setData({ activeFilter: e.currentTarget.dataset.value }); return this.load(true); },
  onToggleFilter() { this.setData({ filterOpen: !this.data.filterOpen }); },
  onChooseModel() { this.$go(ROUTES.TEMPLATES, { select: '1', from: 'inventory' }); },
  onFilterInput(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  onApplyFilter() {
    const { minPrice, maxPrice, ageingOver } = this.data;
    if (ageingOver !== '' && (!/^\d+$/.test(String(ageingOver)) || Number(ageingOver) > 36500)) return this.$toast('库龄须为 0～36500 天整数');
    if ([minPrice, maxPrice].some(v => v !== '' && !/^\d+(\.\d{1,2})?$/.test(String(v)))) return this.$toast('价格须为非负金额，最多两位小数');
    if (minPrice !== '' && maxPrice !== '' && Number(minPrice) > Number(maxPrice)) return this.$toast('最低价不能高于最高价');
    this.setData({ filterOpen: false }); return this.load(true);
  },
  onResetFilter() { this.setData({ model: null, ageingOver: '', minPrice: '', maxPrice: '', keyword: '', activeFilter: '' }); return this.load(true); },
  onItemTap(e) {
    const { id, status } = e.currentTarget.dataset;
    if (!this.data.picking) return this.$go(ROUTES.INVENTORY_DETAIL, { id });
    if (status !== 'in_stock') return this.$toast(this.data.pickMode === 'agent' ? '仅在库可售设备可调整代理转发' : '仅在库设备可出库');
    const selected = { ...this.data.selected };
    if (selected[id]) delete selected[id]; else selected[id] = true;
    this.setData({ selected, selectedCount: Object.keys(selected).length });
  },
  /** 手动出库：多选在库设备 → 收银开单（实际扣库在收银确认收款时由服务端事务完成） */
  onStartPick() { if (!this.data.canSell) return; this.setData({ picking: true, pickMode: 'sell', selected: {}, selectedCount: 0, activeFilter: 'in_stock' }); return this.load(true); },
  /** 批量代理转发（框架文档 十三.7）：多选在库可售设备后一键开启/关闭，服务端整批事务并逐台审计 */
  onStartAgent() { if (!this.data.canShare) return; this.setData({ picking: true, pickMode: 'agent', selected: {}, selectedCount: 0, activeFilter: 'in_stock' }); return this.load(true); },
  onCancelPick() { if (this.data.pickFor) return this.$back(); this.setData({ picking: false, pickMode: '', selected: {}, selectedCount: 0 }); },
  onSelectAll() {
    const ids = this.data.list.filter(u => u.status === 'in_stock').map(u => u.id);
    const all = ids.length && ids.every(id => this.data.selected[id]);
    const selected = all ? {} : Object.fromEntries(ids.slice(0, 100).map(id => [id, true]));
    this.setData({ selected, selectedCount: Object.keys(selected).length });
  },
  async onAgentShare(e) {
    const ids = Object.keys(this.data.selected), shareAgent = e.currentTarget.dataset.on === '1';
    if (!ids.length || this.data.saving) return ids.length ? undefined : this.$toast('请先选择设备');
    this.setData({ saving: true, error: '' });
    try {
      const r = await api.inventory.batchShareAgent({ unitIds: ids, shareAgent });
      this.setData({ picking: false, pickMode: '', selected: {}, selectedCount: 0 });
      this.$toast(`已${shareAgent ? '开启' : '关闭'} ${r.updated} 台代理转发`);
      await this.load(true);
    } catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ saving: false }); }
  },
  onConfirmPick() {
    const ids = Object.keys(this.data.selected);
    if (!ids.length) return this.$toast('请先选择设备');
    if (this.data.pickFor) { events.emit(this.data.pickFor + ':units-selected', ids); return this.$back(); }
    this.setData({ picking: false, pickMode: '', selected: {}, selectedCount: 0 });
    this.$go(ROUTES.POS, { unitIds: ids.join(',') });
  },
  onScanOut() { if (this.data.canSell) this.$go(ROUTES.POS, { scan: '1' }); },
  onStocktake() { if (this.data.canStocktake) this.$go(ROUTES.STOCKTAKE, this.data.model ? { modelId: this.data.model.id, modelName: this.data.model.name } : {}); }
});

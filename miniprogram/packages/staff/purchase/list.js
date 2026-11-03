const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');
const { PURCHASE_STATUS } = require('../../../constants/status');
const { can } = require('../../../utils/permission');
createPage({
  requireStaff: true, permission: [PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE],
  data: { list: [], page: 1, hasMore: true, loading: false, error: '', keyword: '', canManage: false, canViewSuppliers: false, summary: null,
    filters: [{ value: '', label: '全部' }, { value: 'pending_ship', label: '待发货' }, { value: 'in_transit', label: '在途' }, { value: 'arrived', label: '待验收' }, { value: 'accepting', label: '验收中' }, { value: 'completed', label: '验收完成' }, { value: 'exception', label: '异常' }],
    activeFilter: ''
  },
  onLoad(query) {
    this.query = query || {};
    this.setData({ statusMap: PURCHASE_STATUS, activeFilter: query.status || '', canManage: can(this.data.user, PERM.PURCHASE_MANAGE), canViewSuppliers: can(this.data.user, PERM.SUPPLIER_VIEW) });
    return this.load(true);
  },
  onShow() { if (this.loaded) this.load(true); },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },
  load(reset) {
    const revision = this.revision = (this.revision || 0) + 1, page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '' });
    return api.purchase.list({ supplierId: this.query.supplierId, keyword: this.data.keyword.trim(), status: this.data.activeFilter || undefined, page, pageSize: 20 })
      .then(res => { if (revision !== this.revision) return; const list = reset ? res.list : this.data.list.concat(res.list); this.setData({ list, page, hasMore: list.length < res.total, summary: res.summary || null }); this.loaded = true; })
      .catch(e => { if (revision === this.revision) this.setData({ error: e.message }); })
      .finally(() => { if (revision === this.revision) this.setData({ loading: false }); });
  },
  onKeyword(e) { this.setData({ keyword: e.detail.value }); },
  onSearch() { return this.load(true); },
  onFilterTap(e) { this.setData({ activeFilter: e.currentTarget.dataset.value }); return this.load(true); },
  onItemTap(e) { this.$go(ROUTES.PURCHASE_DETAIL, { id: e.currentTarget.dataset.id }); }
});

const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');
const { LOAN_STATUS, LOAN_TYPE } = require('../../../constants/status');
const { scan, unitCode } = require('../../../utils/scan');

/**
 * 出借 / 借入列表：出借算业务出库但不计销售；借入为外部货权，归还后冲销。
 * 逾期按北京时间由服务端动态判定；列表只读，归还/复检在详情页逐台处理。
 */
createPage({
  requireStaff: true,
  permission: PERM.LOAN_MANAGE,
  data: {
    list: [], page: 1, total: 0, hasMore: true, loading: false, error: '', keyword: '',
    types: [{ value: '', label: '全部类型' }, { value: 'loan_out', label: '出借' }, { value: 'borrow_in', label: '借入' }],
    statuses: [{ value: '', label: '全部' }, { value: 'active', label: '进行中' }, { value: 'overdue', label: '已逾期' }, { value: 'returned_recheck', label: '归还待复检' }, { value: 'closed', label: '已完结' }],
    type: '', status: ''
  },

  onLoad(query = {}) {
    this.setData({
      statusMap: LOAN_STATUS,
      typeMap: LOAN_TYPE,
      type: LOAN_TYPE[query.type] ? query.type : '',
      status: this.data.statuses.some((s) => s.value === query.status) ? query.status : ''
    });
    return this.load(true);
  },
  onShow() { if (this.loaded) this.load(true); },
  onUnload() { this.destroyed = true; },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },

  async load(reset) {
    const revision = this.revision = (this.revision || 0) + 1, page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.loan.list({ type: this.data.type || undefined, status: this.data.status || undefined, keyword: this.data.keyword.trim() || undefined, page, pageSize: 20 });
      if (this.destroyed || revision !== this.revision) return;
      const rows = res.list.map((o) => ({ ...o, names: o.items.map((i) => i.name).join('、'), open: o.items.filter((i) => i.status === 'active').length }));
      const list = reset ? rows : this.data.list.concat(rows);
      this.setData({ list, page, total: res.total, hasMore: list.length < res.total });
      this.loaded = true;
    } catch (e) { if (!this.destroyed && revision === this.revision) this.setData({ error: e.message }); }
    finally { if (!this.destroyed && revision === this.revision) this.setData({ loading: false }); }
  },

  onType(e) { this.setData({ type: e.currentTarget.dataset.value }); return this.load(true); },
  onStatus(e) { this.setData({ status: e.currentTarget.dataset.value }); return this.load(true); },
  onKeyword(e) { this.setData({ keyword: e.detail.value }); },
  onSearch() { return this.load(true); },
  async onScan() { try { this.setData({ keyword: unitCode(await scan()) }); return this.load(true); } catch (_) {} },
  onCreate(e) { this.$go(ROUTES.LOAN_EDIT, { type: e.currentTarget.dataset.type }); },
  onItemTap(e) { this.$go(ROUTES.LOAN_DETAIL, { id: e.currentTarget.dataset.id }); }
});

const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { ROUTES } = require('../../../utils/router');
const { AGENT_ORDER_STATUS } = require('../../../constants/status');
const { date } = require('../../../utils/format');

/**
 * 代理订单（框架文档 7.3）：顾客经代理链接下单后锁定设备；门店进入对应顾客意向用收银按分享价确认成交，
 * 或关闭意向释放锁定；到期未成交由服务端自动释放。
 */
createPage({
  requireStaff: true,
  permission: [PERM.AGENT_REVIEW, PERM.AGENT_SETTLE, PERM.SALES_CREATE],
  data: {
    list: [], page: 1, total: 0, hasMore: true, loading: false, error: '', status: 'locked',
    filters: [{ value: 'locked', label: '锁定中' }, { value: 'sold', label: '已成交' }, { value: 'released', label: '已释放' }, { value: '', label: '全部' }]
  },
  onLoad(query = {}) { this.setData({ statusMap: AGENT_ORDER_STATUS, status: query.status !== undefined && (AGENT_ORDER_STATUS[query.status] || query.status === '') ? query.status : 'locked' }); },
  onShow() { return this.load(true); },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },
  async load(reset) {
    const revision = this.revision = (this.revision || 0) + 1, page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.adminAgent.orders({ status: this.data.status || undefined, page, pageSize: 20 });
      if (revision !== this.revision) return;
      const rows = res.list.map((o) => ({ ...o, createdText: date(new Date(o.createdAt)), lockText: date(new Date(o.lockExpiresAt), 'MM-DD HH:mm') }));
      const list = reset ? rows : this.data.list.concat(rows);
      this.setData({ list, page, total: res.total, hasMore: list.length < res.total });
    } catch (e) { if (revision === this.revision) this.setData({ error: e.message }); }
    finally { if (revision === this.revision) this.setData({ loading: false }); }
  },
  onFilter(e) { this.setData({ status: e.currentTarget.dataset.value }); return this.load(true); },
  onOpen(e) { this.$go(ROUTES.CUSTOMER_REQUEST_DETAIL, { id: e.currentTarget.dataset.id }); }
});

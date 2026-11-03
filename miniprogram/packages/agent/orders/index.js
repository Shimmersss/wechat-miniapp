const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { AGENT_ORDER_STATUS } = require('../../../constants/status');
const { date } = require('../../../utils/format');

/**
 * 我的订单（框架文档 7.3）：顾客通过我的链接下单后锁定设备，门店确认收款成交或到期/取消释放。
 * 顾客姓名和电话由服务端脱敏；代理不能修改库存或订单。
 */
createPage({
  requireAgent: true,
  data: {
    list: [], page: 1, total: 0, hasMore: true, loading: false, error: '', status: '',
    filters: [{ value: '', label: '全部' }, { value: 'locked', label: '锁定中' }, { value: 'sold', label: '已成交' }, { value: 'released', label: '已释放' }]
  },
  onLoad(query = {}) { this.setData({ statusMap: AGENT_ORDER_STATUS, status: AGENT_ORDER_STATUS[query.status] ? query.status : '' }); return this.load(true); },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },
  async load(reset) {
    const revision = this.revision = (this.revision || 0) + 1, page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.agent.orders({ status: this.data.status || undefined, page, pageSize: 20 });
      if (revision !== this.revision) return;
      const rows = res.list.map((o) => ({ ...o, createdText: date(new Date(o.createdAt)), lockText: date(new Date(o.lockExpiresAt), 'MM-DD HH:mm') }));
      const list = reset ? rows : this.data.list.concat(rows);
      this.setData({ list, page, total: res.total, hasMore: list.length < res.total });
    } catch (e) { if (revision === this.revision) this.setData({ error: e.message }); }
    finally { if (revision === this.revision) this.setData({ loading: false }); }
  },
  onFilter(e) { this.setData({ status: e.currentTarget.dataset.value }); return this.load(true); }
});

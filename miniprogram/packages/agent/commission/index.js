const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { SETTLEMENT_STATUS } = require('../../../constants/status');

/**
 * 收益明细（框架文档 十三.1）：每笔成交按加价快照记一条收益，公司线下转账后标记已转账；
 * 退款先冲回未转账收益，已转账的形成负向记录在后续订单抵扣
 */
createPage({
  requireAgent: true,
  data: {
    list: [],
    page: 1,
    hasMore: true,
    loading: false,
    todos: [
      '顶部汇总：待转账 / 已转账 / 本月',
      '按单记账与转账说明'
    ],
    filters: [
      { value: '', label: '全部' },
      { value: 'pending', label: '待转账' },
      { value: 'settled', label: '已转账' },
      { value: 'reversed', label: '已冲回' }
    ],
    activeFilter: ''
  },

  onLoad(query) {
    this.query = query || {};
    this.setData({ statusMap: SETTLEMENT_STATUS });
    if (this.query.status && this.data.filters) this.setData({ activeFilter: this.query.status });
    this.load(true);
  },

  onPullDownRefresh() {
    this.load(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore) this.load(false);
  },

  load(reset) {
    if (this.data.loading) return Promise.resolve();
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    return api.agent.commissions({ ...this.query, page, pageSize: 20, status: this.data.activeFilter || undefined })
      .then((res) => {
        const list = reset ? res.list : this.data.list.concat(res.list);
        this.setData({ list, page, hasMore: list.length < res.total });
      })
      .finally(() => this.setData({ loading: false }));
  },

  onFilterTap(e) {
    this.setData({ activeFilter: e.currentTarget.dataset.value });
    this.load(true);
  },
});

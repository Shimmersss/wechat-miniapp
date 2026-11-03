const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');
const { SETTLEMENT_STATUS } = require('../../../constants/status');

/**
 * 代理收益转账（框架文档 十三.1）：按单记账，公司线下转账后逐单标记已转账；二次确认 + 原因，写审计日志；退款冲回
 */
createPage({
  requireStaff: true,
  permission: PERM.AGENT_SETTLE,
  data: {
    list: [],
    page: 1,
    hasMore: true,
    loading: false,
    todos: [
      '勾选已线下转账的收益记录 → confirmSensitive + api.adminAgent.settle 标记已转账',
      '按代理汇总'
    ],
    filters: [
      { value: 'pending', label: '待转账' },
      { value: 'settled', label: '已转账' },
      { value: 'reversed', label: '已冲回' }
    ],
    activeFilter: 'pending'
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
    return api.adminAgent.settlements({ ...this.query, page, pageSize: 20, status: this.data.activeFilter || undefined })
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

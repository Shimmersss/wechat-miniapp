const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { AGENT_ORDER_STATUS } = require('../../../constants/status');

/**
 * 我的订单：代理归因订单：锁库存 → 总部确认成交 / 释放；代理不能手工改库存
 */
createPage({
  requireAgent: true,
  data: {
    list: [],
    page: 1,
    hasMore: true,
    loading: false,
    todos: [
      '订单详情：锁定倒计时、成交价快照',
      '顾客信息脱敏显示'
    ],
    filters: [
      { value: '', label: '全部' },
      { value: 'locked', label: '已锁定' },
      { value: 'confirmed', label: '已成交' },
      { value: 'refunded', label: '已退款' }
    ],
    activeFilter: ''
  },

  onLoad(query) {
    this.query = query || {};
    this.setData({ statusMap: AGENT_ORDER_STATUS });
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
    return api.agent.orders({ ...this.query, page, pageSize: 20, status: this.data.activeFilter || undefined })
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

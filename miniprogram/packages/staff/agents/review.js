const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');
const { AGENT_STATUS } = require('../../../constants/status');

/**
 * 代理审核：代理申请审核：通过时设置加价上限（固定金额，框架文档 十三.1）
 */
createPage({
  requireStaff: true,
  permission: PERM.AGENT_REVIEW,
  data: {
    list: [],
    page: 1,
    hasMore: true,
    loading: false,
    todos: [
      '通过/拒绝按钮 → api.adminAgent.review（二次确认）',
      '通过时填写加价上限',
      '代理列表 tab（api.adminAgent.agents）'
    ],
    filters: [
      { value: 'pending', label: '待审核' },
      { value: 'active', label: '已通过' },
      { value: 'rejected', label: '未通过' }
    ],
    activeFilter: 'pending'
  },

  onLoad(query) {
    this.query = query || {};
    this.setData({ statusMap: AGENT_STATUS });
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
    return api.adminAgent.applications({ ...this.query, page, pageSize: 20, status: this.data.activeFilter || undefined })
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

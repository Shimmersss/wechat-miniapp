const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');

/**
 * 操作日志：审计日志只读：登录、入库、改价、出库、退款、导出、权限变化；追加写入不可修改
 */
createPage({
  requireStaff: true,
  permission: PERM.AUDIT_VIEW,
  data: {
    list: [],
    page: 1,
    hasMore: true,
    loading: false,
    todos: [
      '按操作人 / 动作 / 时间筛选',
      '展开改前改后、IP/设备、关联单号'
    ]
  },

  onLoad(query) {
    this.query = query || {};
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
    return api.audit.list({ ...this.query, page, pageSize: 20 })
      .then((res) => {
        const list = reset ? res.list : this.data.list.concat(res.list);
        this.setData({ list, page, hasMore: list.length < res.total });
      })
      .finally(() => this.setData({ loading: false }));
  },
});

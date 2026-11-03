const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');

/**
 * 角色与字段权限：RBAC + 字段级权限（成本、供应商、内部备注、完整 IMEI、毛利）
 */
createPage({
  requireStaff: true,
  permission: PERM.STAFF_MANAGE,
  data: {
    list: [],
    page: 1,
    hasMore: true,
    loading: false,
    todos: [
      '权限点勾选（PERM）',
      '字段可见性配置（SENSITIVE_FIELDS）',
      '保存需二次确认 + 审计'
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
    return api.staff.roles({ ...this.query, page, pageSize: 20 })
      .then((res) => {
        const list = reset ? res.list : this.data.list.concat(res.list);
        this.setData({ list, page, hasMore: list.length < res.total });
      })
      .finally(() => this.setData({ loading: false }));
  },
});

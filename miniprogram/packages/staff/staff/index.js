const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');

/**
 * 员工管理：员工独立账号 + 微信绑定 + 可选二次验证；权限变化写审计
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
      '新增员工（手机号 + 角色 + 数据范围）',
      '停用/启用、解绑微信（二次确认）',
      '角色名称显示使用 ROLE_LABELS'
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
    return api.staff.list({ ...this.query, page, pageSize: 20 })
      .then((res) => {
        const list = reset ? res.list : this.data.list.concat(res.list);
        this.setData({ list, page, hasMore: list.length < res.total });
      })
      .finally(() => this.setData({ loading: false }));
  },
});

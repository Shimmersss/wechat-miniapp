const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM, ROLE_LABELS } = require('../../../constants/roles');
const { ROUTES } = require('../../../utils/router');
const { can } = require('../../../utils/permission');
const { MINE_GROUPS, allowedGroups } = require('../entries');

/** 方案 G 演示 · 我的（员工）：个人卡为毛玻璃，功能分组为白卡；概览数字仅在有工作台权限时加载 */
createPage({
  requireStaff: true,
  data: { roleLabel: '', groups: [], summary: null, routes: ROUTES },

  onLoad() {
    const { user } = this.data;
    this.setData({ roleLabel: ROLE_LABELS[user.role] || '', groups: allowedGroups(user, MINE_GROUPS) });
  },

  onShow() {
    if (!can(this.data.user, PERM.DASHBOARD_VIEW)) return;
    api.dashboard.overview().then(stats => this.setData({
      summary: {
        inStock: stats.inventory.inStock,
        sold: stats.sales.count,
        todos: (stats.todos || []).reduce((n, t) => n + (t.count || 0), 0),
        visitors: stats.visits.uv
      }
    })).catch(() => this.setData({ summary: null }));
  }
});

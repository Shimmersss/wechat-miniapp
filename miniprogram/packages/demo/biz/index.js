const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { ROUTES } = require('../../../utils/router');
const { BIZ_GROUPS, allowedGroups } = require('../entries');

/** 方案 G 演示 · 经营：今日数字浮在光晕上（毛玻璃），业务分组为白卡，入口按权限过滤 */
createPage({
  requireStaff: true,
  permission: PERM.DASHBOARD_VIEW,
  data: { stats: null, groups: [], error: '', routes: ROUTES },

  onLoad() {
    this.setData({ groups: allowedGroups(this.data.user, BIZ_GROUPS) });
  },

  onShow() {
    this.load();
  },

  load() {
    this.setData({ error: '' });
    return api.dashboard.overview()
      .then(stats => this.setData({ stats }))
      .catch(e => this.setData({ error: e.message }));
  }
});

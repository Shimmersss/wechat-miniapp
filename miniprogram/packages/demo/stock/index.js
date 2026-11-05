const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { ROUTES } = require('../../../utils/router');
const { can } = require('../../../utils/permission');
const { STOCK_QUICK, allowed } = require('../entries');

/** 方案 G 演示 · 库存数据：api.dashboard.overview()，成本/毛利由服务端按角色裁剪，undefined 显示"无权限查看" */
createPage({
  requireStaff: true,
  permission: PERM.DASHBOARD_VIEW,
  data: { stats: null, quick: [], canSell: false, error: '', routes: ROUTES },

  onLoad() {
    const { user } = this.data;
    this.setData({ quick: allowed(user, STOCK_QUICK), canSell: can(user, PERM.SALES_CREATE) });
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

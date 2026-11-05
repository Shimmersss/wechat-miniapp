const { createPage } = require('../../utils/page');
const config = require('../../config/index');
const auth = require('../../utils/auth');
const { ROUTES } = require('../../utils/router');
const { isStaff, isAgent } = require('../../utils/permission');
const { ROLE_LABELS } = require('../../constants/roles');

const MOCK_ROLES = ['customer', 'peer', 'agent', 'boss', 'manager', 'purchaser', 'warehouse', 'sales', 'engineer', 'finance'];

createPage({
  data: {
    roleLabel: '',
    staff: false,
    agent: false,
    devMode: config.useMock,
    mockRoles: MOCK_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
    mockRoleIndex: 0
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const user = auth.getCachedUser();
    const role = (user && user.role) || 'customer';
    this.setData({
      user,
      roleLabel: ROLE_LABELS[role],
      staff: isStaff(user),
      agent: isAgent(user),
      mockRoleIndex: Math.max(0, MOCK_ROLES.indexOf(role))
    });
  },

  goStaff() {
    this.$go(this.data.staff ? ROUTES.DASHBOARD : ROUTES.LOGIN);
  },

  goAgent() {
    this.$go(this.data.agent ? ROUTES.AGENT_CENTER : ROUTES.AGENT_LANDING);
  },

  /** 方案 G 视觉演示：员工身份进经营页，其他身份进顾客首页 */
  goDemo() {
    this.$go(this.data.staff ? ROUTES.DEMO_BIZ : ROUTES.DEMO_HOME);
  },

  /** 仅 mock 模式：切换身份以验证不同角色看到的价格与字段 */
  onMockRoleChange(e) {
    if (!config.useMock) return;
    const role = MOCK_ROLES[Number(e.detail.value)];
    wx.setStorageSync(require('../../mock/index').ROLE_KEY, role);
    auth.silentLogin().then(() => {
      this.refresh();
      this.$toast(`已切换为${ROLE_LABELS[role]}`);
    });
  },

  onLogout() {
    auth.logout().then(() => auth.silentLogin()).then(() => this.refresh());
  }
});

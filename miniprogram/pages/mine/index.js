const { createPage } = require('../../utils/page');
const config = require('../../config/index');
const auth = require('../../utils/auth');
const { ROUTES } = require('../../utils/router');
const { isStaff, isAgent } = require('../../utils/permission');
const { ROLE_LABELS } = require('../../constants/roles');
const theme = require('../../utils/theme');

const MOCK_ROLES = ['customer', 'peer', 'agent', 'boss', 'manager', 'purchaser', 'warehouse', 'sales', 'engineer', 'finance'];

createPage({
  data: {
    roleLabel: '',
    staff: false,
    agent: false,
    devMode: config.useMock,
    mockRoles: MOCK_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
    mockRoleIndex: 0,
    // 主题切换：system 跟随系统，light / dark 写死
    themeOptions: [
      { value: 'system', label: '跟随系统' },
      { value: 'light', label: '浅色' },
      { value: 'dark', label: '深色' }
    ],
    themePreference: 'system'
  },

  onShow() {
    this.setData({ themePreference: theme.getPreference() });
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
  /** 切换主题：换的是 theme-shell 的类名，页面样式一行都不用改 */
  onThemeTap(e) {
    const value = e.currentTarget.dataset.value;
    if (value === this.data.themePreference) return;
    theme.set(value);
    this.setData({ themePreference: theme.getPreference() });
  },

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

const { createPage } = require('../../utils/page');
const auth = require('../../utils/auth');
const { ROUTES } = require('../../utils/router');
const { isStaff, isAgent } = require('../../utils/permission');
const { openAgentCenter } = require('../../utils/agent-entry');
const { ROLE_LABELS } = require('../../constants/roles');
const theme = require('../../utils/theme');

createPage({
  data: {
    roleLabel: '',
    staff: false,
    agent: false,
    // 主题切换：system 跟随系统，light / dark 写死
    themeOptions: [
      { value: 'light', label: '浅色' },
      { value: 'dark', label: '深色' },
      { value: 'retail', label: '零售绿' }
    ],
    themePreference: 'light'
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
      agent: isAgent(user)
    });
  },

  goStaff() {
    this.$go(this.data.staff ? ROUTES.DASHBOARD : ROUTES.LOGIN);
  },

  goAgent() {
    if (this.data.agent) return openAgentCenter(this, () => this.refresh());
    return this.$go(ROUTES.AGENT_LANDING);
  },

  /** 切换主题：换的是 theme-shell 的类名，页面样式一行都不用改 */
  onThemeTap(e) {
    const value = e.currentTarget.dataset.value;
    if (value === this.data.themePreference) return;
    theme.set(value);
    this.setData({ themePreference: theme.getPreference() });
  },

  onLogout() {
    auth.logout().then(() => this.refresh());
  }
});

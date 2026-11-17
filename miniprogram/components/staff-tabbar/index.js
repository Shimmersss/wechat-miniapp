/**
 * 员工端底部导航（原生 tabBar 只能给顾客端用，员工端用此组件 + redirectTo）。
 * 使用：<staff-tabbar active="dashboard" />，页面容器加 class="has-staff-tabbar" 留出底部空间。
 */
const auth = require('../../utils/auth');
const api = require('../../api/index');
const events = require('../../utils/events');
const todoState = require('../../utils/dashboard-todos');
const { can } = require('../../utils/permission');
const { PERM } = require('../../constants/roles');
const TABS = [
  { key: 'dashboard', text: '工作台', icon: 'dashboard', url: '/packages/staff/dashboard/index' },
  { key: 'inventory', text: '库存', icon: 'box', url: '/packages/staff/inventory/list' },
  { key: 'pos', text: '开单', icon: 'plus', url: '/packages/staff/pos/index' },
  { key: 'stats', text: '报表', icon: 'chart', url: '/packages/staff/stats/index' },
  { key: 'profile', text: '我的', icon: 'user', url: '/packages/staff/profile/index' }
];

Component({
  properties: {
    active: { type: String, value: 'dashboard' }
  },
  data: { tabs: TABS, todoCount: 0 },
  lifetimes: {
    attached() { this.offTodos = events.on('dashboard:todos', value => { if(value.userId === auth.getCachedUser()?.id)this.setData({todoCount:value.total}); }); },
    detached() { this.detached=true; if(this.offTodos)this.offTodos(); }
  },
  pageLifetimes: { show() { this.refreshTodos(); } },
  methods: {
    async refreshTodos() {
      const user = auth.getCachedUser();
      this.setData({todoCount:0});
      if(this.data.active === 'dashboard' || !can(user,PERM.DASHBOARD_VIEW))return;
      try {
        const stats=await api.dashboard.overview();
        if(!this.detached && auth.getCachedUser()?.id===user.id)this.setData({todoCount:todoState.total(todoState.withDrafts(stats.todos,user))});
      } catch(e) { console.warn('[dashboard badge]',e.message); }
    },
    onTap(e) {
      const { key, url } = e.currentTarget.dataset;
      if (key === this.data.active) return;
      wx.redirectTo({ url });
    }
  }
});

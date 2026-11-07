/**
 * 方案 G 悬浮毛玻璃底栏：四个演示页之间用 redirectTo 切换，中间「＋」进入收银（按权限）。
 * 组件自带底部占位，保证最后一屏内容能滚出底栏。
 */
const auth = require('../../../../utils/auth');
const { can } = require('../../../../utils/permission');
const { PERM } = require('../../../../constants/roles');
const { ROUTES, go } = require('../../../../utils/router');
const theme = require('../../../../utils/theme');

const TABS = [
  { key: 'home', text: '首页', icon: 'home', url: ROUTES.DEMO_HOME },
  { key: 'biz', text: '经营', icon: 'agent', url: ROUTES.DEMO_BIZ },
  { key: 'plus' },
  { key: 'stock', text: '库存', icon: 'grid', url: ROUTES.DEMO_STOCK },
  { key: 'mine', text: '我的', icon: 'user', url: ROUTES.DEMO_MINE }
];

Component({
  properties: { active: { type: String, value: '' } },
  data: { tabs: TABS, dark: false },
  lifetimes: {
    attached() {
      // 深色主题下选中态图标要用浅色变体，否则深色描边糊在深底上看不见
      const sync = () => this.setData({ dark: theme.get() === 'dark' });
      sync();
      this._off = theme.onChange(sync);
    },
    detached() { if (this._off) this._off(); }
  },
  methods: {
    onTab(e) {
      const { key, url } = e.currentTarget.dataset;
      if (key === this.data.active) return;
      wx.redirectTo({ url });
    },
    onPlus() {
      if (!can(auth.getCachedUser(), PERM.SALES_CREATE)) {
        wx.showToast({ title: '当前账号没有收银权限', icon: 'none' });
        return;
      }
      go(ROUTES.POS);
    }
  }
});

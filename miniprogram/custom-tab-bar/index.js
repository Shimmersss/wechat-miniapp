/**
 * 顾客端自定义 tabBar（原生 tabBar 字号不可调）。路径需与 app.json tabBar.list 一致；
 * 每个 tab 页各有一个实例，由 createPage 的 onShow 调用 sync(route) 同步选中项，页面无需额外代码。
 *
 * 主题：图标是 <image> 引用的 SVG，吃不到 CSS 变量，深色主题下必须换一套浅色描边的
 * 图标（*-light.svg）。组件自己订阅 theme 变化，页面不用管。
 */
const theme = require('../utils/theme');

const TABS = [
  { path: 'pages/shop/index', text: '首页', icon: 'home' },
  { path: 'pages/category/index', text: '分类', icon: 'grid' },
  { path: 'pages/agent-landing/index', text: '成为代理', icon: 'agent' },
  { path: 'pages/mine/index', text: '我的', icon: 'user' }
];

Component({
  data: { tabs: TABS, selected: 0, dark: false },

  lifetimes: {
    attached() {
      this.setData({ dark: theme.get() === 'dark' });
      this._off = theme.onChange(({ theme: t }) => this.setData({ dark: t === 'dark' }));
    },
    detached() {
      if (this._off) this._off();
    }
  },

  methods: {
    sync(route) {
      const index = TABS.findIndex((t) => t.path === route);
      const dark = theme.get() === 'dark';
      const patch = {};
      if (index >= 0 && index !== this.data.selected) patch.selected = index;
      if (dark !== this.data.dark) patch.dark = dark;
      if (Object.keys(patch).length) this.setData(patch);
    },
    onTap(e) {
      const index = e.currentTarget.dataset.index;
      if (index === this.data.selected) return;
      wx.switchTab({ url: '/' + TABS[index].path });
    }
  }
});

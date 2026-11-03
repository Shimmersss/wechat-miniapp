/**
 * 顾客端自定义 tabBar（原生 tabBar 字号不可调）。路径需与 app.json tabBar.list 一致；
 * 每个 tab 页各有一个实例，由 createPage 的 onShow 调用 sync(route) 同步选中项，页面无需额外代码。
 */
const TABS = [
  { path: 'pages/shop/index', text: '首页', icon: 'home' },
  { path: 'pages/category/index', text: '分类', icon: 'grid' },
  { path: 'pages/agent-landing/index', text: '成为代理', icon: 'agent' },
  { path: 'pages/mine/index', text: '我的', icon: 'user' }
];

Component({
  data: { tabs: TABS, selected: 0 },
  methods: {
    sync(route) {
      const index = TABS.findIndex((t) => t.path === route);
      if (index >= 0 && index !== this.data.selected) this.setData({ selected: index });
    },
    onTap(e) {
      const index = e.currentTarget.dataset.index;
      if (index === this.data.selected) return;
      wx.switchTab({ url: '/' + TABS[index].path });
    }
  }
});

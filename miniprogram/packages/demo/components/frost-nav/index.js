/**
 * 方案 G 毛玻璃顶栏：页面需设置 navigationStyle: custom。
 * 标题按右上角胶囊按钮垂直居中；组件自带等高占位，页面内容从栏下滑过并被虚化。
 */
Component({
  properties: { title: { type: String, value: '' } },
  data: { barHeight: 64, titleTop: 24, titleHeight: 32, titleRight: 96 },
  lifetimes: {
    attached() {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const statusBar = win.statusBarHeight || 20;
      let rect = null;
      try { rect = wx.getMenuButtonBoundingClientRect(); } catch (e) { rect = null; }
      const top = rect && rect.top ? rect.top : statusBar + 6;
      const height = rect && rect.height ? rect.height : 32;
      this.setData({
        titleTop: top,
        titleHeight: height,
        titleRight: rect && rect.left ? win.windowWidth - rect.left + 8 : 96,
        barHeight: top + height + (top - statusBar) + 4
      });
    }
  }
});

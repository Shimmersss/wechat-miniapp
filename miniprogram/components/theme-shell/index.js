/**
 * 主题外壳：把页面内容包在一层可切换的 CSS 变量作用域里。
 *
 * 用法（页面 wxml 最外层）：
 *   <theme-shell><view class="container">…</view></theme-shell>
 *
 * 为什么需要它：小程序的 <page> 无法动态加 class，
 * CSS 变量必须挂在一个真实存在的元素上才能切换。
 *
 * 组件内部自己订阅 'theme:changed'，所以页面不需要关心主题逻辑，
 * 主题一变，所有已挂载的外壳会一起重绘。
 */
const theme = require('../../utils/theme');

Component({
  options: {
    // 让外层页面 wxss 里的样式能作用到 slot 内容
    styleIsolation: 'apply-shared',
    multipleSlots: false
  },

  data: {
    themeClass: 'theme-root'
  },

  lifetimes: {
    attached() {
      const t = theme.get();
      this.setData({ themeClass: theme.classes(t) });
      this._off = theme.onChange(({ theme: next }) => {
        this.setData({ themeClass: theme.classes(next) });
      });
    },
    detached() {
      if (this._off) this._off();
    }
  },

  pageLifetimes: {
    // 从后台回到前台时，系统主题可能已经变了
    show() {
      const t = theme.get();
      const next = theme.classes(t);
      if (next !== this.data.themeClass) this.setData({ themeClass: next });
    }
  }
});

/** 带标题的卡片容器；设置 more 后右上角显示“›”并触发 more 事件或跳转 moreUrl */
Component({
  options: { multipleSlots: true },
  properties: {
    title: { type: String, value: '' },
    subtitle: { type: String, value: '' },
    moreUrl: { type: String, value: '' },
    dark: { type: Boolean, value: false }
  },
  methods: {
    onMore() {
      if (this.data.moreUrl) wx.navigateTo({ url: this.data.moreUrl });
      this.triggerEvent('more');
    }
  }
});

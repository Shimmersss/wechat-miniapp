const config = require('../../config/index');

/** 品牌头：Logo + 夏目数码 + 口号，右侧插槽放角色标签/金额遮挡按钮 */
Component({
  options: { multipleSlots: true },
  properties: {
    dark: { type: Boolean, value: false },
    showSlogan: { type: Boolean, value: true }
  },
  data: { brand: config.brand }
});

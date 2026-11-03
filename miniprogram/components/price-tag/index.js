/**
 * 价格显示。value 为 undefined 时显示 placeholder（服务端无权限返回时）。
 * privacy=true 时遮挡为 ••••（只遮挡屏幕，不替代授权）。
 */
Component({
  properties: {
    value: { type: null, value: undefined },
    size: { type: String, value: 'md' }, // sm | md | lg
    color: { type: String, value: 'price' }, // price | ink | gold | white
    privacy: { type: Boolean, value: false },
    placeholder: { type: String, value: '无权限查看' }
  }
});

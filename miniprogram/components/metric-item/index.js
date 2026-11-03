/** 指标块：label / value / hint；value 为空时显示 --（例如无利润权限） */
Component({
  properties: {
    label: { type: String, value: '' },
    value: { type: null, value: '' },
    hint: { type: String, value: '' },
    dark: { type: Boolean, value: false },
    highlight: { type: Boolean, value: false },
    align: { type: String, value: 'left' }
  }
});

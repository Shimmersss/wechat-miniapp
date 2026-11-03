const { upload } = require('../../utils/request');
Component({
  properties: { fields: Array, values: Object, disabled: Boolean },
  data: { uploading: false },
  methods: {
    change(e) {
      if (this.data.disabled) return;
      const { key, value } = e.currentTarget.dataset;
      this.triggerEvent('change', { key, value: value === undefined ? e.detail.value : value });
    },
    chooseImage(e) {
      if (this.data.disabled || this.data.uploading) return;
      const field = this.data.fields.find(f => f.key === e.currentTarget.dataset.key);
      const current = (this.data.values || {})[field.key] || [];
      const scope = field.visibility.includes('internal') ? 'internal' : 'public';
      this.setData({ uploading: true });
      this.triggerEvent('busy', { busy: true });
      wx.chooseMedia({ count: Math.max(1, 9 - current.length), mediaType: ['image'], sizeType: ['compressed'] })
        .then(res => Promise.all(res.tempFiles.map(f => upload({ filePath: f.tempFilePath, scope, bizType: 'unit' }))))
        .then(files => this.triggerEvent('change', { key: field.key, value: current.concat(files).slice(0, 9) }))
        .catch(e => { if (!String(e.errMsg || '').includes('cancel')) wx.showToast({ title: '图片上传未完成，请重试', icon: 'none' }); })
        .finally(() => { this.setData({ uploading: false }); this.triggerEvent('busy', { busy: false }); });
    },
    removeImage(e) {
      if (this.data.disabled) return;
      const { key, index } = e.currentTarget.dataset;
      this.triggerEvent('change', { key, value: (this.data.values[key] || []).filter((f, i) => i !== Number(index)) });
    }
  }
});

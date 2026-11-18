const media = require('../../utils/media');
Component({
  properties: { fields: Array, values: Object, disabled: Boolean },
  data: { uploading: false, custom: {}, customLabels: {} },
  observers: {
    'fields, values': function(fields, values) {
      const custom = {};
      const customLabels = {};
      (fields || []).forEach(f => {
        const value = (values || {})[f.key];
        if (f.allowCustom && f.type === 'select') {
          custom[f.key] = value ? !(f.options || []).includes(value) : !!this.data.custom[f.key];
          customLabels[f.key] = custom[f.key] && value ? '自定义：' + value : '自定义';
        }
      });
      this.setData({ custom, customLabels });
    }
  },
  methods: {
    change(e) {
      if (this.data.disabled) return;
      const { key, value } = e.currentTarget.dataset;
      if (value !== undefined) this.setData({ [`custom.${key}`]: false });
      this.triggerEvent('change', { key, value: value === undefined ? e.detail.value : value });
    },
    chooseCustom(e) {
      if (this.data.disabled) return;
      const key = e.currentTarget.dataset.key;
      this.setData({ [`custom.${key}`]: true });
      this.triggerEvent('change', { key, value: '' });
    },
    customInput(e) {
      if (!this.data.disabled) this.triggerEvent('change', { key: e.currentTarget.dataset.key, value: e.detail.value });
    },
    customBlur(e) {
      if (!this.data.disabled) this.triggerEvent('change', { key: e.currentTarget.dataset.key, value: e.detail.value.trim() });
    },
    chooseImage(e) {
      if (this.data.disabled || this.data.uploading) return;
      const field = this.data.fields.find(f => f.key === e.currentTarget.dataset.key);
      const current = (this.data.values || {})[field.key] || [];
      if (current.length >= 9) return;
      const scope = field.visibility.includes('internal') ? 'internal' : 'public';
      this.setData({ uploading: true });
      this.triggerEvent('busy', { busy: true });
      media.pickAndUpload({ count: 9 - current.length, scope, purpose: field.key === 'receipt' ? 'acceptance_receipt' : 'unit' })
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

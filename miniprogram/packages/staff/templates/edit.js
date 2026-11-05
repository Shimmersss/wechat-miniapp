const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { TYPES, validateFields } = require('../../../utils/template');
createPage({
  requireStaff: true,
  permission: PERM.TEMPLATE_MANAGE,
  data: {
    id: '', detail: null, dirty: false, publishing: false, error: '',
    editor: null, editIndex: -1, types: TYPES,
    typeLabels: ['文本', '数字', '单选', '开关', '关联文本', '图片', '日期'],
    visibilityOptions: [{ value: 'customer', label: '顾客' }, { value: 'peer', label: '同行' }, { value: 'internal', label: '仅内部' }],
    history: [], historyPage: 0, historyMore: true, historyLoading: false, historyVisible: false
  },
  onLoad(query) { this.setData({ id: query.id }); this.load(); },
  onPullDownRefresh() {
    if (this.data.dirty) { wx.stopPullDownRefresh(); return this.$toast('请先发布修改，或退出后重新进入'); }
    this.load().finally(() => wx.stopPullDownRefresh());
  },
  load() {
    return api.template.detail(this.data.id).then(detail => this.setData({ peerPresetText: ((detail.descriptionPresets || {}).peer || []).join('\n'), customerPresetText: ((detail.descriptionPresets || {}).customer || []).join('\n'), detail, dirty: false, error: '' })).catch(e => this.setData({ error: e.message }));
  },
  onRetry() { this.load(); },
  onPresetInput(e) { this.setData({ [e.currentTarget.dataset.channel === 'peer' ? 'peerPresetText' : 'customerPresetText']: e.detail.value, [`detail.descriptionPresets.${e.currentTarget.dataset.channel}`]: e.detail.value.split('\n').map(v => v.trim()).filter(Boolean), dirty: true }); },
  onAddField() { this.openEditor(-1); },
  onEditField(e) { this.openEditor(Number(e.currentTarget.dataset.index)); },
  openEditor(index) {
    if (!this.data.detail || this.data.publishing) return;
    const field = index < 0 ? { key: '', label: '', type: 'text', required: false, filterable: false, visibility: ['internal'], default: '' } : JSON.parse(JSON.stringify(this.data.detail.fields[index]));
    this.setData({ editIndex: index, editor: { ...field, typeIndex: TYPES.indexOf(field.type), optionsText: (field.options || []).join('\n'), default: field.default === undefined ? '' : field.default } });
  },
  onEditorInput(e) { this.setData({ [`editor.${e.currentTarget.dataset.field}`]: e.detail.value }); },
  onTypeChange(e) {
    const typeIndex = Number(e.detail.value);
    this.setData({ 'editor.typeIndex': typeIndex, 'editor.type': TYPES[typeIndex], 'editor.default': TYPES[typeIndex] === 'boolean' ? false : '' });
  },
  onVisibilityChange(e) { this.setData({ 'editor.visibility': e.detail.value }); },
  onCloseEditor() { this.setData({ editor: null }); },
  onSaveField() {
    const { editor, editIndex, detail } = this.data;
    const field = { key: editor.key.trim(), label: editor.label.trim(), type: editor.type, required: editor.required, filterable: editor.filterable, visibility: editor.visibility, default: editor.default };
    if (field.type === 'number') { if (editor.min !== undefined && editor.min !== '') field.min = Number(editor.min); if (editor.max !== undefined && editor.max !== '') field.max = Number(editor.max); }
    if (field.type === 'select') field.options = editor.optionsText.split('\n').map(v => v.trim()).filter(Boolean);
    if (field.type === 'number' && field.default !== '') field.default = Number(field.default);
    const fields = detail.fields.slice();
    if (editIndex < 0) fields.push(field); else fields[editIndex] = field;
    const error = validateFields(fields);
    if (error) return this.$toast(error);
    this.setData({ 'detail.fields': fields, editor: null, dirty: true });
  },
  onMove(e) {
    if (this.data.publishing) return;
    const index = Number(e.currentTarget.dataset.index), target = index + Number(e.currentTarget.dataset.step);
    const fields = this.data.detail.fields.slice();
    if (target < 0 || target >= fields.length) return;
    [fields[index], fields[target]] = [fields[target], fields[index]];
    this.setData({ 'detail.fields': fields, dirty: true });
  },
  onDelete(e) {
    if (this.data.publishing) return;
    const index = Number(e.currentTarget.dataset.index);
    wx.showModal({ title: '删除字段', content: '仅影响下一次发布的模板，已有设备快照保留。', success: res => {
      if (res.confirm) this.setData({ 'detail.fields': this.data.detail.fields.filter((f, i) => i !== index), dirty: true });
    } });
  },
  onPublish() {
    if (!this.data.detail || this.data.publishing || !this.data.dirty) return;
    const error = validateFields(this.data.detail.fields);
    if (error) return this.$toast(error);
    wx.showModal({ title: '发布新版本', content: '新入库使用此版本，已入库设备保留旧快照。确认发布？', success: res => { if (res.confirm) this.publish(); } });
  },
  publish() {
    if (this.data.publishing) return;
    this.setData({ publishing: true });
    return api.template.publishVersion(this.data.id, { baseVersion: this.data.detail.version, fields: this.data.detail.fields, descriptionPresets: this.data.detail.descriptionPresets })
      .then(detail => {
        this.setData({ detail, dirty: false, error: '', history: [], historyPage: 0, historyMore: true });
        this.$toast('新版本已发布');
        if (this.data.historyVisible) this.loadHistory(true);
      })
      .catch(e => { this.setData({ error: e.message }); })
      .finally(() => this.setData({ publishing: false }));
  },
  onToggleHistory() {
    this.setData({ historyVisible: !this.data.historyVisible });
    if (this.data.historyVisible && !this.data.history.length) this.loadHistory(true);
  },
  onMoreHistory() { this.loadHistory(false); },
  loadHistory(reset) {
    if (this.data.historyLoading) return;
    this.setData({ historyLoading: true });
    const page = reset ? 1 : this.data.historyPage + 1;
    return api.template.versions(this.data.id, { page, pageSize: 10 }).then(res => {
      const history = reset ? res.list : this.data.history.concat(res.list);
      this.setData({ history, historyPage: page, historyMore: history.length < res.total });
    }).catch(e => this.$toast(e.message)).finally(() => this.setData({ historyLoading: false }));
  }
});

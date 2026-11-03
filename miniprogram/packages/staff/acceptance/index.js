const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { scanImei } = require('../../../utils/scan');
const { isImei } = require('../../../utils/validate');
const { initialValues, validateValues } = require('../../../utils/template');
const { confirmSensitive } = require('../../../utils/confirm');
const { upload } = require('../../../utils/request');
const events = require('../../../utils/events');
let sequence = 0;
const copy = value => JSON.parse(JSON.stringify(value));
const requestKey = () => 'accept_' + Date.now() + '_' + ++sequence + '_' + Math.random().toString(36).slice(2);
createPage({
  requireStaff: true, permission: PERM.ACCEPTANCE,
  data: { poId: '', form: null, loading: false, error: '', items: [], editor: null, lineIndex: 0, fields: [], receiptFields: [],
    busy: 0, uploading: false, submitting: false, pending: null, result: null,
    declaredCount: '', partialConfirmed: false, partialReason: '', exceptionId: '', exception: null, resolutionReason: '' },
  onLoad(query) { this.setData({ poId: query.poId, exceptionId: query.exceptionId || '' }); return this.load(); },
  onUnload() { this.destroyed = true; },
  async load() {
    if (this.data.submitting || this.data.busy || this.data.uploading || this.data.pending) return;
    this.setData({ loading: true, error: '' });
    try {
      const form = await api.purchase.acceptanceForm(this.data.poId);
      let exception = null;
      if (this.data.exceptionId) {
        exception = form.exceptions.find(e => e.id === this.data.exceptionId);
        if (!exception || !['none', 'dispute'].includes(exception.resolution)) throw new Error('该异常已处理或不存在');
      }
      this.setData({ form, exception });
      if (exception && !this.data.editor && !this.data.result) await this.openEditor(exception.lineId, null, exception);
    } catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ loading: false }); }
  },
  locked() { return this.data.submitting || this.data.busy > 0 || this.data.uploading || !!this.data.pending || !!this.data.result; },
  onLinePick(e) { if (!this.locked()) this.setData({ lineIndex: Number(e.detail.value) }); },
  async onAdd() {
    if (this.locked() || this.data.loading || this.data.editor || !this.data.form.canAccept) return;
    const line = this.data.form.lines[this.data.lineIndex];
    if (!line || this.data.items.filter(i => i.lineId === line.id).length >= line.remaining) return this.$toast('此采购明细已无待验数量');
    if (this.data.items.length >= 100) return this.$toast('每批最多 100 台');
    return this.openEditor(line.id);
  },
  async openEditor(lineId, existing, exception) {
    const line = this.data.form.lines.find(l => l.id === lineId);
    if (!line) return this.$toast('采购明细不存在');
    this.setData({ loading: true, error: '' });
    try {
      const template = await api.template.detail(line.templateId);
      if (this.destroyed) return;
      const fields = template.fields.filter(f => f.key !== 'supplier' && f.key !== 'receipt');
      const receipt = { key: 'receipt', label: '收货凭证（内部）', type: 'image', visibility: ['internal'], required: true, filterable: false };
      const attributes = existing ? copy(existing.attributes) : { ...initialValues(fields), ...line.attributes, receipt: [] };
      const editor = existing ? copy(existing) : { key: 'accept_row_' + ++sequence, lineId, modelId: line.modelId, modelName: line.modelName, templateVersion: template.version,
        imei1: exception ? (exception.imei1 || '') : '', imei2: exception ? (exception.imei2 || '') : '', condition: 'used', result: exception ? 'pass' : '', remark: '', observedModel: '',
        attributes, retail: '', wholesale: '', agentBase: '', checksConfirmed: false, publicImages: [], peerDesc: '', customerDesc: '', internalNote: '' };
      editor.templateVersion = template.version;
      this.setData({ editor, fields, receiptFields: [receipt] }, () => wx.pageScrollTo({ selector: '#acceptance-editor', duration: 200 }));
    } catch (e) { this.setData({ error: e.message }); } finally { this.setData({ loading: false }); }
  },
  onEdit(e) { if (!this.locked() && !this.data.editor) { const item = this.data.items.find(i => i.key === e.currentTarget.dataset.key); if (item) return this.openEditor(item.lineId, item); } },
  onRemove(e) { if (!this.locked() && !this.data.editor) this.setData({ items: this.data.items.filter(i => i.key !== e.currentTarget.dataset.key) }); },
  onCancelEditor() { if (!this.locked() && !this.data.exceptionId) this.setData({ editor: null }); },
  onEditorInput(e) {
    if (this.locked() || !this.data.editor) return;
    const field = e.currentTarget.dataset.field;
    if (this.data.exceptionId && ['imei1', 'imei2'].includes(field)) return;
    this.setData({ ['editor.' + field]: e.detail.value });
  },
  onResult(e) { if (!this.locked() && !this.data.exceptionId) this.setData({ 'editor.result': e.currentTarget.dataset.value }); },
  onCondition(e) { if (!this.locked()) this.setData({ 'editor.condition': e.currentTarget.dataset.value }); },
  onAttribute(e) { if (!this.data.submitting && !this.data.pending && this.data.editor) this.setData({ ['editor.attributes.' + e.detail.key]: e.detail.value }); },
  onFieldBusy(e) { this.setData({ busy: Math.max(0, this.data.busy + (e.detail.busy ? 1 : -1)) }); },
  async onScan(e) {
    if (this.locked() || !this.data.editor || this.data.exceptionId) return;
    try {
      const scanned = await scanImei();
      if (!scanned.valid) return this.$toast('IMEI 格式或校验位错误');
      this.setData({ ['editor.' + (e.currentTarget.dataset.field || 'imei1')]: scanned.imei });
    } catch (_) {}
  },
  async onMedia() {
    if (this.locked() || !this.data.editor || this.data.editor.publicImages.length >= 9) return;
    this.setData({ uploading: true });
    try {
      const selected = await wx.chooseMedia({ count: 9 - this.data.editor.publicImages.length, mediaType: ['image', 'video'], sizeType: ['compressed'] });
      const files = await Promise.all(selected.tempFiles.map(async file => ({ ...await upload({ filePath: file.tempFilePath, scope: 'public', bizType: 'unit' }), mediaType: file.fileType === 'video' ? 'video' : 'image' })));
      this.setData({ 'editor.publicImages': this.data.editor.publicImages.concat(files).slice(0, 9) });
    } catch (e) { if (!String(e.errMsg || '').includes('cancel')) this.$toast(e.message || '设备实拍上传失败'); }
    finally { this.setData({ uploading: false }); }
  },
  onRemoveMedia(e) { if (!this.locked()) this.setData({ 'editor.publicImages': this.data.editor.publicImages.filter((f, i) => i !== Number(e.currentTarget.dataset.index)) }); },
  editorError() {
    const e = this.data.editor, seen = new Set();
    if (!e || !['pass', 'fail'].includes(e.result)) return '请选择验收通过或异常';
    if ((!this.data.exceptionId && !isImei(e.imei1)) || (e.imei1 && !isImei(e.imei1)) || (e.imei2 && !isImei(e.imei2))) return '请填写有效的 IMEI1 / IMEI2';
    for (const code of [e.imei1, e.imei2].filter(Boolean)) { if (seen.has(code) || this.data.items.some(i => i.key !== e.key && [i.imei1, i.imei2].includes(code))) return '本批次串码重复'; seen.add(code); }
    if (!e.attributes.receipt || !e.attributes.receipt.length) return '请上传内部收货凭证';
    if (e.result === 'fail') return e.remark.trim() ? '' : '请填写异常原因';
    const error = validateValues(this.data.fields, e.attributes);
    if (error) return error;
    const line = this.data.form.lines.find(l => l.id === e.lineId);
    if (Object.keys(line.attributes).some(key => e.attributes[key] !== line.attributes[key])) return '实机规格与采购不符，请登记异常';
    if (['retail', 'wholesale', 'agentBase'].some(key => !/^\d+(\.\d{1,2})?$/.test(String(e[key])))) return '请填写有效三价，最多两位小数';
    if (!e.checksConfirmed) return '请先确认已逐项核对实机';
    return '';
  },
  onSaveEditor() {
    if (this.locked() || this.data.loading) return;
    const error = this.editorError(); if (error) return this.$toast(error);
    const editor = copy(this.data.editor), items = this.data.items.slice(), index = items.findIndex(i => i.key === editor.key);
    if (index < 0) items.push(editor); else items[index] = editor;
    this.setData({ items, editor: null }, () => wx.pageScrollTo({ scrollTop: 0, duration: 200 }));
  },
  onInput(e) { if (!this.locked()) this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  itemPayload(item) {
    const { lineId, modelId, templateVersion, attributes, imei1, imei2, condition, result, remark, observedModel, retail, wholesale, agentBase, publicImages, customerDesc, peerDesc, internalNote } = item;
    return { lineId, modelId, templateVersion, attributes: copy(attributes), imei1, imei2, condition, result, remark, observedModel, retail, wholesale, agentBase, publicImages: copy(publicImages),
      receiptImages: copy(attributes.receipt), customerDesc, peerDesc, internalNote, flags: { showInShop: false, sharePeer: false, shareAgent: false } };
  },
  async onSubmit() {
    if (this.locked() || this.data.loading || this.data.editor) return;
    const { items, form } = this.data;
    if (!form.canAccept || !items.length) return this.$toast('请先签收并添加验收设备');
    if (!/^\d+$/.test(String(this.data.declaredCount)) || Number(this.data.declaredCount) !== items.length) return this.$toast('本次实收数量须与逐台记录数量一致');
    if (items.length < form.remaining && (!this.data.partialConfirmed || !this.data.partialReason.trim())) return this.$toast('数量不足，请确认分批验收并填写原因');
    if (items.length > form.remaining) return this.$toast('验收数量超过采购剩余数量');
    this.setData({ submitting: true, error: '' });
    try {
      const confirmation = await confirmSensitive({ title: '确认逐台验收', content: '本批 ' + items.length + ' 台，通过 ' + items.filter(i => i.result === 'pass').length + ' 台；异常不会入可售库存。' });
      if (!confirmation.confirmed) return;
      const payload = { requestKey: requestKey(), declaredCount: Number(this.data.declaredCount), partialConfirmed: this.data.partialConfirmed, partialReason: this.data.partialReason, items: items.map(i => this.itemPayload(i)) };
      this.setData({ pending: payload });
      await this.sendPending();
    } catch (e) { this.setData({ error: e.message }); } finally { this.setData({ submitting: false }); }
  },
  async sendPending() {
    const payload = this.data.pending;
    if (!payload) return;
    try {
      const result = await api.purchase.submitAcceptance(this.data.poId, copy(payload));
      this.setData({ result, pending: null, items: [] }); events.emit('inventory:changed', result); events.emit('purchase:changed', { id: this.data.poId });
    } catch (e) {
      // 网络错误结果未知，保留同一请求标识和快照，防止重试重复验收。
      if (e.code && Number(e.code) >= 400 && Number(e.code) < 500) this.setData({ pending: null });
      throw e;
    }
  },
  async onRetry() {
    if (this.data.submitting || !this.data.pending) return;
    this.setData({ submitting: true, error: '' });
    try { await this.sendPending(); } catch (e) { this.setData({ error: e.message }); } finally { this.setData({ submitting: false }); }
  },
  async onReinspect() {
    if (this.locked() || this.data.loading || !this.data.exceptionId) return;
    const error = this.editorError(); if (error) return this.$toast(error);
    if (!this.data.resolutionReason.trim()) return this.$toast('请填写复验处理原因');
    this.setData({ submitting: true });
    try {
      const confirmation = await confirmSensitive({ title: '确认复验通过', content: '沿用采购型号、成本及原异常设备串码，复验通过后生成库存。' });
      if (!confirmation.confirmed) return;
      const result = await api.purchase.resolveAcceptance(this.data.exceptionId, { action: 'reinspect', reason: this.data.resolutionReason, unit: this.itemPayload(this.data.editor) });
      this.setData({ result: { accepted: 1, rejected: 0, unitIds: [result.unitId] }, editor: null }); events.emit('inventory:changed', result); events.emit('purchase:changed', { id: this.data.poId });
    } catch (e) { this.setData({ error: e.message }); } finally { this.setData({ submitting: false }); }
  },
  onBack() { this.$back(); }
});

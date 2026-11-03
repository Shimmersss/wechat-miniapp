const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');
const events = require('../../../utils/events');
let sequence = 0;
function blankLine() { return { key: 'purchase_line_' + ++sequence, modelId: '', modelName: '', quantity: '1', unitCost: '', attributes: {}, specFields: [] }; }
createPage({
  requireStaff: true, permission: PERM.PURCHASE_MANAGE,
  data: { id: '', loading: false, saving: false, saved: null, error: '', supplierName: '', form: { supplierId: '', expectedAt: '', freight: '', remark: '' }, lines: [blankLine()] },
  onLoad(query) {
    this.offSupplier = events.on('purchase:supplier-selected', supplier => {
      if (this.data.saving || this.data.saved || !this.isSelectionTarget()) return;
      this.setData({ supplierName: supplier.name, 'form.supplierId': supplier.id });
    });
    this.offModel = events.on('purchase:model-selected', model => { if (this.isSelectionTarget()) this.selectModel(model); });
    if (query.id) { this.setData({ id: query.id }); return this.load(); }
  },
  onUnload() { this.destroyed = true; if (this.offSupplier) this.offSupplier(); if (this.offModel) this.offModel(); },
  isSelectionTarget() { const pages = getCurrentPages(); return pages[pages.length - 2] === this; },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const detail = await api.purchase.detail(this.data.id);
      if (detail.status !== 'pending_ship') throw new Error('已发货采购单不能修改');
      if (detail.supplierId === undefined || detail.freight === undefined || detail.lines.some(l => l.unitCost === undefined)) throw new Error('当前账号不能读取完整采购信息');
      const templates = await Promise.all(detail.lines.map(l => api.template.detail(l.templateId)));
      this.setData({ supplierName: detail.supplier, form: { supplierId: detail.supplierId, expectedAt: detail.expectedAt, freight: String(detail.freight), remark: detail.remark }, lines: detail.lines.map((l, index) => ({ ...l, key: 'purchase_line_' + ++sequence, specFields: templates[index].fields.filter(f => ['storage', 'color', 'version'].includes(f.key)).map(f => ({ ...f, required: false })) })) });
    } catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ loading: false }); }
  },
  onInput(e) { if (!this.data.saving && !this.data.saved) this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }); },
  onChooseSupplier() { if (!this.data.saving && !this.data.saved) this.$go(ROUTES.SUPPLIERS, { select: '1' }); },
  onAddLine() { if (!this.data.saving && !this.data.saved && this.data.lines.length < 100) this.setData({ lines: this.data.lines.concat(blankLine()) }); },
  onRemoveLine(e) { if (!this.data.saving && !this.data.saved && this.data.lines.length > 1) this.setData({ lines: this.data.lines.filter(l => l.key !== e.currentTarget.dataset.key) }); },
  onChooseModel(e) {
    if (this.data.saving || this.data.saved) return;
    this.selectionKey = e.currentTarget.dataset.key;
    this.$go(ROUTES.TEMPLATES, { select: '1', from: 'purchase' });
  },
  async selectModel(model) {
    if (this.data.saving || this.data.saved) return;
    const key = this.selectionKey, revision = this.modelRevision = (this.modelRevision || 0) + 1;
    this.setData({ loading: true });
    try {
      const template = await api.template.detail(model.templateId);
      if (this.destroyed || revision !== this.modelRevision) return;
      const index = this.data.lines.findIndex(l => l.key === key);
      if (index < 0) return;
      const specFields = template.fields.filter(f => ['storage', 'color', 'version'].includes(f.key)).map(f => ({ ...f, required: false }));
      this.setData({ ['lines[' + index + ']']: { ...this.data.lines[index], modelId: model.id, modelName: model.name, specFields, attributes: {} } });
    } catch (e) { this.$toast(e.message); }
    finally { if (!this.destroyed && revision === this.modelRevision) this.setData({ loading: false }); }
  },
  onLineInput(e) {
    if (this.data.saving || this.data.saved) return;
    const index = this.data.lines.findIndex(l => l.key === e.currentTarget.dataset.key);
    if (index >= 0) this.setData({ ['lines[' + index + '].' + e.currentTarget.dataset.field]: e.detail.value });
  },
  onSpec(e) {
    if (this.data.saving || this.data.saved) return;
    const index = this.data.lines.findIndex(l => l.key === e.currentTarget.dataset.key);
    if (index >= 0) this.setData({ ['lines[' + index + '].attributes.' + e.detail.key]: e.detail.value });
  },
  onClearSpecs(e) { if (!this.data.saving && !this.data.saved) { const index = this.data.lines.findIndex(l => l.key === e.currentTarget.dataset.key); if (index >= 0) this.setData({ ['lines[' + index + '].attributes']: {} }); } },
  async onSubmit() {
    if (this.data.saving || this.data.loading || this.data.saved) return;
    const form = this.data.form;
    if (!form.supplierId || !form.expectedAt) return this.$toast('请选择供应商与预计到货日期');
    const validMoney = v => /^\d+(\.\d{1,2})?$/.test(String(v));
    if (form.freight && !validMoney(form.freight)) return this.$toast('运费须为非负金额，最多两位小数');
    if (this.data.lines.some(l => !l.modelId || !/^\d+$/.test(String(l.quantity)) || Number(l.quantity) < 1 || Number(l.quantity) > 1000 || !validMoney(l.unitCost))) return this.$toast('请逐行填写型号、1～1000 台数量和有效单价');
    const payload = { ...form, freight: form.freight || '0', lines: this.data.lines.map(l => ({ modelId: l.modelId, quantity: Number(l.quantity), unitCost: l.unitCost, attributes: { ...l.attributes } })) };
    this.setData({ saving: true, error: '' });
    try {
      const saved = this.data.id ? await api.purchase.update(this.data.id, payload) : await api.purchase.create(payload);
      this.setData({ saved }); events.emit('purchase:changed', { id: saved.id }); this.$toast('采购单已保存');
    } catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ saving: false }); }
  },
  onOpenSaved() { if (this.data.saved) this.$go(ROUTES.PURCHASE_DETAIL, { id: this.data.saved.id }); }
});

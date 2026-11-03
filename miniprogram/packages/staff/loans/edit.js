const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');
const { isPhone, isImei } = require('../../../utils/validate');
const { upload } = require('../../../utils/request');
const { scan, unitCode } = require('../../../utils/scan');
const events = require('../../../utils/events');
let sequence = 0;
const blankDevice = () => ({ key: 'd' + Date.now() + '_' + ++sequence, model: null, imei1: '', imei2: '', condition: '', description: '' });

/**
 * 新建借还单：出借 = 本店在库自有设备 → 出借中（不计销售）；借入 = 外部货权登记为借入在库，不可售。
 * 首期不收押金、逾期费和损坏赔偿（框架文档 十三.3）。提交结果未知时锁定原内容，用同一 requestKey 重试防重复。
 */
createPage({
  requireStaff: true,
  permission: PERM.LOAN_MANAGE,
  data: {
    form: { type: 'loan_out', counterparty: '', phone: '', dueAt: '', reason: '', remark: '', photos: [] },
    units: [], devices: [blankDevice()], code: '', today: '',
    loading: false, uploading: false, saving: false, pending: null, result: null, error: ''
  },

  onLoad(query = {}) {
    this.setData({ today: new Date(Date.now() + 28800000).toISOString().slice(0, 10), 'form.type': query.type === 'borrow_in' ? 'borrow_in' : 'loan_out' });
    this.offUnits = events.on('loan:units-selected', (ids) => { if (this.picking) { this.picking = false; this.addUnits(ids); } });
    this.offModel = events.on('loan:model-selected', (model) => {
      const index = this.modelRow;
      if (index === undefined || !this.data.devices[index]) return;
      this.modelRow = undefined;
      this.setData({ [`devices[${index}].model`]: { id: model.id, name: model.name } });
    });
  },
  onUnload() { this.destroyed = true; if (this.offUnits) this.offUnits(); if (this.offModel) this.offModel(); },
  locked() { return this.data.loading || this.data.uploading || this.data.saving || !!this.data.pending || !!this.data.result; },

  onType(e) { if (!this.locked()) this.setData({ 'form.type': e.currentTarget.dataset.type, error: '' }); },
  onInput(e) { if (!this.locked()) this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }); },
  onCode(e) { if (!this.locked()) this.setData({ code: e.detail.value }); },

  /** 出借：从库存多选，或扫码 / 输入设备编号、完整 IMEI */
  onPickUnits() { if (this.locked()) return; this.picking = true; this.$go(ROUTES.INVENTORY, { pick: 'loan' }); },
  async onScanUnit() { if (this.locked()) return; try { this.setData({ code: unitCode(await scan()) }); return this.onAddCode(); } catch (_) {} },
  async onAddCode() {
    const code = this.data.code.trim();
    if (this.locked() || !code) return code ? undefined : this.$toast('请扫码或输入设备编号 / 完整 IMEI');
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.inventory.list({ keyword: code, status: 'in_stock', page: 1, pageSize: 2 });
      if (res.list.length !== 1) throw new Error('未找到唯一的在库可售设备，请核对编号');
      this.setData({ code: '' });
      this.merge([res.list[0]], []);
    } catch (e) { this.setData({ error: e.message }); }
    finally { if (!this.destroyed) this.setData({ loading: false }); }
  },
  async addUnits(ids) {
    if (this.locked() || !ids || !ids.length) return;
    this.setData({ loading: true, error: '' });
    const found = [], failed = [];
    for (const id of ids) {
      try { found.push(await api.inventory.detail(id)); } catch (e) { failed.push(id + '：' + e.message); }
    }
    if (this.destroyed) return;
    this.setData({ loading: false });
    this.merge(found, failed);
  },
  merge(found, failed) {
    const units = this.data.units.slice(), errors = failed.slice();
    for (const u of found) {
      if (u.status !== 'in_stock' || u.ownership === 'borrowed') { errors.push(u.name + '：仅在库自有设备可出借'); continue; }
      if (!units.some((x) => x.id === u.id)) units.push({ id: u.id, name: u.name, storage: u.storage, color: u.color, imeiMasked: u.imeiMasked });
    }
    if (units.length > 50) { errors.push('每单最多 50 台'); units.length = 50; }
    this.setData({ units, error: errors.join('；') });
  },
  onRemoveUnit(e) { if (!this.locked()) this.setData({ units: this.data.units.filter((u) => u.id !== e.currentTarget.dataset.id) }); },

  /** 借入：逐台登记外部设备（型号必须来自型号库，IMEI1 必填） */
  onAddDevice() { if (!this.locked() && this.data.devices.length < 50) this.setData({ devices: this.data.devices.concat(blankDevice()) }); },
  onRemoveDevice(e) { if (!this.locked() && this.data.devices.length > 1) this.setData({ devices: this.data.devices.filter((d, i) => i !== Number(e.currentTarget.dataset.index)) }); },
  onDeviceInput(e) { if (!this.locked()) { const { index, field } = e.currentTarget.dataset; this.setData({ [`devices[${index}].${field}`]: e.detail.value }); } },
  onChooseModel(e) { if (this.locked()) return; this.modelRow = Number(e.currentTarget.dataset.index); this.$go(ROUTES.TEMPLATES, { select: '1', from: 'loan' }); },
  async onScanImei(e) {
    if (this.locked()) return;
    const index = Number(e.currentTarget.dataset.index);
    try { this.setData({ [`devices[${index}].imei1`]: unitCode(await scan()) }); } catch (_) {}
  },

  async onPhotos() {
    if (this.locked() || this.data.form.photos.length >= 9) return;
    this.setData({ uploading: true, error: '' });
    try {
      const res = await wx.chooseMedia({ count: 9 - this.data.form.photos.length, mediaType: ['image'], sizeType: ['compressed'] });
      const files = await Promise.all(res.tempFiles.map((f) => upload({ filePath: f.tempFilePath, scope: 'internal', bizType: 'loan_handover' })));
      if (!this.destroyed) this.setData({ 'form.photos': this.data.form.photos.concat(files) });
    } catch (e) { if (!/cancel/.test(e.errMsg || '')) this.setData({ error: e.message || e.errMsg || '照片未完成上传' }); }
    finally { if (!this.destroyed) this.setData({ uploading: false }); }
  },
  onRemovePhoto(e) { if (!this.locked()) this.setData({ 'form.photos': this.data.form.photos.filter((p, i) => i !== Number(e.currentTarget.dataset.index)) }); },

  check() {
    const f = this.data.form;
    if (!f.counterparty.trim()) return '请填写对方（同行 / 门店）';
    if (!isPhone(f.phone.trim())) return '请填写 11 位联系电话';
    if (!f.dueAt) return '请选择应归还日期';
    if (!f.reason.trim()) return '请填写交接说明';
    if (f.type === 'loan_out') return this.data.units.length ? '' : '请选择要出借的设备';
    const seen = new Set();
    for (const [i, d] of this.data.devices.entries()) {
      if (!d.model) return `第 ${i + 1} 台请选择型号`;
      if (!isImei(d.imei1.trim())) return `第 ${i + 1} 台 IMEI1 须为 15 位有效串码`;
      if (d.imei2.trim() && !isImei(d.imei2.trim())) return `第 ${i + 1} 台 IMEI2 无效`;
      for (const code of [d.imei1.trim(), d.imei2.trim()].filter(Boolean)) { if (seen.has(code)) return `串码 ${code} 重复`; seen.add(code); }
    }
    return '';
  },
  onSubmit() {
    if (this.locked()) return;
    const error = this.check();
    if (error) return this.$toast(error);
    const f = this.data.form;
    const body = {
      requestKey: 'loan_' + Date.now() + '_' + ++sequence + '_' + Math.random().toString(36).slice(2),
      type: f.type, counterparty: f.counterparty.trim(), phone: f.phone.trim(), dueAt: f.dueAt, reason: f.reason.trim(),
      ...(f.remark.trim() ? { remark: f.remark.trim() } : {}),
      photos: f.photos.map((p) => ({ fileId: p.fileId })),
      ...(f.type === 'loan_out'
        ? { unitIds: this.data.units.map((u) => u.id) }
        : { devices: this.data.devices.map((d) => ({ modelId: d.model.id, imei1: d.imei1.trim(), ...(d.imei2.trim() ? { imei2: d.imei2.trim() } : {}), ...(d.condition.trim() ? { condition: d.condition.trim() } : {}), ...(d.description.trim() ? { description: d.description.trim() } : {}) })) })
    };
    this.setData({ pending: body });
    return this.onRetry();
  },
  async onRetry() {
    if (this.data.saving || !this.data.pending) return;
    this.setData({ saving: true, error: '' });
    try {
      const result = await api.loan.create(this.data.pending);
      if (this.destroyed) return;
      this.setData({ result, pending: null });
      events.emit('inventory:changed', { loanId: result.id });
    } catch (e) {
      if (this.destroyed) return;
      if (Number(e.code) >= 400 && Number(e.code) < 500) this.setData({ pending: null });
      this.setData({ error: e.message });
    } finally { if (!this.destroyed) this.setData({ saving: false }); }
  },
  onDetail() { if (this.data.result) this.$go(ROUTES.LOAN_DETAIL, { id: this.data.result.id }); }
});

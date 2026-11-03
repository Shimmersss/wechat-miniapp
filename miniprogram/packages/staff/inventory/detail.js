const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');
const { UNIT_STATUS, UNIT_TRANSITIONS } = require('../../../constants/status');
const { can } = require('../../../utils/permission');
const { confirmSensitive } = require('../../../utils/confirm');
const { validateValues } = require('../../../utils/template');
const events = require('../../../utils/events');
createPage({
  requireStaff: true, permission: PERM.INVENTORY_VIEW,
  data: { id: '', detail: null, loading: false, error: '', mutating: false, album: 'public', priceEditor: null, priceConflict: false, recheckEditor: null, busy: 0,
    ledger: [], ledgerPage: 0, ledgerMore: true, ledgerLoading: false, ledgerError: '', canPrice: false, canShare: false, canLabel: false, canRecheck: false, canRepair: false,
    priceLabels: { retail: '零售价', wholesale: '批发价', agentBase: '代理底价' },
    docLabels: { inbound: '独立入库', acceptance: '采购验收', recheck: '库存复检' },
    todos: ['借还的状态操作入口（随对应业务单据接通）'] },
  onLoad(query) { this.setData({ id: query.id, statusMap: UNIT_STATUS }); return this.load(); },
  onShow() { if (this.loaded && !this.data.mutating && !this.data.priceEditor && !this.data.recheckEditor) this.load(); },
  onUnload() { this.destroyed = true; },
  onPullDownRefresh() {
    if (this.data.priceEditor || this.data.recheckEditor || this.data.mutating) { this.$toast('请先保存或关闭当前编辑'); wx.stopPullDownRefresh(); return; }
    this.load().finally(() => wx.stopPullDownRefresh());
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const detail = await api.inventory.detail(this.data.id);
      if (this.destroyed) return;
      this.setData({ detail, canPrice: can(this.data.user, PERM.PRICE_EDIT), canShare: can(this.data.user, PERM.SHARE), canLabel: can(this.data.user, PERM.LABEL_PRINT),
        canRepair: can(this.data.user, PERM.REPAIR_HANDLE) && detail.status === 'in_stock' && detail.ownership !== 'borrowed',
        canSell: can(this.data.user, PERM.SALES_CREATE) && (UNIT_TRANSITIONS[detail.status] || {}).sold === 'sales_order' && detail.ownership !== 'borrowed',
        canRecheck: can(this.data.user, PERM.ACCEPTANCE) && (detail.availableActions || []).includes('recheck') });
      this.loaded = true; await this.loadLedger(true);
    } catch (e) { if (!this.destroyed) this.setData({ error: e.message }); }
    finally { if (!this.destroyed) this.setData({ loading: false }); }
  },
  async loadLedger(reset) {
    if (this.data.ledgerLoading) return;
    const page = reset ? 1 : this.data.ledgerPage + 1;
    this.setData({ ledgerLoading: true, ledgerError: '' });
    try {
      const res = await api.inventory.ledger(this.data.id, { page, pageSize: 20 });
      if (this.destroyed) return;
      const ledger = reset ? res.list : this.data.ledger.concat(res.list);
      this.setData({ ledger, ledgerPage: page, ledgerMore: ledger.length < res.total });
    } catch (e) { if (!this.destroyed) this.setData({ ledgerError: e.message }); }
    finally { if (!this.destroyed) this.setData({ ledgerLoading: false }); }
  },
  onMoreLedger() { return this.loadLedger(false); },
  onRetryLedger() { return this.loadLedger(true); },
  onAlbum(e) { this.setData({ album: e.currentTarget.dataset.value }); },
  async onPreview(e) {
    const { file, url } = e.currentTarget.dataset;
    try { const current = file ? (await api.file.detail(file)).url : url; if (current) wx.previewImage({ current, urls: [current] }); }
    catch (error) { this.$toast(error.message); }
  },
  onLabel() { if (this.data.canLabel) this.$go(ROUTES.INVENTORY_LABEL, { id: this.data.id }); },
  onRepair() { if(this.data.canRepair&&!this.data.mutating)this.$go(ROUTES.REPAIR_EDIT,{unitId:this.data.id}); },
  onSell() { if (this.data.canSell && !this.data.mutating) this.$go(ROUTES.POS, { unitId: this.data.id }); },
  onShare() { if (this.data.canShare && this.data.detail.status === 'in_stock') this.$go(ROUTES.SHARE, { unitId: this.data.id }); },
  onEditPrice() {
    if (this.data.mutating || this.data.recheckEditor || !this.data.canPrice || this.data.detail.status !== 'in_stock') return;
    const values = {}, keys = ['retail', 'wholesale', 'agentBase'].filter(key => this.data.detail[key] !== undefined);
    keys.forEach(key => { values[key] = String(this.data.detail[key]); });
    this.setData({ priceEditor: { values, keys, priceVersion: this.data.detail.priceVersion }, priceConflict: false });
  },
  onPriceInput(e) { if (!this.data.mutating && !this.data.priceConflict) this.setData({ ['priceEditor.values.' + e.currentTarget.dataset.field]: e.detail.value }); },
  onClosePrice() { if (!this.data.mutating) this.setData({ priceEditor: null, priceConflict: false }); },
  async onSavePrice() {
    if (this.data.mutating || !this.data.priceEditor || this.data.priceConflict) return;
    const draft = this.data.priceEditor;
    if (draft.keys.some(key => !/^\d+(\.\d{1,2})?$/.test(String(draft.values[key])))) return this.$toast('价格须为非负金额，最多两位小数');
    const changed = draft.keys.filter(key => Number(draft.values[key]) !== Number(this.data.detail[key]));
    if (!changed.length) return this.$toast('价格未修改');
    const prices = Object.fromEntries(changed.map(key => [key, draft.values[key]]));
    this.setData({ mutating: true });
    try {
      const confirm = await confirmSensitive({ title: '确认修改单机价格', content: '填写改价原因，将记录原价与新价', needReason: true });
      if (!confirm.confirmed) return;
      const detail = await api.inventory.updatePrice(this.data.id, { ...prices, priceVersion: draft.priceVersion, reason: confirm.reason });
      this.setData({ detail, priceEditor: null, priceConflict: false }); events.emit('inventory:changed', { id: detail.id });
    } catch (e) { if (Number(e.code) === 409) this.setData({ priceConflict: true }); this.$toast(e.message); }
    finally { this.setData({ mutating: false }); }
  },
  async onRefreshPrice() { this.onClosePrice(); return this.load(); },
  async onFlag(e) {
    if (this.data.mutating || !this.data.canShare) return;
    const field = e.currentTarget.dataset.field, previous = { ...this.data.detail.flags };
    this.setData({ mutating: true });
    try {
      const flags = await api.inventory.updateShareFlags(this.data.id, { [field]: e.detail.value });
      this.setData({ 'detail.flags': flags }); events.emit('inventory:changed', { id: this.data.id });
    } catch (error) { this.setData({ 'detail.flags': previous }); this.$toast(error.message); }
    finally { this.setData({ mutating: false }); }
  },
  async onOpenRecheck() {
    if (this.data.mutating || !this.data.canRecheck || this.data.priceEditor) return;
    this.setData({ mutating: true });
    try { const form = await api.inventory.recheckForm(this.data.id); this.setData({ recheckEditor: { ...form, dirty: [], result: '', conflict: false } }); }
    catch (e) { this.$toast(e.message); } finally { this.setData({ mutating: false }); }
  },
  onRecheckResult(e) { if (!this.data.mutating && !this.data.busy) this.setData({ 'recheckEditor.result': e.currentTarget.dataset.value }); },
  onRecheckField(e) {
    if (this.data.mutating || !this.data.recheckEditor) return;
    const dirty = [...new Set(this.data.recheckEditor.dirty.concat(e.detail.key))];
    this.setData({ ['recheckEditor.values.' + e.detail.key]: e.detail.value, 'recheckEditor.dirty': dirty });
  },
  onFieldBusy(e) { this.setData({ busy: Math.max(0, this.data.busy + (e.detail.busy ? 1 : -1)) }); },
  onCloseRecheck() { if (!this.data.mutating && !this.data.busy) this.setData({ recheckEditor: null }); },
  async onSaveRecheck() {
    const editor = this.data.recheckEditor;
    if (this.data.mutating || this.data.busy || !editor || editor.conflict) return;
    if (!['pass', 'fail'].includes(editor.result)) return this.$toast('请选择复检结论');
    const error = validateValues(editor.fields.filter(f => editor.dirty.includes(f.key)), editor.values);
    if (error) return this.$toast(error);
    if (editor.result === 'pass' && editor.values.refurbishment === '正在整备') return this.$toast('请先确认整备完成');
    const attributes = Object.fromEntries(editor.dirty.map(key => [key, editor.values[key]]));
    this.setData({ mutating: true });
    try {
      const confirmation = await confirmSensitive({ title: editor.result === 'pass' ? '确认复检通过' : '登记复检未通过', content: '填写复检说明，将保留检查记录与库存流水', needReason: true });
      if (!confirmation.confirmed) return;
      const detail = await api.inventory.recheck(this.data.id, { result: editor.result, attributes, inspectionVersion: editor.inspectionVersion, reason: confirmation.reason });
      this.setData({ detail, recheckEditor: null, canRecheck: can(this.data.user, PERM.ACCEPTANCE) && detail.status === 'recheck' });
      await this.loadLedger(true); events.emit('inventory:changed', { id: detail.id });
    } catch (e) { if (Number(e.code) === 409) this.setData({ 'recheckEditor.conflict': true }); this.$toast(e.message); }
    finally { this.setData({ mutating: false }); }
  }
});

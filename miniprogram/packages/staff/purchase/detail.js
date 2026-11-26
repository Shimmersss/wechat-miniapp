const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');
const { PURCHASE_STATUS, CARRIERS } = require('../../../constants/status');
const { can } = require('../../../utils/permission');
const { scan } = require('../../../utils/scan');
const { confirmSensitive } = require('../../../utils/confirm');
const events = require('../../../utils/events');
createPage({
  requireStaff: true, permission: [PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE],
  data: { id: '', detail: null, loading: false, error: '', saving: false, canManage: false, canAccept: false, canRemove: false,
    carriers: CARRIERS, carrierIndex: 0, shipmentEditor: null,
    resolutions: { none: '待处理', dispute: '争议中', returned: '已退货', reinspected: '复验已入库' }
  },
  onLoad(query) { this.setData({ id: query.id, statusMap: PURCHASE_STATUS, canManage: can(this.data.user, PERM.PURCHASE_MANAGE), canAccept: can(this.data.user, PERM.ACCEPTANCE) }); return this.load(); },
  onShow() { if (this.loaded && !this.data.saving) this.load(); },
  onUnload() { this.destroyed = true; },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const detail = await api.purchase.detail(this.data.id);
      if (this.destroyed) return;
      this.setData({ detail, canRemove: this.data.user?.role === 'boss' && !!detail.canVoid });
      this.loaded = true;
    }
    catch (e) { if (!this.destroyed) this.setData({ error: e.message }); }
    finally { if (!this.destroyed) this.setData({ loading: false }); }
  },
  onEdit() { this.$go(ROUTES.PURCHASE_EDIT, { id: this.data.id }); },
  onAddShipment() { if (!this.data.saving && this.data.canManage) this.setData({ shipmentEditor: { carrier: CARRIERS[0].value, trackingNo: '' }, carrierIndex: 0 }); },
  onShipmentInput(e) { if (!this.data.saving) this.setData({ 'shipmentEditor.trackingNo': e.detail.value.trim() }); },
  onCarrier(e) { if (!this.data.saving) { const index = Number(e.detail.value); this.setData({ carrierIndex: index, 'shipmentEditor.carrier': CARRIERS[index].value }); } },
  onCloseShipment() { if (!this.data.saving) this.setData({ shipmentEditor: null }); },
  async onScanShipment() {
    if (this.data.saving) return;
    try { const trackingNo = await scan({ scanType: ['barCode', 'qrCode'] }); this.setData({ 'shipmentEditor.trackingNo': trackingNo }); } catch (_) {}
  },
  async onSaveShipment() {
    if (this.data.saving || !this.data.shipmentEditor) return;
    if (!/^[A-Za-z0-9]{8,40}$/.test(this.data.shipmentEditor.trackingNo)) return this.$toast('运单号需为 8～40 位字母或数字');
    this.setData({ saving: true });
    try { await api.purchase.addShipment(this.data.id, { ...this.data.shipmentEditor }); this.setData({ shipmentEditor: null }); await this.load(); events.emit('purchase:changed', { id: this.data.id }); }
    catch (e) { this.$toast(e.message); } finally { this.setData({ saving: false }); }
  },
  async onReceive(e) {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      const confirmation = await confirmSensitive({ title: '登记实际签收', content: '确认已收到该运单，填写签收说明', needReason: true });
      if (!confirmation.confirmed) return;
      await api.purchase.receiveShipment(e.currentTarget.dataset.id, { reason: confirmation.reason }); await this.load();
    } catch (error) { this.$toast(error.message); } finally { this.setData({ saving: false }); }
  },
  onAccept() { if (this.data.canAccept) this.$go(ROUTES.ACCEPTANCE, { poId: this.data.id }); },
  onReinspect(e) { if (this.data.canAccept && !this.data.saving) this.$go(ROUTES.ACCEPTANCE, { poId: this.data.id, exceptionId: e.currentTarget.dataset.id }); },
  async onResolve(e) {
    if (this.data.saving || !this.data.canAccept) return;
    const { id, action } = e.currentTarget.dataset;
    this.setData({ saving: true });
    try {
      const confirmation = await confirmSensitive({ title: action === 'return' ? '登记异常设备退货' : '登记验收争议', content: '填写处理原因，将保留验收记录', needReason: true });
      if (!confirmation.confirmed) return;
      await api.purchase.resolveAcceptance(id, { action, reason: confirmation.reason }); await this.load();
    } catch (error) { this.$toast(error.message); } finally { this.setData({ saving: false }); }
  },
  async onRemove() {
    const { id, detail, canRemove, loading, saving, shipmentEditor } = this.data;
    if (!canRemove || this.data.user?.role !== 'boss' || loading || saving || shipmentEditor) return;
    this.setData({ saving: true });
    try {
      const hasReceived = (detail.lines || []).some(l => l.received > 0);
      const confirmation = await confirmSensitive({
        title: '确认删除采购单',
        content: (detail.no || '这张采购单') + (hasReceived ? '将从采购列表移除。已入库设备会继续保留在库存中，审计记录会保留。' : '将从采购列表移除，已绑定运单和未入库异常串码占用会释放，审计记录会保留。'),
        needReason: true,
        confirmText: '删除'
      });
      if (!confirmation.confirmed || this.destroyed) return;
      await api.purchase.remove(id, { reason: confirmation.reason });
      events.emit('purchase:changed', { id });
      events.emit('inventory:changed', { purchaseId: id });
      if (this.destroyed) return;
      this.setData({ detail: null, canRemove: false });
      this.$toast('采购单已删除', 'success');
      wx.navigateBack({ fail: () => wx.redirectTo({ url: ROUTES.PURCHASE_LIST }) });
    } catch (error) {
      if (!this.destroyed && [404, 409].includes(Number(error.code))) await this.load();
    } finally {
      if (!this.destroyed) this.setData({ saving: false });
    }
  }
});

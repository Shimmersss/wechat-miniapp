const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');
const { LOAN_STATUS, LOAN_TYPE } = require('../../../constants/status');
const { upload } = require('../../../utils/request');
const { confirmSensitive } = require('../../../utils/confirm');
const events = require('../../../utils/events');
const { date } = require('../../../utils/format');
let sequence = 0;
const key = (kind) => 'loan_' + kind + '_' + Date.now() + '_' + ++sequence + '_' + Math.random().toString(36).slice(2);
const ITEM_STATUS = { active: '未归还', returned_recheck: '已归还 · 待复检', closed: '已完结' };
const ACTIONS = { create: '建单交接', return: '登记归还', recheck: '复检后完结' };

/**
 * 借还单详情：逐台登记归还（外观功能结论 + 内部交接照片），
 * 出借设备归还后进入库存待复检，须在库存页实际复检通过后再逐台完结；借入设备归还即冲销。
 * 所有操作带当前版本与稳定 requestKey，结果未知时锁定原内容重试。
 */
createPage({
  requireStaff: true,
  permission: PERM.LOAN_MANAGE,
  data: { id: '', detail: null, loading: false, error: '', editor: null, saving: false, uploading: false, pending: null },

  onLoad(query = {}) {
    this.setData({ id: query.id || '', statusMap: LOAN_STATUS, typeMap: LOAN_TYPE });
    return this.load();
  },
  onShow() { if (this.loaded && !this.data.editor && !this.data.pending) this.load(); },
  onUnload() { this.destroyed = true; },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  locked() { return this.data.saving || this.data.uploading || !!this.data.pending; },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const detail = await api.loan.detail(this.data.id);
      if (this.destroyed) return;
      // 同上：缺少 id 时返回 null，先挡一道再解引用。
      if (!detail) throw new Error("借还单不存在或已被删除");
      const photos = detail.photos || [];
      detail.items = detail.items.map((i) => ({ ...i, statusText: ITEM_STATUS[i.status] || i.status }));
      detail.timeline = (detail.timeline || []).slice().reverse().map((e) => ({
        ...e,
        actionText: ACTIONS[e.action] || e.action,
        timeText: e.time ? date(new Date(e.time)) : "",
        returned: e.action === 'return' && e.data && e.data.items ? e.data.items.map((r) => ({ ...r, name: (detail.items.find((i) => i.unitId === r.unitId) || {}).name || r.unitId })) : [],
        photos: photos.filter((p) => p.eventId === e.id)
      }));
      detail.openCount = detail.items.filter((i) => i.status === 'active').length;
      this.setData({ detail });
      this.loaded = true;
    } catch (e) { if (!this.destroyed) this.setData({ error: e.message }); }
    finally { if (!this.destroyed) this.setData({ loading: false }); }
  },

  /** 登记归还：可只勾选部分设备；每台须填外观功能结论并附至少 1 张内部交接照片 */
  onOpenReturn() {
    if (this.locked() || !this.data.detail) return;
    const open = this.data.detail.items.filter((i) => i.status === 'active');
    this.setData({ editor: { reason: '', items: open.map((i) => ({ unitId: i.unitId, name: i.name, imeiMasked: i.imeiMasked, selected: open.length === 1, condition: '', damage: '', photos: [] })) } });
  },
  onCloseReturn() { if (!this.locked()) this.setData({ editor: null }); },
  onToggleReturn(e) { if (!this.locked()) { const i = Number(e.currentTarget.dataset.index); this.setData({ [`editor.items[${i}].selected`]: !this.data.editor.items[i].selected }); } },
  onReturnInput(e) { if (!this.locked()) { const { index, field } = e.currentTarget.dataset; this.setData({ [`editor.items[${index}].${field}`]: e.detail.value }); } },
  onReturnReason(e) { if (!this.locked()) this.setData({ 'editor.reason': e.detail.value }); },
  async onReturnPhotos(e) {
    const index = Number(e.currentTarget.dataset.index), item = this.data.editor && this.data.editor.items[index];
    if (this.locked() || !item || item.photos.length >= 9) return;
    this.setData({ uploading: true, error: '' });
    try {
      const res = await wx.chooseMedia({ count: 9 - item.photos.length, mediaType: ['image'], sizeType: ['compressed'] });
      const files = await Promise.all(res.tempFiles.map((f) => upload({ filePath: f.tempFilePath, scope: 'internal', bizType: 'loan_return' })));
      if (!this.destroyed && this.data.editor) this.setData({ [`editor.items[${index}].photos`]: this.data.editor.items[index].photos.concat(files) });
    } catch (err) { if (!/cancel/.test(err.errMsg || '')) this.setData({ error: err.message || err.errMsg || '照片未完成上传' }); }
    finally { if (!this.destroyed) this.setData({ uploading: false }); }
  },
  onRemoveReturnPhoto(e) {
    if (this.locked()) return;
    const { index, photo } = e.currentTarget.dataset;
    this.setData({ [`editor.items[${index}].photos`]: this.data.editor.items[index].photos.filter((p, i) => i !== Number(photo)) });
  },
  onSubmitReturn() {
    if (this.locked() || !this.data.editor) return;
    const chosen = this.data.editor.items.filter((i) => i.selected);
    if (!chosen.length) return this.$toast('请勾选本次归还的设备');
    const missing = chosen.find((i) => !i.condition.trim() || !i.photos.length);
    if (missing) return this.$toast(`${missing.name}：请填写外观功能结论并上传交接照片`);
    if (!this.data.editor.reason.trim()) return this.$toast('请填写处理说明');
    const body = {
      requestKey: key('return'), version: this.data.detail.version, reason: this.data.editor.reason.trim(),
      items: chosen.map((i) => ({ unitId: i.unitId, condition: i.condition.trim(), ...(i.damage.trim() ? { damage: i.damage.trim() } : {}), photos: i.photos.map((p) => ({ fileId: p.fileId })) }))
    };
    this.setData({ pending: { kind: 'return', body } });
    return this.onRetry();
  },

  /** 出借设备：先到库存页按入库模板逐项复检，复检通过后回到此处完结该台 */
  onGoRecheck(e) { this.$go(ROUTES.INVENTORY_DETAIL, { id: e.currentTarget.dataset.id }); },
  async onCloseItem(e) {
    if (this.locked()) return;
    const unitId = e.currentTarget.dataset.id;
    const { confirmed, reason } = await confirmSensitive({ title: '完结这台设备', content: '确认已在库存页实际复检通过，填写说明', needReason: true });
    if (!confirmed) return;
    this.setData({ pending: { kind: 'recheck', body: { requestKey: key('recheck'), version: this.data.detail.version, reason, unitIds: [unitId] } } });
    return this.onRetry();
  },

  async onRetry() {
    const pending = this.data.pending;
    if (this.data.saving || !pending) return;
    this.setData({ saving: true, error: '' });
    try {
      await (pending.kind === 'return' ? api.loan.markReturned(this.data.id, pending.body) : api.loan.recheck(this.data.id, pending.body));
      if (this.destroyed) return;
      this.setData({ pending: null, editor: null });
      this.$toast(pending.kind === 'return' ? '已登记归还' : '已完结');
      events.emit('inventory:changed', { loanId: this.data.id });
      await this.load();
    } catch (e) {
      if (this.destroyed) return;
      const code = Number(e.code);
      if (code >= 400 && code < 500) { this.setData({ pending: null }); if (code === 409) await this.load(); if (!this.destroyed) this.setData({ error: e.message }); }
      else this.setData({ error: e.message });
    } finally { if (!this.destroyed) this.setData({ saving: false }); }
  },
  onPreview(e) { wx.previewImage({ urls: [e.currentTarget.dataset.url], current: e.currentTarget.dataset.url }); }
});

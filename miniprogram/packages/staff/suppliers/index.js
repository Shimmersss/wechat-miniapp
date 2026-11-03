const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');
const { can } = require('../../../utils/permission');
const events = require('../../../utils/events');
createPage({
  requireStaff: true, permission: PERM.SUPPLIER_VIEW,
  data: { list: [], page: 1, hasMore: true, loading: false, error: '', keyword: '', selecting: false, canManage: false, editor: null, saving: false },
  onLoad(query) {
    this.setData({ selecting: query.select === '1', canManage: can(this.data.user, PERM.PURCHASE_MANAGE) });
    return this.load(true);
  },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },
  load(reset) {
    const revision = this.revision = (this.revision || 0) + 1;
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '' });
    return api.supplier.list({ keyword: this.data.keyword.trim(), active: this.data.selecting ? true : undefined, page, pageSize: 20 })
      .then(res => { if (revision !== this.revision) return; const list = reset ? res.list : this.data.list.concat(res.list); this.setData({ list, page, hasMore: list.length < res.total }); })
      .catch(e => { if (revision === this.revision) this.setData({ error: e.message }); })
      .finally(() => { if (revision === this.revision) this.setData({ loading: false }); });
  },
  onKeyword(e) { this.setData({ keyword: e.detail.value }); },
  onSearch() { return this.load(true); },
  onSelect(e) {
    const supplier = this.data.list.find(s => s.id === e.currentTarget.dataset.id);
    if (!this.data.selecting || !supplier || !supplier.active) return;
    events.emit('purchase:supplier-selected', supplier); this.$back();
  },
  openEditor(editor) { this.setData({ editor }, () => wx.pageScrollTo({ selector: '#supplier-editor', duration: 200 })); },
  onAdd() { if (this.data.canManage) this.openEditor({ name: '', contact: '', phone: '', settle: '', note: '', active: true }); },
  onEdit(e) { const supplier = this.data.list.find(s => s.id === e.currentTarget.dataset.id); if (supplier && this.data.canManage) this.openEditor({ ...supplier }); },
  onEditorInput(e) { if (!this.data.saving) this.setData({ ['editor.' + e.currentTarget.dataset.field]: e.detail.value }); },
  onClose() { if (!this.data.saving) this.setData({ editor: null }); },
  async onSave() {
    if (this.data.saving || !this.data.editor) return;
    if (!this.data.editor.name.trim()) return this.$toast('请填写供应商名称');
    const payload = { ...this.data.editor };
    this.setData({ saving: true });
    try {
      if (payload.id) await api.supplier.update(payload.id, payload); else await api.supplier.create(payload);
      this.setData({ editor: null }); await this.load(true);
      if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 200 });
    } catch (e) { this.$toast(e.message); }
    finally { this.setData({ saving: false }); }
  },
  onOrders(e) { this.$go(ROUTES.PURCHASE_LIST, { supplierId: e.currentTarget.dataset.id }); }
});

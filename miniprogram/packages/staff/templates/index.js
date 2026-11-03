const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');
const { can } = require('../../../utils/permission');
const events = require('../../../utils/events');
createPage({
  requireStaff: true, permission: [PERM.TEMPLATE_MANAGE, PERM.INBOUND, PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE, PERM.INVENTORY_VIEW],
  data: { list: [], tree: [], filters: [], activeFilter: '', selecting: false, loading: false, error: '', categoryEditor: null, modelEditor: null, saving: false, baseTemplates: [], categoryIndex: 0, templateIndex: 0 },
  onLoad(query) {
    const selecting = query.select === '1';
    this.selectionEvent = { purchase: 'purchase:model-selected', inventory: 'inventory:model-selected', stocktake: 'stocktake:model-selected', loan: 'loan:model-selected' }[query.from] || 'inbound:model-selected';
    if (!selecting && !can(this.data.user, PERM.TEMPLATE_MANAGE)) { this.$toast('无模板管理权限'); return this.$back(); }
    this.setData({ selecting, activeFilter: query.category || '' }); this.load();
  },
  onShow() { if (this.loaded) this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  load() {
    const revision = this.revision = (this.revision || 0) + 1;
    this.setData({ loading: true, error: '' });
    return api.template.categories().then(result => {
      if (revision !== this.revision) return;
      const filters = result.list, activeFilter = filters.some(c => c.value === this.data.activeFilter) ? this.data.activeFilter : (filters[0] || {}).value;
      this.setData({ filters, activeFilter });
      return Promise.all([api.template.modelTree({ category: activeFilter }), this.data.selecting ? Promise.resolve({ list: [] }) : api.template.list({ page: 1, pageSize: 1000 })]);
    }).then(result => {
      if (!result || revision !== this.revision) return;
      const [tree, templates] = result;
      this.setData({ tree, baseTemplates: templates.list, list: templates.list.filter(t => t.category === this.data.activeFilter) }); this.loaded = true;
    }).catch(e => { if (revision === this.revision) this.setData({ error: e.message }); })
      .finally(() => { if (revision === this.revision) this.setData({ loading: false }); });
  },
  onRetry() { this.load(); },
  onFilterTap(e) { this.setData({ activeFilter: e.currentTarget.dataset.value, list: [], tree: [] }); this.load(); },
  onItemTap(e) { this.$go(ROUTES.TEMPLATE_EDIT, { id: e.currentTarget.dataset.id }); },
  models() { const models = []; this.data.tree.forEach(b => b.series.forEach(s => models.push(...s.models))); return models; },
  onSelectModel(e) {
    const model = this.models().find(m => m.id === e.currentTarget.dataset.id); if (!model) return;
    if (!this.data.selecting) return this.openModel(model);
    events.emit(this.selectionEvent, model); this.$back();
  },
  onAddCategory() { this.setData({ categoryEditor: { id: '', label: '' } }); },
  onRenameCategory() { const c = this.data.filters.find(c => c.value === this.data.activeFilter); if (c) this.setData({ categoryEditor: { id: c.value, label: c.label } }); },
  onCategoryInput(e) { this.setData({ 'categoryEditor.label': e.detail.value }); },
  onSaveCategory() {
    if (this.data.saving) return;
    const { id, label } = this.data.categoryEditor;
    if (!label.trim()) return this.$toast('请填写分类名称');
    this.setData({ saving: true });
    const request = id ? api.template.updateCategory(id, { label }) : api.template.createCategory({ label });
    request.then(c => { this.setData({ categoryEditor: null, activeFilter: c.value }); return this.load(); }).catch(e => this.$toast(e.message)).finally(() => this.setData({ saving: false }));
  },
  onAddModel() { this.openModel(); },
  openModel(model) {
    const category = model ? model.category : this.data.activeFilter;
    this.setData({ categoryIndex: Math.max(0, this.data.filters.findIndex(c => c.value === category)), templateIndex: 0,
      modelEditor: model ? { ...model, tacsText: (model.tacs || []).join('\n') } : { id: '', category, name: '', brandLabel: '', series: '', copyTemplateId: (this.data.baseTemplates[0] || {}).id, tacsText: '', tacSource: '' } });
  },
  onModelInput(e) { this.setData({ [`modelEditor.${e.currentTarget.dataset.field}`]: e.detail.value }); },
  onCategoryPick(e) { const index = Number(e.detail.value); this.setData({ categoryIndex: index, 'modelEditor.category': this.data.filters[index].value }); },
  onTemplatePick(e) { const index = Number(e.detail.value); this.setData({ templateIndex: index, 'modelEditor.copyTemplateId': this.data.baseTemplates[index].id }); },
  onSaveModel() {
    if (this.data.saving) return;
    const { tacsText, ...model } = this.data.modelEditor;
    const payload = { ...model, tacs: tacsText.split(/\s+/).map(t => t.trim()).filter(Boolean) };
    if (![model.name, model.brandLabel, model.series].every(v => v && v.trim())) return this.$toast('请填写品牌、系列和型号');
    this.setData({ saving: true });
    const request = model.id ? api.template.updateModel(model.id, payload) : api.template.createModel(payload);
    request.then(result => { this.setData({ modelEditor: null, activeFilter: result.category }); return this.load(); }).catch(e => this.$toast(e.message)).finally(() => this.setData({ saving: false }));
  },
  onCloseEditor() { if (!this.data.saving) this.setData({ categoryEditor: null, modelEditor: null }); }
});

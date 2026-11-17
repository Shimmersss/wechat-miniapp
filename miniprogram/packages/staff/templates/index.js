const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { PERM } = require('../../../constants/roles');
const { can } = require('../../../utils/permission');
const { confirmSensitive } = require('../../../utils/confirm');
const events = require('../../../utils/events');
const { supportsRam } = require('../../../utils/template');
const { IDENTIFIER_MODES } = require('../../../constants/status');
const { brandRank } = require('../../../constants/shop-brands');
const modeIndex = mode => Math.max(0, IDENTIFIER_MODES.findIndex(m => m.value === mode));
const lines = text => String(text || '').split('\n').map(v => v.trim()).filter(Boolean);
const specText = specs => specs ? [(specs.storage || []).join('/'), specs.ram?.length ? '运行内存 ' + specs.ram.join('/') : '', specs.color && specs.color.length ? specs.color.length + ' 种颜色' : ''].filter(Boolean).join(' · ') : '';
const NEW_BRAND = { brand: '', brandLabel: '手动填写新品牌' };
const NEW_SERIES = '手动填写新系列';
const sortBrands = brands => brands.slice().sort((a, b) =>
  brandRank(a.brand, a.brandLabel) - brandRank(b.brand, b.brandLabel) || b.count - a.count);
createPage({
  requireStaff: true, permission: [PERM.TEMPLATE_MANAGE, PERM.INBOUND, PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE, PERM.INVENTORY_VIEW],
  data: { tree: [], brands: [], activeBrand: '', keyword: '', searching: false, filters: [], activeFilter: '', categoryTemplate: null, selecting: false, loading: false, error: '', categoryEditor: null, modelEditor: null, saving: false, baseTemplates: [], categoryIndex: 0, brandOptions: [], seriesOptions: [], modelOptionsLoading: false, modelOptionsError: '' },
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
      return Promise.all([api.template.modelBrands({ category: activeFilter }), this.data.selecting ? Promise.resolve({ list: [] }) : api.template.list({ page: 1, pageSize: 1000 })]);
    }).then(result => {
      if (!result || revision !== this.revision) return;
      const [brandList, templates] = result, filters = this.data.filters;
      // 型号多时按品牌分批加载：品牌按首页入口顺序，其余按型号数
      const brands = sortBrands(brandList);
      const activeBrand = brands.some(b => b.brand === this.data.activeBrand) ? this.data.activeBrand : (brands[0] || {}).brand || '';
      const category = filters.find(c => c.value === this.data.activeFilter) || {};
      // 每个分类一套模板；旧数据遗留的型号独立模板只供快照追溯，不再列出
      const baseTemplates = filters.map(c => { const t = templates.list.find(x => x.id === c.templateId); return t ? { id: t.id, name: `${c.label} · ${t.name}` } : null; }).filter(Boolean);
      this.setData({ brands, activeBrand, baseTemplates, categoryTemplate: templates.list.find(t => t.id === category.templateId) || null }); this.loaded = true;
      return this.loadTree(revision);
    }).catch(e => { if (revision === this.revision) this.setData({ error: e.message }); })
      .finally(() => { if (revision === this.revision) this.setData({ loading: false }); });
  },
  /** 按当前品牌或搜索词加载型号树；搜索时跨品牌，最多 200 个 */
  loadTree(revision = this.revision) {
    const { activeFilter, activeBrand } = this.data, keyword = this.data.keyword.trim();
    if (!activeFilter || (!activeBrand && !keyword)) { this.setData({ tree: [] }); return Promise.resolve(); }
    const treeRevision = this.treeRevision = (this.treeRevision || 0) + 1;
    this.setData({ searching: true });
    return api.template.modelTree({ category: activeFilter, ...(keyword ? { keyword } : { brand: activeBrand }) }).then(tree => {
      if (revision !== this.revision || treeRevision !== this.treeRevision) return;
      this.setData({ tree: tree.map(b => ({ ...b, series: b.series.map(s => ({ ...s, models: s.models.map(m => ({ ...m, specText: specText(m.specs) })) })) })) });
    }).catch(e => { if (treeRevision === this.treeRevision) this.setData({ error: e.message }); })
      .finally(() => { if (treeRevision === this.treeRevision) this.setData({ searching: false }); });
  },
  onBrandTap(e) { this.setData({ activeBrand: e.currentTarget.dataset.brand, keyword: '', tree: [] }); this.loadTree(); },
  onKeywordInput(e) { this.setData({ keyword: e.detail.value }); clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.loadTree(), 400); },
  onClearKeyword() { this.setData({ keyword: '' }); this.loadTree(); },
  onUnload() { clearTimeout(this.searchTimer); this.bumpModelOptionsRevision(); },
  onRetry() { this.load(); },
  onFilterTap(e) { this.setData({ activeFilter: e.currentTarget.dataset.value, activeBrand: '', keyword: '', brands: [], categoryTemplate: null, tree: [] }); this.load(); },
  onTemplateTap() { if (this.data.categoryTemplate) this.$go(ROUTES.TEMPLATE_EDIT, { id: this.data.categoryTemplate.id }); },
  models() { const models = []; this.data.tree.forEach(b => b.series.forEach(s => models.push(...s.models))); return models; },
  onSelectModel(e) {
    const model = this.models().find(m => m.id === e.currentTarget.dataset.id); if (!model) return;
    if (!this.data.selecting) return this.openModel(model);
    events.emit(this.selectionEvent, model); this.$back();
  },
  // 新分类默认按序列号入库；分类下已有设备时服务端拒绝修改串码方式
  onAddCategory() { this.setData({ identifierModes: IDENTIFIER_MODES, categoryEditor: { id: '', label: '', baseIndex: 0, modeIndex: 1, locked: false } }); },
  onModePick(e) { if (!this.data.categoryEditor.locked) this.setData({ 'categoryEditor.modeIndex': Number(e.detail.value) }); },
  onBasePick(e) { this.setData({ 'categoryEditor.baseIndex': Number(e.detail.value) }); },
  onRenameCategory() { const c = this.data.filters.find(c => c.value === this.data.activeFilter); if (c) this.setData({ identifierModes: IDENTIFIER_MODES, categoryEditor: { id: c.value, label: c.label, modeIndex: modeIndex(c.identifierMode || 'imei'), locked: Number(c.unitCount) > 0 } }); },
  onCategoryInput(e) { this.setData({ 'categoryEditor.label': e.detail.value }); },
  onSaveCategory() {
    if (this.data.saving) return;
    const { id, label, baseIndex, modeIndex: mi } = this.data.categoryEditor, base = this.data.baseTemplates[baseIndex], identifierMode = IDENTIFIER_MODES[mi || 0].value;
    if (!label.trim()) return this.$toast('请填写分类名称');
    if (!id && !base) return this.$toast('请选择要复制的基础模板');
    this.setData({ saving: true });
    const request = id ? api.template.updateCategory(id, { label, identifierMode }) : api.template.createCategory({ label, copyTemplateId: base.id, identifierMode });
    return request.then(c => { this.setData({ categoryEditor: null, activeFilter: c.value }); return this.load(); }).catch(e => this.$toast(e.message)).finally(() => this.setData({ saving: false }));
  },
  onAddModel() { return this.openModel(); },
  openModel(model) {
    const category = model ? model.category : this.data.activeFilter;
    const currentBrand = model
      ? { brand: model.brand, brandLabel: model.brandLabel }
      : this.data.brands.find(b => b.brand === this.data.activeBrand);
    const specs = model?.specs || {};
    this.setData({
      categoryIndex: Math.max(0, this.data.filters.findIndex(c => c.value === category)),
      brandOptions: currentBrand ? [NEW_BRAND, currentBrand] : [NEW_BRAND],
      seriesOptions: [NEW_SERIES],
      modelEditor: {
        id: model?.id || '', category, name: model?.name || '', originalName: model?.name || '',
        brandId: currentBrand?.brand || '', brandLabel: currentBrand?.brandLabel || '', brandIndex: currentBrand ? 1 : 0,
        series: model?.series || '', seriesIndex: 0, tacSource: model?.tacSource || '',
        tacsText: (model?.tacs || []).join('\n'), ramSupported: supportsRam(category),
        ramText: (specs.ram || []).join('\n'), storageText: (specs.storage || []).join('\n'), colorText: (specs.color || []).join('\n')
      }
    });
    return this.loadModelOptions(true);
  },
  bumpModelOptionsRevision() {
    this.modelOptionsRevision = (this.modelOptionsRevision || 0) + 1;
    return this.modelOptionsRevision;
  },
  async loadModelOptions(includeBrands = false) {
    const revision = this.bumpModelOptionsRevision();
    const { category, brandId, series } = this.data.modelEditor;
    this.setData({ modelOptionsLoading: true, modelOptionsError: '' });
    try {
      const [brands, seriesNames] = await Promise.all([
        includeBrands ? api.template.modelBrands() : Promise.resolve(null),
        brandId ? api.template.modelSeries({ category, brand: brandId }) : Promise.resolve([])
      ]);
      if (revision !== this.modelOptionsRevision) return;
      const brandOptions = brands ? [NEW_BRAND, ...sortBrands(brands)] : this.data.brandOptions;
      const brandIndex = Math.max(0, brandOptions.findIndex(b => b.brand === brandId));
      const seriesOptions = [NEW_SERIES, ...seriesNames];
      this.setData({
        brandOptions, seriesOptions,
        'modelEditor.brandIndex': brandIndex,
        'modelEditor.brandId': brandOptions[brandIndex].brand,
        'modelEditor.brandLabel': brandIndex ? brandOptions[brandIndex].brandLabel : this.data.modelEditor.brandLabel,
        'modelEditor.seriesIndex': seriesNames.indexOf(series) + 1
      });
    } catch (e) {
      if (revision === this.modelOptionsRevision) this.setData({ modelOptionsError: e.message });
    } finally {
      if (revision === this.modelOptionsRevision) this.setData({ modelOptionsLoading: false });
    }
  },
  onReloadModelOptions() { return this.loadModelOptions(true); },
  onModelInput(e) { this.setData({ [`modelEditor.${e.currentTarget.dataset.field}`]: e.detail.value }); },
  onCategoryPick(e) {
    const index = Number(e.detail.value);
    const category = this.data.filters[index].value;
    if (category === this.data.modelEditor.category) return;
    this.setData({ categoryIndex: index, 'modelEditor.category': category, 'modelEditor.ramSupported': supportsRam(category) });
    return this.resetModelSeries();
  },
  onModelBrandPick(e) {
    const index = Number(e.detail.value);
    const brand = this.data.brandOptions[index];
    if (index === this.data.modelEditor.brandIndex) return;
    this.setData({ 'modelEditor.brandId': brand.brand, 'modelEditor.brandLabel': index ? brand.brandLabel : '', 'modelEditor.brandIndex': index });
    return this.resetModelSeries();
  },
  resetModelSeries() {
    this.setData({ seriesOptions: [NEW_SERIES], 'modelEditor.series': '', 'modelEditor.seriesIndex': 0 });
    return this.loadModelOptions();
  },
  onModelSeriesPick(e) {
    const index = Number(e.detail.value);
    if (index === this.data.modelEditor.seriesIndex) return;
    this.setData({ 'modelEditor.seriesIndex': index, 'modelEditor.series': index ? this.data.seriesOptions[index] : '' });
  },
  onSaveModel() {
    if (this.data.saving || this.data.modelOptionsLoading) return;
    const { id, category, name, brandId, brandLabel, series, tacSource, tacsText, storageText, colorText, ramText, ramSupported } = this.data.modelEditor;
    if (![name, brandLabel, series].every(v => v.trim())) return this.$toast('请填写品牌、系列和型号');
    const payload = {
      category, name, brandLabel, ...(brandId ? { brandId } : {}), series, tacSource,
      tacs: tacsText.split(/\s+/).map(t => t.trim()).filter(Boolean),
      specs: { storage: lines(storageText), color: lines(colorText), ...(ramSupported ? { ram: lines(ramText) } : {}) }
    };
    this.setData({ saving: true });
    const request = id ? api.template.updateModel(id, payload) : api.template.createModel(payload);
    return request.then(result => {
      clearTimeout(this.searchTimer);
      this.setData({ modelEditor: null, activeFilter: result.category, activeBrand: result.brand, keyword: '' });
      return this.load();
    }).catch(e => this.$toast(e.message)).finally(() => this.setData({ saving: false }));
  },
  async onDeleteModel() {
    const model = this.data.modelEditor;
    if (!model?.id || this.data.saving) return;
    this.setData({ saving: true });
    try {
      const { confirmed } = await confirmSensitive({
        title: '删除型号',
        content: `确定删除「${model.originalName}」及其 TAC 映射？如果它是该系列最后一个型号，系列也会移除。`,
        confirmText: '删除'
      });
      if (!confirmed) return;
      await api.template.deleteModel(model.id);
      this.bumpModelOptionsRevision();
      this.setData({ modelEditor: null });
      this.$toast('型号已删除');
      await this.load();
    } catch (e) { this.$toast(e.message); }
    finally { this.setData({ saving: false }); }
  },
  onCloseEditor() {
    if (this.data.saving) return;
    this.bumpModelOptionsRevision();
    this.setData({ categoryEditor: null, modelEditor: null });
  }
});

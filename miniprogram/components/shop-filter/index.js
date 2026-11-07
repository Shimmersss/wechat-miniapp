/**
 * 首页排序筛选栏：排序、型号选择、筛选抽屉，以及成色 / 价格 / 电池三个下拉面板。
 * 所有条件先改草稿，点确定才生效；确定按钮上的台数由服务端按草稿统计。
 *
 * 属性：value  当前生效的筛选条件（见 utils/shop-filter.js 的 EMPTY_FILTERS）
 * 事件：change  detail 为生效后的完整条件
 *       overlay detail { open, full }：面板开合；full 表示全屏层，页面要把筛选栏层级提到搜索框之上
 * 方法：close() 收起所有面板
 */
const api = require('../../api/index');
const { CONDITION_TYPE, GRADE_OPTIONS } = require('../../constants/status');
const { EMPTY_FILTERS, PRICE_RANGES, BATTERY_OPTIONS, toQuery, priceError, filterCount } = require('../../utils/shop-filter');

Component({
  properties: { value: { type: Object, value: EMPTY_FILTERS } },

  data: {
    open: '', // grade | price | battery | drawer
    modelOpen: false,
    draft: EMPTY_FILTERS,
    previewTotal: null,
    count: 0,
    gradeOptions: GRADE_OPTIONS,
    priceRanges: PRICE_RANGES,
    batteryOptions: BATTERY_OPTIONS,
    conditionOptions: [{ value: '', label: '全部' }].concat(CONDITION_TYPE),
    categories: [],
    categoryIndex: 0,
    brandIndex: 0,
    modelDraft: { id: '', name: '' }
  },

  observers: {
    value(v) { this.setData({ count: filterCount(v) }); }
  },

  methods: {
    close() {
      this.setData({ open: '', modelOpen: false });
      this.notifyOverlay();
    },

    notifyOverlay() {
      const { open, modelOpen } = this.data;
      this.triggerEvent('overlay', { open: !!open || modelOpen, full: open === 'drawer' || modelOpen });
    },

    openPanel(open) {
      this.setData({ open, draft: { ...this.data.value } });
      this.notifyOverlay();
      this.preview();
    },

    onPanel(e) {
      const { panel } = e.currentTarget.dataset;
      if (this.data.open === panel) return this.close();
      return this.openPanel(panel);
    },

    onSort(e) {
      const { sort } = e.currentTarget.dataset;
      const current = this.data.value.sort;
      const next = sort === 'price' ? (current === 'price_asc' ? 'price_desc' : 'price_asc') : '';
      if (next === current) return;
      this.close();
      this.triggerEvent('change', { ...this.data.value, sort: next });
    },

    /** 单选项：再点一次取消 */
    onPick(e) {
      const { field, value } = e.currentTarget.dataset;
      this.setData({ [`draft.${field}`]: this.data.draft[field] === value ? '' : value });
      this.preview();
    },

    onPriceInput(e) {
      this.setData({ [`draft.${e.currentTarget.dataset.field}`]: e.detail.value.trim() });
      this.preview();
    },

    onPriceRange(e) {
      const { min, max } = e.currentTarget.dataset;
      this.setData({ 'draft.priceMin': min, 'draft.priceMax': max });
      this.preview();
    },

    /** 按当前草稿统计台数；连续点选时只保留最后一次结果 */
    preview() {
      clearTimeout(this.previewTimer);
      this.previewTimer = setTimeout(async () => {
        const { draft } = this.data;
        const revision = this.revision = (this.revision || 0) + 1;
        if (priceError(draft.priceMin, draft.priceMax)) return this.setData({ previewTotal: null });
        try {
          const res = await api.shop.units({ ...toQuery(draft), page: 1, pageSize: 1 });
          if (revision === this.revision) this.setData({ previewTotal: res.total });
        } catch (e) {
          if (revision === this.revision) this.setData({ previewTotal: null });
        }
        return null;
      }, 200);
    },

    onReset() {
      const { open, value } = this.data;
      const keep = open === 'grade' ? { grade: '' } : open === 'price' ? { priceMin: '', priceMax: '' } : open === 'battery' ? { batteryMin: '' } : { modelId: '', modelName: '', condition: '', grade: '', batteryMin: '', priceMin: '', priceMax: '' };
      this.setData({ draft: { ...this.data.draft, ...keep, sort: value.sort, brand: value.brand } });
      this.preview();
    },

    onConfirm() {
      const { draft } = this.data;
      const error = priceError(draft.priceMin, draft.priceMax);
      if (error) return wx.showToast({ title: error, icon: 'none' });
      this.close();
      return this.triggerEvent('change', { ...draft });
    },

    // ---------- 选择型号 ----------

    async onOpenModel() {
      const fromDrawer = this.data.open === 'drawer';
      if (!fromDrawer) this.setData({ open: '', draft: { ...this.data.value } });
      this.setData({ modelOpen: true, modelDraft: { id: this.data.draft.modelId, name: this.data.draft.modelName } });
      this.fromDrawer = fromDrawer;
      this.notifyOverlay();
      try {
        const categories = await api.shop.categories();
        this.setData({ categories });
      } catch (e) {
        wx.showToast({ title: e.message || '型号加载失败', icon: 'none' });
      }
    },

    onCategory(e) { this.setData({ categoryIndex: e.currentTarget.dataset.index, brandIndex: 0 }); },
    onBrand(e) { this.setData({ brandIndex: e.currentTarget.dataset.index }); },

    onModel(e) {
      const { id, name } = e.currentTarget.dataset;
      if (!id) return wx.showToast({ title: '该型号暂无现货', icon: 'none' });
      const same = this.data.modelDraft.id === id;
      return this.setData({ modelDraft: same ? { id: '', name: '' } : { id, name } });
    },

    onCloseModel() {
      this.setData({ modelOpen: false });
      this.notifyOverlay();
    },

    onResetModel() { this.setData({ modelDraft: { id: '', name: '' } }); },

    /** 选型号后清掉品牌入口，避免两个条件互相矛盾 */
    onConfirmModel() {
      const { id, name } = this.data.modelDraft;
      const draft = { ...this.data.draft, modelId: id, modelName: name, brand: id ? '' : this.data.draft.brand };
      this.setData({ draft, modelOpen: false });
      this.notifyOverlay();
      if (this.fromDrawer) return this.preview();
      return this.triggerEvent('change', draft);
    },

    noop() {}
  }
});

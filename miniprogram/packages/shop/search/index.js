const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const config = require('../../../config/index');
const { ROUTES } = require('../../../utils/router');
const { CONDITION_TYPE, GRADE_OPTIONS } = require('../../../constants/status');

const HISTORY_KEY = config.storageKeys.searchHistory;
const HISTORY_MAX = 10;
const BATTERY_OPTIONS = [{ value: '', label: '不限' }, { value: '90', label: '90%以上' }, { value: '85', label: '85%以上' }, { value: '80', label: '80%以上' }];
const decode = (v) => { try { return decodeURIComponent(v || ''); } catch (e) { return v || ''; } };

function readHistory() {
  try { const list = wx.getStorageSync(HISTORY_KEY); return Array.isArray(list) ? list : []; } catch (e) { return []; }
}

/**
 * 搜索：按品牌/型号/内存/颜色搜索在售设备，只返回公开字段。
 * 成色/电池/价格筛选由服务端按当前渠道公开取值完成，前端只提交条件。
 */
createPage({
  data: {
    keyword: '',
    input: '',
    modelId: '',
    modelName: '',
    condition: '',
    grade: '',
    batteryMin: '',
    priceMin: '',
    priceMax: '',
    // 价格输入框草稿；点“确定”后才写入 priceMin/priceMax 参与查询
    priceMinDraft: '',
    priceMaxDraft: '',
    showFilter: false,
    filterCount: 0,
    history: [],
    conditionOptions: [{ value: '', label: '全部' }].concat(CONDITION_TYPE),
    gradeOptions: GRADE_OPTIONS,
    batteryOptions: BATTERY_OPTIONS,
    list: [],
    page: 1,
    hasMore: true,
    loading: false,
    error: ''
  },

  onLoad(query) {
    const q = query || {};
    const keyword = decode(q.keyword).trim();
    this.setData({
      keyword,
      input: keyword,
      modelId: q.modelId || '',
      modelName: decode(q.modelName),
      condition: ['used', 'new'].includes(q.condition) ? q.condition : '',
      history: readHistory()
    });
    this.syncFilterCount();
    return this.load(true);
  },

  onUnload() { this._revision = (this._revision || 0) + 1; },

  onPullDownRefresh() {
    return this.load(true).finally(() => wx.stopPullDownRefresh());
  },

  onRetry() { return this.load(true); },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.load(false);
  },

  params() {
    const d = this.data;
    return { keyword: d.keyword, modelId: d.modelId, condition: d.condition, grade: d.grade, batteryMin: d.batteryMin, priceMin: d.priceMin, priceMax: d.priceMax };
  },

  async load(reset) {
    const revision = this._revision = (this._revision || 0) + 1;
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '', ...(reset ? { list: [], hasMore: true } : {}) });
    try {
      const query = this.params();
      Object.keys(query).forEach((k) => { if (query[k] === '') delete query[k]; });
      const res = await api.shop.units({ ...query, page, pageSize: 20 });
      if (revision !== this._revision) return;
      const list = reset ? res.list : this.data.list.concat(res.list);
      this.setData({ list, page, hasMore: list.length < res.total });
    } catch (e) {
      if (revision === this._revision) this.setData({ error: e.message || '加载失败' });
    } finally {
      if (revision === this._revision) this.setData({ loading: false });
    }
  },

  onInput(e) { this.setData({ input: e.detail.value }); },

  onSearch() {
    const keyword = this.data.input.trim();
    if (keyword) this.saveHistory(keyword);
    this.setData({ keyword });
    return this.load(true);
  },

  onClearInput() {
    this.setData({ input: '', keyword: '' });
    return this.load(true);
  },

  onHistoryTap(e) {
    const keyword = e.currentTarget.dataset.value;
    this.saveHistory(keyword);
    this.setData({ input: keyword, keyword });
    return this.load(true);
  },

  saveHistory(keyword) {
    const history = [keyword].concat(this.data.history.filter((k) => k !== keyword)).slice(0, HISTORY_MAX);
    this.setData({ history });
    try { wx.setStorageSync(HISTORY_KEY, history); } catch (e) { /* 本地存储不可用时只保留本次会话 */ }
  },

  onClearHistory() {
    this.setData({ history: [] });
    try { wx.removeStorageSync(HISTORY_KEY); } catch (e) { /* 忽略 */ }
  },

  onClearModel() {
    this.setData({ modelId: '', modelName: '' });
    return this.load(true);
  },

  onToggleFilter() { this.setData({ showFilter: !this.data.showFilter }); },

  /** 新旧、成色、电池为单选 chip，选中即生效 */
  onPick(e) {
    const { field, value } = e.currentTarget.dataset;
    this.setData({ [field]: this.data[field] === value && field !== 'condition' ? '' : value });
    this.syncFilterCount();
    return this.load(true);
  },

  onPriceInput(e) { this.setData({ [e.currentTarget.dataset.field + 'Draft']: e.detail.value.trim() }); },

  onApplyPrice() {
    const { priceMinDraft: priceMin, priceMaxDraft: priceMax } = this.data;
    const valid = (v) => v === '' || /^\d{1,9}(\.\d{1,2})?$/.test(v);
    if (!valid(priceMin) || !valid(priceMax)) return this.$toast('请输入有效金额');
    if (priceMin !== '' && priceMax !== '' && Number(priceMin) > Number(priceMax)) return this.$toast('最低价不能高于最高价');
    this.setData({ priceMin, priceMax });
    this.syncFilterCount();
    return this.load(true);
  },

  onResetFilter() {
    this.setData({ condition: '', grade: '', batteryMin: '', priceMin: '', priceMax: '', priceMinDraft: '', priceMaxDraft: '' });
    this.syncFilterCount();
    return this.load(true);
  },

  syncFilterCount() {
    const d = this.data;
    this.setData({ filterCount: [d.condition, d.grade, d.batteryMin, d.priceMin || d.priceMax].filter(Boolean).length });
  },

  onUnitSelect(e) {
    this.$go(ROUTES.PRODUCT, { id: e.detail.id });
  }
});

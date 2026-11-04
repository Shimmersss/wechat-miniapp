const { createPage } = require('../../utils/page');
const api = require('../../api/index');
const { ROUTES } = require('../../utils/router');

createPage({
  data: {
    categories: [],
    activeIndex: 0,
    condition: 'used'
  },

  onShow() {
    api.shop.categories().then(categories => this.setData({ categories, activeIndex: Math.min(this.data.activeIndex, Math.max(0, categories.length - 1)) })).catch(() => null);
  },

  onCategoryTap(e) {
    this.setData({ activeIndex: e.currentTarget.dataset.index });
  },

  onConditionTap(e) {
    this.setData({ condition: e.currentTarget.dataset.value });
  },

  /** 已建档型号按 modelId 精确筛选；未建档的展示型号退回关键词搜索 */
  onModelTap(e) {
    const { id, name } = e.currentTarget.dataset;
    const query = id ? { modelId: id, modelName: name } : { keyword: name };
    this.$go(ROUTES.SEARCH, { ...query, condition: this.data.condition });
  }
});

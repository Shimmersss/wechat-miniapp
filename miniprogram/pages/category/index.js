const { createPage } = require('../../utils/page');
const api = require('../../api/index');
const { ROUTES } = require('../../utils/router');

createPage({
  data: {
    categories: [],
    activeIndex: 0
  },

  onShow() {
    api.shop.categories().then(categories => this.setData({ categories, activeIndex: Math.min(this.data.activeIndex, Math.max(0, categories.length - 1)) })).catch(() => null);
  },

  onCategoryTap(e) {
    this.setData({ activeIndex: e.currentTarget.dataset.index });
  },

  onModelTap(e) {
    // TODO(codex): 搜索页支持 model 参数精确筛选
    this.$go(ROUTES.SEARCH, { keyword: e.currentTarget.dataset.model });
  }
});

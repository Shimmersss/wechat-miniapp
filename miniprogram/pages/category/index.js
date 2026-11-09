const { createPage } = require("../../utils/page");
const api = require("../../api/index");
const { ROUTES } = require("../../utils/router");

createPage({
  data: {
    categories: [],
    loading: false,
    error: "",
    activeIndex: 0,
    condition: "used",
  },

  onShow() {
    return this.load();
  },
  async load() {
    const revision = (this.revision = (this.revision || 0) + 1);
    this.setData({ loading: true, error: "" });
    try {
      const categories = await api.shop.categories();
      if (revision !== this.revision) return;
      this.setData({
        categories,
        activeIndex: Math.min(
          this.data.activeIndex,
          Math.max(0, categories.length - 1),
        ),
      });
    } catch (e) {
      if (revision === this.revision)
        this.setData({ error: e.message || "分类加载失败，请重试" });
    } finally {
      if (revision === this.revision) this.setData({ loading: false });
    }
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
  },
});

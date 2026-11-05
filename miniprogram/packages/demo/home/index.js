const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');

/** 方案 G 演示 · 顾客首页：数据走 api.shop（价格由服务端按渠道计算，前端只展示） */
createPage({
  data: { todayStock: 0, brands: [], activeBrand: 'all', units: [], loading: false, error: '' },

  onLoad() {
    api.shop.home()
      .then(home => this.setData({ todayStock: home.todayStock, brands: home.brands || [] }))
      .catch(e => this.setData({ error: e.message }));
    this.loadUnits();
  },

  loadUnits() {
    this.setData({ loading: true, error: '' });
    return api.shop.units({ brand: this.data.activeBrand, page: 1, pageSize: 6 })
      .then(res => this.setData({ units: res.list }))
      .catch(e => this.setData({ error: e.message }))
      .finally(() => this.setData({ loading: false }));
  },

  onBrand(e) {
    const { value } = e.currentTarget.dataset;
    if (value === this.data.activeBrand) return;
    this.setData({ activeBrand: value });
    this.loadUnits();
  },

  onSearch() {
    this.$go(ROUTES.SEARCH);
  },

  onUnit(e) {
    this.$go(ROUTES.PRODUCT, { id: e.currentTarget.dataset.id });
  }
});

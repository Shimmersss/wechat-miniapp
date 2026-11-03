const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');

/**
 * 搜索：按品牌/型号/内存/颜色搜索在售设备，只返回公开字段
 */
createPage({
  data: {
    list: [],
    page: 1,
    hasMore: true,
    loading: false,
    todos: [
      '顶部搜索输入框 + 历史搜索（本地存储）',
      '筛选：成色 / 价格区间 / 电池 / 新机二手',
      '结果使用 product-card 双列展示'
    ]
  },

  onLoad(query) {
    this.query = query || {};
    if (this.query.status && this.data.filters) this.setData({ activeFilter: this.query.status });
    this.load(true);
  },

  onPullDownRefresh() {
    this.load(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore) this.load(false);
  },

  load(reset) {
    if (this.data.loading) return Promise.resolve();
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    return api.shop.units({ ...this.query, page, pageSize: 20 })
      .then((res) => {
        const list = reset ? res.list : this.data.list.concat(res.list);
        this.setData({ list, page, hasMore: list.length < res.total });
      })
      .finally(() => this.setData({ loading: false }));
  },

  onItemTap(e) {
    this.$go(ROUTES.PRODUCT, { id: e.currentTarget.dataset.id });
  },
});

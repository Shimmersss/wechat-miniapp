const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');

/**
 * 代理加价（需求 12）：代理分享价 = 总部代理底价 + 代理加价。
 * 加价只能在 [markupMin, markupMax] 内，服务端校验并返回新的 sharePrice，前端不自行计算价格。
 * 入口参数：unitId（可选，带上时滚动到该商品）
 */
createPage({
  requireAgent: true,
  data: {
    units: [],
    focusId: ''
  },

  onLoad(query) {
    this.setData({ focusId: query.unitId || '' });
    api.agent.units({ page: 1, pageSize: 50 }).then((res) => this.setData({ units: res.list }));
  },

  onMarkupChanging(e) {
    const { index } = e.currentTarget.dataset;
    this.setData({ [`units[${index}].markup`]: e.detail.value });
  },

  onMarkupChange(e) {
    const { index } = e.currentTarget.dataset;
    const unit = this.data.units[index];
    api.agent.setMarkup(unit.unitId, { markup: e.detail.value }).then((res) => {
      this.setData({ [`units[${index}].markup`]: res.markup, [`units[${index}].sharePrice`]: res.sharePrice });
    });
  }
});

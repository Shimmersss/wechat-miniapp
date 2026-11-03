const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');

/**
 * 代理中心（框架文档 7.2）：今日访问、分享次数、意向/成交订单、待转账/已转账收益 + 共享库存列表。
 * 代理只能前台加价，不能改总部库存与底价；sharePrice 以服务端返回为准。
 */
createPage({
  requireAgent: true,
  data: {
    overview: {},
    units: []
  },

  onLoad() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  load() {
    return Promise.all([
      api.agent.overview().then((overview) => this.setData({ overview })),
      api.agent.units({ page: 1, pageSize: 10 }).then((res) => this.setData({ units: res.list }))
    ]);
  },

  onMarkup(e) {
    this.$go(ROUTES.AGENT_MARKUP, { unitId: e.currentTarget.dataset.id });
  },

  onShare(e) {
    this.$go(ROUTES.POSTER, { unitId: e.currentTarget.dataset.id, channel: 'agent' });
  }
});

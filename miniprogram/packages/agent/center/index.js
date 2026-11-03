const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');

/**
 * 代理中心（框架文档 7.2）：今日访问/分享、锁定与成交订单、待转账/已转账收益，可转发库存。
 * 分享价、收益均以服务端返回为准；代理不能改总部库存与底价。
 */
createPage({
  requireAgent: true,
  data: { overview: null, units: [], loading: false, error: '' },

  onShow() { return this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const [overview, units] = await Promise.all([api.agent.overview(), api.agent.units({ page: 1, pageSize: 20 })]);
      this.setData({ overview, units: units.list });
    } catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ loading: false }); }
  },
  onMarkup(e) { this.$go(ROUTES.AGENT_MARKUP, { unitId: e.currentTarget.dataset.id }); },
  onShare(e) { this.$go(ROUTES.POSTER, { unitId: e.currentTarget.dataset.id, channel: 'agent' }); }
});

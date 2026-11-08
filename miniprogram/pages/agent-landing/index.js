const { createPage } = require('../../utils/page');
const api = require('../../api/index');
const { ROUTES } = require('../../utils/router');

/** 代理招募页（需求 16）：顾客端直接可见，申请后跳转申请表；已是代理则进入代理中心 */
createPage({
  data: {
    agentStatus: 'none', // none | pending | active | rejected | disabled
    perks: [
      { icon: 'stock', title: '不用压货', desc: '不囤机，也不用垫货款' },
      { icon: 'live', title: '库存同步', desc: '卖掉自动下架，不怕撞单' },
      { icon: 'ledger', title: '每单有账', desc: '订单、收益都能随时查' },
      { icon: 'service', title: '售后门店管', desc: '检测发货售后都归门店' }
    ],
    steps: [
      { title: '提交申请', desc: '留下姓名、电话和地区，门店审核通过后开通。' },
      { title: '挑机加价', desc: '选好想卖的手机，在上限内定好自己的加价。' },
      { title: '发给朋友', desc: '转发小程序卡片或文案，朋友从你的链接下单。' },
      { title: '成交记账', desc: '门店收款发货后记一笔收益，线下转账给你。' }
    ],
    rules: [
      '目前只有一级代理，可以用邀请码邀请朋友一起做。',
      '加价有上限，金额由门店审核时定，只能在底价上加。',
      '朋友下单后设备会短暂锁定，门店确认收款才算成交。',
      '顾客退货时，这一单的收益会冲回；已经转账的，从之后的收益里扣。'
    ]
  },

  onShow() {
    api.agent
      .me()
      .then((res) => this.setData({ agentStatus: res.status }))
      .catch(() => null);
  },

  onPrimaryTap() {
    if (this.data.agentStatus === 'active') return this.$go(ROUTES.AGENT_CENTER);
    if (this.data.agentStatus === 'pending') return this.$toast('申请审核中，请耐心等待');
    if (this.data.agentStatus === 'disabled') return this.$toast('代理资格已停用，请联系门店');
    return this.$go(ROUTES.AGENT_APPLY);
  }
});

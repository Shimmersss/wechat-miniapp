const { createPage } = require('../../utils/page');
const api = require('../../api/index');
const { ROUTES } = require('../../utils/router');

/** 代理招募页（需求 16）：顾客端直接可见，申请后跳转申请表；已是代理则进入代理中心 */
createPage({
  data: {
    agentStatus: 'none', // none | pending | active | rejected
    benefits: [
      { no: '01', title: '无需投资', desc: '不用囤货、不压资金，成交后按单记账、总部转账。' },
      { no: '02', title: '共享实时机库', desc: '总部库存实时同步，卖出即下架，不会一机多卖。' },
      { no: '03', title: '自由加价', desc: '在总部规则内设置自己的分享价格。' },
      { no: '04', title: '一键转发', desc: '专属海报、小程序卡片、文案一键生成。' },
      { no: '05', title: '订单可归因', desc: '访问、咨询和成交都绑定你的代理身份。' },
      { no: '06', title: '售后放心', desc: '检测、发货与售后由夏目数码统一负责。' }
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
    return this.$go(ROUTES.AGENT_APPLY);
  }
});

const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');

/** 邀请码 / 邀请海报发展直属代理（首期只做一级代理，框架文档 7.2） */
createPage({
  requireAgent: true,
  data: {
    inviteCode: '',
    members: []
  },

  onLoad() {
    api.agent.invite().then((res) => this.setData({ inviteCode: res.inviteCode, members: res.members }));
  },

  onCopy() {
    wx.setClipboardData({ data: this.data.inviteCode });
  },

  onShareAppMessage() {
    return {
      title: '一起做夏目数码代理：无需囤货，一键转发',
      path: `${ROUTES.AGENT_APPLY}?inviteCode=${this.data.inviteCode}`
    };
  }
});

const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { required } = require('../../../utils/validate');

/**
 * 申请成为代理：代理申请（框架文档 7.2）：手机号、姓名/昵称、地区，实名/审核按业务配置
 */
createPage({
  data: {
    form: { name: '', phone: '', region: '', inviteCode: '' },
    todos: [
      '代理协议勾选（加价归代理、按单记账、退款冲回规则）',
      '地区选择器 picker mode=region',
      '提交后回到招募页显示审核中'
    ]
  },

  onLoad(query) {
    this.query = query || {};
    if (query.inviteCode) this.setData({ 'form.inviteCode': query.inviteCode });
  },

  onInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  onSubmit() {
    const err = required(this.data.form, [["name", "请填写姓名/昵称"], ["phone", "请填写手机号"], ["region", "请填写所在地区"]]);
    if (err) return this.$toast(err);
    return api.agent.apply(this.data.form)
      .then(() => {
        wx.showToast({ title: "已提交审核", icon: 'success' });
        setTimeout(() => this.$back(), 600);
      });
  }
});

const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { ROUTES } = require('../../../utils/router');
const { isPhone } = require('../../../utils/validate');

/**
 * 申请成为代理（框架文档 7.2、十三.1）：姓名、手机号、地区、可选邀请码，须同意代理协议；
 * 审核通过后由门店设定加价上限（固定金额），首期只做一级邀请。
 */
createPage({
  data: {
    form: { name: '', phone: '', region: [], inviteCode: '' },
    agreed: false, me: null, loading: false, saving: false, error: ''
  },

  onLoad(query = {}) {
    if (query.inviteCode) this.setData({ 'form.inviteCode': String(query.inviteCode).toUpperCase() });
    return this.load();
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try { this.setData({ me: await api.agent.me() }); }
    catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ loading: false }); }
  },
  onInput(e) { if (!this.data.saving) this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value }); },
  onRegion(e) { if (!this.data.saving) this.setData({ 'form.region': e.detail.value }); },
  onAgree() { if (!this.data.saving) this.setData({ agreed: !this.data.agreed }); },

  async onSubmit() {
    if (this.data.saving) return;
    const f = this.data.form;
    if (!f.name.trim()) return this.$toast('请填写姓名或昵称');
    if (!isPhone(f.phone.trim())) return this.$toast('请填写 11 位手机号');
    if (!f.region.length) return this.$toast('请选择所在地区');
    if (!this.data.agreed) return this.$toast('请先阅读并同意代理协议');
    this.setData({ saving: true, error: '' });
    try {
      const me = await api.agent.apply({ name: f.name.trim(), phone: f.phone.trim(), region: f.region.join(' '), agreed: true, ...(f.inviteCode.trim() ? { inviteCode: f.inviteCode.trim() } : {}) });
      this.setData({ me });
    } catch (e) {
      // 409 说明已提交或已是代理：以服务端当前状态为准
      if (Number(e.code) === 409) await this.load();
      this.setData({ error: e.message });
    } finally { this.setData({ saving: false }); }
  },
  onCenter() { this.$go(ROUTES.AGENT_CENTER); }
});

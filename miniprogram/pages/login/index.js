const { createPage } = require('../../utils/page');
const config = require('../../config/index');
const auth = require('../../utils/auth');
const api = require('../../api/index');
const { ROUTES, redirect } = require('../../utils/router');
const { ROLE_LABELS, STAFF_ROLES } = require('../../constants/roles');
const { isPhone } = require('../../utils/validate');

/**
 * 员工登录（需求 1）：员工独立账号 + 短信二次验证，首次登录绑定当前微信。
 * 登录成功后回跳 redirect 参数页面，默认进入经营工作台。
 */
createPage({
  trackView: false,
  data: {
    sendingCode: false, submitting: false, error: '',
    account: '', captchaImage: '', captchaToken: '', captchaCode: '',
    smsCode: '',
    counting: 0,
    redirect: '',
    devMode: config.useMock,
    mockRoles: STAFF_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
    mockRoleIndex: 0
  },

  onLoad(query) {
    let target = query.redirect || '';
    try { target = decodeURIComponent(target); } catch (e) { target = ''; }
    this.setData({ redirect: Object.values(ROUTES).includes(target.split('?')[0]) ? target : '' });
  },

  onUnload() {
    this.unloaded = true;
    clearInterval(this.timer);
    clearTimeout(this.redirectTimer);
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value.trim() });
  },

  onMockRoleChange(e) {
    this.setData({ mockRoleIndex: Number(e.detail.value) });
  },

  sendCode() {
    if (this.data.counting || this.data.sendingCode || this.data.submitting) return;
    if (!isPhone(this.data.account)) return this.$toast('请输入正确的手机号');
    this.setData({ sendingCode: true, error: '' });
    return api.auth.sendSmsCode({ phone: this.data.account, ...(this.data.captchaToken ? { captchaToken: this.data.captchaToken, captchaCode: this.data.captchaCode } : {}) }).then(() => {
      if (this.unloaded) return;
      this.setData({ counting: 60, captchaImage: '', captchaToken: '', captchaCode: '' });
      this.timer = setInterval(() => {
        const n = Math.max(0, this.data.counting - 1);
        this.setData({ counting: n });
        if (n <= 0) clearInterval(this.timer);
      }, 1000);
    }).catch(async error => { if (this.unloaded) return; this.setData({ error: error.message || '验证码发送失败，请重试' }); if (Number(error.code) === 428 || this.data.captchaToken) await this.refreshCaptcha(); })
      .finally(() => { if (!this.unloaded) this.setData({ sendingCode: false }); });
  },

  async refreshCaptcha() {
    try {
      const r=await api.auth.smsCaptcha();if(this.unloaded)return;
      const m=/^data:image\/(gif|png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/.exec(r.image||'');
      if(!m||!r.token)throw Error('图片验证码加载失败，请重试');
      const filePath=wx.env.USER_DATA_PATH+'/sms-captcha-'+((this.captchaRevision=(this.captchaRevision||0)+1)%2)+'.'+m[1];
      await new Promise((resolve,reject)=>wx.getFileSystemManager().writeFile({filePath,data:m[2],encoding:'base64',success:resolve,fail:reject}));
      if(!this.unloaded)this.setData({captchaImage:filePath,captchaToken:r.token,captchaCode:''});
    } catch(e) { if(!this.unloaded)this.setData({error:e.message||'图片验证码加载失败，请重试'}); }
  },

  submit() {
    if (this.data.submitting || this.data.sendingCode) return;
    const { account, smsCode, devMode, mockRoles, mockRoleIndex } = this.data;
    if (!devMode && (!isPhone(account) || !/^\d{6}$/.test(smsCode))) return this.$toast('请填写正确的手机号与六位验证码');
    this.setData({ submitting: true, error: '' });
    return auth.staffLogin({ account, smsCode, mockRole: devMode ? mockRoles[mockRoleIndex].value : undefined })
      .then(() => {
        if (this.unloaded) return;
        wx.showToast({ title: '登录成功', icon: 'success' });
        this.redirectTimer = setTimeout(() => redirect(this.data.redirect || ROUTES.DASHBOARD), 400);
      }).catch(error => { if (!this.unloaded) this.setData({ error: error.message || '登录失败，请重试' }); })
      .finally(() => { if (!this.unloaded) this.setData({ submitting: false }); });
  }
});

const { http } = require('../../utils/request');

module.exports = {
  /** 微信静默登录 → { token, user } */
  wxLogin: (data) => http.post('/auth/wx-login', data, { showError: false }),
  /** 员工登录：{ account: 员工手机号, smsCode: 六位验证码, code: wx.login 凭证 } → { token, user }，首次登录绑定当前微信 */
  staffLogin: (data) => http.post('/auth/staff-login', data, { loading: true }),
  /** 发送员工二次验证短信 */
  sendSmsCode: (data) => http.post('/auth/sms-code', data),
  me: () => http.get('/auth/me'),
  logout: () => http.post('/auth/logout', {}, { showError: false })
};

/**
 * 运行环境配置。
 * - 开发版默认走本地 mock（mock/index.js），后端就绪后把 useMock 改为 false 并填 baseUrl。
 * - 切勿在小程序代码里放任何服务端密钥（数据库账号、第三方 API Key 等），小程序包可被反编译。
 */
const ENV = (() => {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion; // develop | trial | release
  } catch (e) {
    return 'develop';
  }
})();

const ENV_CONFIG = {
  develop: { baseUrl: 'http://localhost:3000/api/v1', useMock: true },
  trial: { baseUrl: 'https://api-staging.example.com/api/v1', useMock: false },
  release: { baseUrl: 'https://api.example.com/api/v1', useMock: false }
};

module.exports = {
  env: ENV,
  ...ENV_CONFIG[ENV],
  timeout: 15000,
  brand: {
    name: '夏目数码',
    nameEn: 'XIAMU DIGITAL',
    slogan: '让价格透明 · 让产品放心',
    warrantyDays: 90
  },
  storageKeys: {
    token: 'xm_token',
    user: 'xm_user',
    channel: 'xm_channel',
    visitorId: 'xm_vid'
  }
};

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
  // 开发版直连测试服务器（HTTP + IP，靠开发者工具的 urlCheck:false 放行）。
  // 想回到本地 mock 调试，把 useMock 改回 true 即可。
  develop: { baseUrl: 'http://43.142.25.151:3000/api/v1', useMock: false },
  // TODO(上线前)：换成正式域名 + HTTPS，并把域名加进微信后台「服务器域名」白名单。
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
    visitorId: 'xm_vid',
    searchHistory: 'xm_search_history'
  }
};

/**
 * 运行环境配置。
 * - 开发版连测试服务器；要用本地 mock（mock/index.js）时临时把 useMock 改为 true，不要提交。
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
  // 开发版走云开发（useCloud：wx.cloud.callFunction，默认环境，不写环境 ID）。
  // 未迁移的接口会明确报“尚未迁移到云开发”，不回退旧服务器；要连旧测试服务器把 useCloud 改为 false。
  // 想回到本地 mock 调试，把 useMock 改回 true 即可。
  develop: { baseUrl: 'http://43.142.25.151:3000/api/v1', useMock: false, useCloud: true },
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
    searchHistory: 'xm_search_history',
    workbenchTools: 'xm_workbench_tools'
  }
};

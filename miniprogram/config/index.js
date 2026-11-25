/**
 * 运行环境配置。
 * - 开发版默认走云开发；要用本地 mock 时临时把 useMock 改为 true，不要提交。
 * - 切勿在小程序代码里放任何服务端密钥（数据库账号、第三方 API Key 等），小程序包可被反编译。
 */
const ENV = (() => {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion; // develop | trial | release
  } catch (e) {
    return 'develop';
  }
})();

// scripts/configure-cloud-preview.js 在本机生成此模块。新检出必须先生成网关配置。
let previewCloud = {};
try {
  previewCloud = require('./cloud.local');
} catch (e) {}

const ENV_CONFIG = {
  // 开发版与体验版统一走 HTTPS 网关；新机器先运行 configure-cloud-preview.js。
  develop: {
    baseUrl: 'http://43.142.25.151:3000/api/v1',
    useMock: false,
    useCloud: true,
    cloudHttpBaseUrl: previewCloud.httpBaseUrl || ''
  },
  // 体验版从上传包读取 HTTPS 网关地址，微信公众平台需放行该域名。
  trial: {
    useMock: false,
    useCloud: true,
    cloudHttpBaseUrl: previewCloud.httpBaseUrl || ''
  },
  release: {
    useMock: false,
    useCloud: true,
    cloudHttpBaseUrl: previewCloud.httpBaseUrl || ''
  }
};

module.exports = {
  env: ENV,
  ...ENV_CONFIG[ENV],
  brandAssetsBaseUrl: ENV_CONFIG[ENV]?.useCloud ? previewCloud.brandAssetsBaseUrl || '' : '',
  staffWechatLogin: !!(ENV_CONFIG[ENV]?.useCloud || ENV_CONFIG[ENV]?.useMock),
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
    workbenchTools: 'xm_workbench_tools',
    inboundPreferences: 'xm_inbound_preferences'
  }
};

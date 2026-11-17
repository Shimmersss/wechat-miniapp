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

// scripts/configure-cloud-preview.js 在本机生成此模块。微信直连云开发的检出无需网关配置。
let previewCloud = {};
try {
  previewCloud = require('./cloud.local');
} catch (e) {}

const ENV_CONFIG = {
  // 开发版走云开发（useCloud：wx.cloud.callFunction，默认环境，不写环境 ID）。
  // 未迁移的接口会明确报“尚未迁移到云开发”，不回退旧服务器；要连旧测试服务器把 useCloud 改为 false。
  // 想回到本地 mock 调试，把 useMock 改回 true 即可。
  // cloudEnv：云开发环境 ID。留空表示用小程序关联的默认环境；
  // 环境 ID 属凭据类信息，不写死在这里，由「我的 → 开发调试」或本机私有配置注入。
  develop: {
    baseUrl: 'http://43.142.25.151:3000/api/v1',
    useMock: false,
    useCloud: true,
    cloudHttpBaseUrl: (() => {
      try {
        return previewCloud.httpBaseUrl || wx.getStorageSync('xm_cloud_http_base') || '';
      } catch (e) {
        return previewCloud.httpBaseUrl || '';
      }
    })(),
    // 环境 ID 属凭据类信息，不写进仓库；开发时用
    // wx.setStorageSync('xm_cloud_env', '<环境ID>') 在本机指定，留空则用默认环境。
    cloudEnv: (() => {
      try {
        return wx.getStorageSync('xm_cloud_env') || '';
      } catch (e) {
        return '';
      }
    })()
  },
  // 体验版从上传包读取 HTTPS 网关地址，微信公众平台需放行该域名。
  trial: {
    useMock: false,
    useCloud: true,
    cloudHttpBaseUrl: previewCloud.httpBaseUrl || ''
  },
  // TODO(上线前)：release 仍是占位。正式发布前改成生产网关或云开发，并把域名加进后台白名单。
  release: { baseUrl: 'https://api.example.com/api/v1', useMock: false }
};

module.exports = {
  env: ENV,
  ...ENV_CONFIG[ENV],
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
    workbenchTools: 'xm_workbench_tools'
  }
};

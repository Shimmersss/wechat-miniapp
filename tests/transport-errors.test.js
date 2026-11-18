const test = require('node:test');
const assert = require('node:assert/strict');
const { transportError } = require('../miniprogram/utils/request');

test('传输错误显示可操作的中文提示', async () => {
  const cases = [
    [{ errMsg: 'FUNCTIONS_NOT_FOUND -505005' }, 'wifi', '后端接口未部署'],
    [{ errMsg: 'url not in domain list' }, 'wifi', '云开发网关未加入小程序的 request 合法域名'],
    [{ errMsg: 'request:fail timeout' }, 'wifi', '连接服务器超时，请稍后重试'],
    [{ errMsg: 'request:fail' }, 'none', '当前没有网络'],
    [{ statusCode: 503 }, 'wifi', '服务器开小差了，请稍后重试'],
    [{ errMsg: 'request:fail unknown' }, 'wifi', '网络不稳定，请检查网络后重试'],
  ];
  for (const [error, networkType, message] of cases) {
    global.wx = { getNetworkType: ({ success }) => success({ networkType }) };
    assert.equal((await transportError(error)).message, message);
  }
});

test('网关 HTTP 5xx 忽略网关原始说明，业务信封保留服务端文案', async () => {
  const config = require('../miniprogram/config/index');
  const { request } = require('../miniprogram/utils/request');
  config.useMock = false;
  config.useCloud = true;
  config.cloudHttpBaseUrl = 'https://api.example.test';
  let data = { message: 'upstream socket closed' };
  global.wx = {
    getStorageSync: () => '',
    request: ({ success }) => success({ statusCode: 503, data }),
  };
  const send = () => request({ url: '/shop/home', showError: false });
  await assert.rejects(send, /服务器开小差了/);
  data = { code: 503, message: '门店暂不可用' };
  await assert.rejects(send, /门店暂不可用/);
});

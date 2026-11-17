// 为开发版和体验版生成公开网关配置，不读取服务端密钥。
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const gateway = process.argv[2] || JSON.parse(
  readFileSync(path.join(root, '.local/cloudbase/single-env-gateway.json'), 'utf8'),
).domain;
const address = new URL(gateway.includes('://') ? gateway : `https://${gateway}`);
if (address.protocol !== 'https:' || !/^[a-z\d.-]+$/i.test(address.hostname) ||
    address.username || address.password || address.pathname !== '/' || address.search || address.hash) {
  throw new Error('请填写不含路径或凭据的 HTTPS 网关地址');
}

writeFileSync(path.join(root, 'miniprogram/config/cloud.local.js'),
  `// 由 scripts/configure-cloud-preview.js 生成。仅含公开网关地址。\nmodule.exports = ${JSON.stringify({ httpBaseUrl: address.origin }, null, 2)};\n`);
console.log('已生成开发版和体验版网关配置');

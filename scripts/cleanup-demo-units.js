#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv, parseArgs } = require('node:util');
const { execFileSync } = require('node:child_process');

const local = path.resolve(__dirname, '../.local/cloudbase');
const sql = name => fs.readFileSync(path.join(__dirname, 'sql', name), 'utf8');
const previewSql = sql('cleanup-demo-units-preview.sql');

function applySql(preview) {
  if (!Number.isSafeInteger(preview.count) || preview.count < 0 ||
      !/^[a-f0-9]{64}$/.test(preview.fingerprint)) throw new Error('预览记录无效');
  return sql('cleanup-demo-units-apply.sql')
    .replace('/* PREVIEW_QUERY */', () => previewSql)
    .replace('/* EXPECTED_COUNT */', String(preview.count))
    .replace('/* EXPECTED_FINGERPRINT */', "'" + preview.fingerprint + "'");
}

function main() {
  const { values } = parseArgs({ options: {
    'env-id': { type: 'string' }, 'env-file': { type: 'string' }, apply: { type: 'boolean' },
  } });
  const envId = values['env-id'];
  const envFile = values['env-file'];
  if (!/^[a-z0-9-]+$/.test(envId || '') || !envFile) throw new Error('须显式提供 --env-id 与 --env-file');
  const privateEnv = parseEnv(fs.readFileSync(envFile, 'utf8'));
  const gateway = JSON.parse(fs.readFileSync(path.join(local, 'single-env-gateway.json'), 'utf8'));
  if (privateEnv.CLOUDBASE_ENV_ID !== envId || gateway.envId !== envId ||
      (privateEnv.CLOUDBASE_DATA_ENV_ID && privateEnv.CLOUDBASE_DATA_ENV_ID !== envId))
    throw new Error('目标环境与私有函数配置或网关配置不一致');

  // 与现有清理脚本一致，production 不替代显式环境匹配及人工确认。
  const savedFile = path.join(local, 'demo-unit-preview-' + envId + '.json');
  const mcp = (name, args) => {
    try {
      const raw = execFileSync('npx', [
        '-y', 'mcporter', 'call', '--stdio', 'npx -y @cloudbase/cloudbase-mcp@latest',
        name, '--args', JSON.stringify({ ...args, envId }), '--output', 'json',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
      const result = JSON.parse(raw.slice(raw.indexOf('{')));
      if (!result.success) throw new Error();
      return result.data;
    } catch {
      throw new Error('目标库操作失败，请核对 CloudBase 登录态和 PostgreSQL 权限，再重新预览');
    }
  };
  const preview = () => {
    const result = mcp('queryPgDatabase', {
      action: 'sql', limit: 1, sql: 'SELECT preview FROM (' + previewSql + ') AS candidates',
    }).rows[0].preview;
    return typeof result === 'string' ? JSON.parse(result) : result;
  };
  if (!values.apply) {
    const data = preview();
    fs.writeFileSync(savedFile, JSON.stringify({ at: Date.now(), count: data.count, fingerprint: data.fingerprint }), { mode: 0o600 });
    const { fingerprint, ...visible } = data;
    console.log(JSON.stringify(visible, null, 2));
    return;
  }

  if (!fs.existsSync(savedFile)) throw new Error('请先预览并核对待删设备');
  const saved = JSON.parse(fs.readFileSync(savedFile, 'utf8'));
  if (!Number.isFinite(saved.at) || saved.at > Date.now() || Date.now() - saved.at > 3600000)
    throw new Error('预览已过期，请重新预览');
  const current = preview();
  if (saved.count !== current.count || saved.fingerprint !== current.fingerprint)
    throw new Error('待删清单已变化，请重新预览');
  if (!saved.count) return console.log('待删设备为 0 台');
  mcp('managePgDatabase', { action: 'execute', confirm: true, sql: applySql(saved) });
  const after = preview();
  console.log(`已执行清理。复核剩余待删 ${after.count} 台，需人工处理 ${after.manualReview.length} 台。`);
  if (after.count) process.exitCode = 1;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { applySql, previewSql };

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { guard } = require('../scripts/lib/verification-guard');

test('云端验证脚本：命中正式环境或无法确认环境时拒绝运行，显式放行才允许', () => {
  assert.throws(() => guard({ production: new Set(['prod']), candidates: new Set(['prod']) }), /正式环境/);
  assert.throws(() => guard({ production: new Set(['prod']), candidates: new Set() }), /无法确认/);
  assert.doesNotThrow(() => guard({ production: new Set(['prod']), candidates: new Set(['verify']) }));
  assert.doesNotThrow(() => guard({ production: new Set(['prod']), candidates: new Set(['prod']), allow: 'prod' }));
  assert.doesNotThrow(() => guard({ production: new Set(), candidates: new Set() }));
});

test('所有云端验证脚本在执行任何写入前先调用保护', () => {
  const dir = path.join(__dirname, '../scripts');
  for (const name of fs.readdirSync(dir).filter((n) => /^verify-cloud-.*\.js$/.test(n))) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    const at = source.indexOf('require("./lib/verification-guard").guard();');
    assert.ok(at >= 0, name);
    const firstCode = source.slice(0, at).replace(/^#!.*\n/, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    assert.equal(firstCode, '', name + ' 保护调用之前不能有其他语句');
  }
});

test('清理 SQL 只保留预置分类，不删审计、用户、供应商，混合单据中止', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../scripts/sql/cleanup-verification.sql'), 'utf8');
  assert.match(sql, /keep_categories text\[\] := ARRAY\['phone','tablet','audio','accessory','other'\]/);
  for (const table of ['audit_logs', 'users', 'staff', 'suppliers', 'files', 'roles', 'sessions']) assert.doesNotMatch(sql, new RegExp(`DELETE FROM ${table}\\b`), table);
  assert.match(sql, /IF NOT p_apply THEN RETURN preview; END IF;\s+IF mixed <> '\{\}'::jsonb THEN RAISE EXCEPTION/);
});

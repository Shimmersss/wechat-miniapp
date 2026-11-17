#!/usr/bin/env node
/**
 * 清理验证脚本留下的测试分类及其业务数据（docs/PLAN-DEVICE-TYPES-AND-SERIAL-INBOUND.md 6.2）。
 *
 *   node scripts/cleanup-verification-data.js --env-id <环境ID> --env-file <私有函数配置>            # 只预览
 *   node scripts/cleanup-verification-data.js --env-id <环境ID> --env-file <私有函数配置> --apply    # 执行
 *
 * - 保留预置分类 phone / tablet / audio / accessory / other 及其设备、单据；其余分类连同设备与单据删除。
 * - 删除前必须先在 1 小时内对同一环境跑过预览，且待删数量没有变化；删除在一个事务里完成，不可恢复。
 * - 审计日志、用户、员工、供应商、文件记录与云存储对象不删，预览里列出供人工决定。
 * - 目标环境必须与私有配置中的 CLOUDBASE_DATA_ENV_ID（未配置时为 CLOUDBASE_ENV_ID）一致。
 * - 通过已登录的 CloudBase MCP（mcporter）执行 SQL；环境 ID、密钥不写进任何被跟踪文件，也不打印。
 */
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const local = path.join(root, ".local/cloudbase");
const { values } = parseArgs({
  options: {
    "env-id": { type: "string" },
    "env-file": { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

const envId = values["env-id"];
if (!envId || !/^[a-z0-9-]+$/.test(envId)) throw new Error("请通过 --env-id 显式指定目标云环境");
if (!values["env-file"]) throw new Error("请通过 --env-file 指定目标环境的私有函数配置");
const privateEnv = Object.fromEntries(
  fs
    .readFileSync(path.resolve(values["env-file"]), "utf8")
    .split("\n")
    .map((line) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const dataEnvId = privateEnv.CLOUDBASE_DATA_ENV_ID || privateEnv.CLOUDBASE_ENV_ID;
if (!dataEnvId) throw new Error("私有配置缺少 CLOUDBASE_ENV_ID");
if (dataEnvId !== envId) throw new Error("--env-id 与私有配置的数据环境不一致");

function mcp(tool, args) {
  let raw;
  try {
    raw = execFileSync(
      "npx",
      ["-y", "mcporter", "call", "--stdio", "npx -y @cloudbase/cloudbase-mcp@latest", tool, "--args", JSON.stringify({ ...args, envId }), "--output", "json"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (e) {
    if (!e.stdout) throw Error("CloudBase MCP 调用失败，请确认已登录（tcb login）");
    raw = String(e.stdout);
  }
  const result = JSON.parse(raw.slice(raw.indexOf("{")));
  if (!result.success) throw new Error(result.message || result.errorCode || "CloudBase MCP 返回失败");
  return result;
}
const execute = (sql) => mcp("managePgDatabase", { action: "execute", confirm: true, sql });
const query = (sql) => mcp("queryPgDatabase", { action: "sql", sql, limit: 5 }).data.rows;

const functionSql = fs.readFileSync(path.join(__dirname, "sql/cleanup-verification.sql"), "utf8");
const dropSql = "DROP FUNCTION IF EXISTS public.xiamu_cleanup_verification(boolean);";
const previewFile = path.join(local, `cleanup-preview-${envId}.json`);
const preview = () => {
  const row = query("SELECT xiamu_cleanup_verification(false) AS preview")[0];
  return typeof row.preview === "string" ? JSON.parse(row.preview) : row.preview;
};

fs.mkdirSync(local, { recursive: true });
execute(functionSql);
try {
  const current = preview();
  if (!values.apply) {
    fs.writeFileSync(previewFile, JSON.stringify({ at: Date.now(), preview: current }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(current, null, 2));
    console.log("\n以上为预览，未删除任何数据。确认后加 --apply 执行（1 小时内有效）。");
  } else {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(previewFile, "utf8"));
    } catch {
      throw new Error("请先运行一次预览并核对结果");
    }
    if (Date.now() - saved.at > 3600000) throw new Error("预览已超过 1 小时，请重新预览");
    if (JSON.stringify(saved.preview.counts) !== JSON.stringify(current.counts)) throw new Error("待删数据与预览时不同，请重新预览");
    if (Object.keys(current.mixed || {}).length) throw new Error("存在同时含保留与待删设备的单据，已中止");
    execute("SELECT public.xiamu_cleanup_verification(true);");
    const after = preview();
    if (Number(after.counts.units) !== 0 || Number(after.counts.categories) !== 0) throw new Error("清理后仍有待删数据，请人工核对");
    fs.rmSync(previewFile, { force: true });
    console.log(`已删除 ${current.counts.categories} 个分类、${current.counts.models} 个型号、${current.counts.units} 台设备及其单据；保留 ${current.counts.keptUnits} 台。`);
  }
} finally {
  execute(dropSql);
}

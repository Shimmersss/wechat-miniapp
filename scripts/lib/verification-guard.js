/**
 * 云端验证脚本的环境保护：验证脚本会在目标库里留下“验证”分类、设备和单据，只能对隔离的验证环境运行。
 *
 * 判定：本机 .local/cloudbase/functions*.env 中 NODE_ENV=production 的配置，其 CLOUDBASE_ENV_ID /
 * CLOUDBASE_DATA_ENV_ID 视为正式环境。验证脚本可能连接的环境（tcb 当前环境、短信配置记录的环境）
 * 只要命中正式环境就拒绝运行。确需在某个环境运行时，显式设置 XIAMU_ALLOW_VERIFY_ENV=<环境ID>。
 * 不打印环境 ID。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const local = path.resolve(__dirname, "../../.local/cloudbase");

function readEnv(file) {
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim()))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
}

/** 本机私有配置里标记为正式环境的环境 ID */
function productionEnvIds() {
  if (!fs.existsSync(local)) return new Set();
  const ids = new Set();
  for (const name of fs.readdirSync(local).filter((n) => /^functions.*\.env$/.test(n))) {
    const env = readEnv(path.join(local, name));
    if (env.NODE_ENV !== "production") continue;
    for (const key of ["CLOUDBASE_ENV_ID", "CLOUDBASE_DATA_ENV_ID"]) if (env[key]) ids.add(env[key]);
  }
  return ids;
}

/** 验证脚本可能连接的环境：tcb 当前环境，以及短信验收记录的环境 */
function candidateEnvIds() {
  const ids = new Set();
  try {
    const listing = execFileSync("tcb", ["env", "list", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const env of JSON.parse(listing.slice(listing.indexOf("{"))).data || []) if (env.EnvId) ids.add(env.EnvId);
  } catch {}
  try {
    const sms = JSON.parse(fs.readFileSync(path.join(local, "sms-config-before.json"), "utf8"));
    if (sms.envId) ids.add(sms.envId);
  } catch {}
  return ids;
}

function guard({ production = productionEnvIds(), candidates = candidateEnvIds(), allow = process.env.XIAMU_ALLOW_VERIFY_ENV } = {}) {
  // 无法确认目标环境时按最坏情况处理（例如 tcb 未登录）
  if (production.size && !candidates.size)
    throw new Error("无法确认验证脚本的目标环境（tcb 未登录？），已拒绝运行，避免写入正式环境。");
  const hits = [...candidates].filter((id) => production.has(id) && id !== allow);
  if (hits.length) {
    throw new Error(
      "云端验证脚本会写入验证数据，不能对正式环境运行。请切换到隔离的验证环境；确需运行时设置 XIAMU_ALLOW_VERIFY_ENV 为目标环境 ID。",
    );
  }
}

module.exports = { guard, productionEnvIds, candidateEnvIds };

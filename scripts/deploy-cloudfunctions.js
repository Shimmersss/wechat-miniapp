#!/usr/bin/env node
/**
 * 部署云函数：node scripts/deploy-cloudfunctions.js --env-id <环境ID> [函数名...]
 *
 * - 先同步 cloudfunctions/common 到各函数 shared/。
 * - 环境变量读本机 .local/cloudbase/functions.env，可用 --env-file 指定另一份私有配置。
 * - cloudbaserc.json 生成在系统临时目录，部署完删除，避免密钥落进仓库。
 * - 环境 ID 必须与配置中的 CLOUDBASE_ENV_ID 一致。不使用 tcb 全局默认环境。
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseArgs } = require("node:util");

const root = path.resolve(__dirname, "..");
const fnRoot = path.join(root, "cloudfunctions");
const { values, positionals } = parseArgs({
  options: { "env-id": { type: "string" }, "env-file": { type: "string" } },
  allowPositionals: true,
});
const envId = values["env-id"];
if (!envId || !/^[a-z0-9-]+$/.test(envId))
  throw new Error("请通过 --env-id 显式指定目标云环境");
const envFile = values["env-file"]
  ? path.resolve(values["env-file"])
  : path.join(root, ".local/cloudbase/functions.env");

// 各函数需要的环境变量；只下发必要的，缩小密钥暴露面
const FUNCTION_ENV = {
  auth: [
    "NODE_ENV",
    "SESSION_HOURS",
    "STAFF_WECHAT_ONLY",
    "OTP_DEV_CODE",
    "OTP_HASH_KEY",
    "SMS_PROVIDER",
    "SMS_DAILY_LIMIT",
    "WX_APP_ID",
    "WX_APP_SECRET",
    "CLOUDBASE_API_KEY",
  ],
  shop: ["NODE_ENV", "CLOUDBASE_API_KEY"],
  "staff-stock": ["NODE_ENV", "CLOUDBASE_API_KEY", "WHOLESALE_DISCOUNT"],
  "staff-sales": ["NODE_ENV", "CLOUDBASE_API_KEY"],
  "cloud-maintenance": [
    "NODE_ENV",
    "CLOUDBASE_API_KEY",
    "MAINTENANCE_KEY",
    "STORAGE_TIMEOUT_MS",
  ],
  "staff-admin": ["NODE_ENV", "CLOUDBASE_API_KEY"],
  "staff-reports": ["NODE_ENV", "CLOUDBASE_API_KEY", "STORAGE_TIMEOUT_MS"],
  "staff-loans": ["NODE_ENV", "CLOUDBASE_API_KEY"],
  "staff-repair": [
    "NODE_ENV",
    "CLOUDBASE_API_KEY",
    "REPAIR_INTERNAL_COST_POLICY",
  ],
  agent: [
    "NODE_ENV",
    "CLOUDBASE_API_KEY",
    "AGENT_LOCK_MINUTES",
    "SHARE_HOURS",
    "WX_APP_ID",
    "WX_APP_SECRET",
    "WX_CODE_ENV_VERSION",
    "WX_CODE_CHECK_PATH",
  ],
  "agent-expiry": ["CLOUDBASE_API_KEY"],
  customer: [
    "NODE_ENV",
    "CLOUDBASE_API_KEY",
    "OTP_HASH_KEY",
    "APPOINTMENT_DAYS",
    "APPOINTMENT_SLOTS_B64",
    "AGENT_LOCK_MINUTES",
  ],
  files: ["NODE_ENV", "CLOUDBASE_API_KEY", "STORAGE_TIMEOUT_MS"],
};

function readEnv() {
  if (!fs.existsSync(envFile))
    throw new Error(
      `缺少 ${path.relative(root, envFile)}，格式为每行 KEY=VALUE`,
    );
  const out = {};
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const privateEnv = readEnv();
const gatewayFile = path.join(root, '.local/cloudbase/single-env-gateway.json');
require('./lib/deployment-target').verifyTarget(envId, privateEnv,
  fs.existsSync(gatewayFile) ? JSON.parse(fs.readFileSync(gatewayFile, 'utf8')) : null);
const dataEnvId = privateEnv.CLOUDBASE_DATA_ENV_ID || envId;
if (!/^[a-z0-9-]+$/.test(dataEnvId))
  throw new Error("CLOUDBASE_DATA_ENV_ID 格式无效");

// 服务端 API Key 是带环境声明的 JWT。部署前先识别填错环境或使用前端 Key 的情况。
const keyParts = privateEnv.CLOUDBASE_API_KEY?.split(".");
if (keyParts?.length === 3) {
  let claims;
  try {
    claims = JSON.parse(Buffer.from(keyParts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("CLOUDBASE_API_KEY 格式无效");
  }
  if (claims?.project_id !== dataEnvId || claims.role !== "service_role")
    throw new Error("请配置数据环境的服务端 API Key");
}

const env = {
  APPOINTMENT_DAYS: "30",
  APPOINTMENT_SLOTS: JSON.stringify(
    require("../miniprogram/constants/customer-requests").DEFAULT_SLOTS,
  ),
  AGENT_LOCK_MINUTES: "30",
  SHARE_HOURS: "72",
  WX_APP_ID: "",
  WX_APP_SECRET: "",
  WX_CODE_ENV_VERSION: "release",
  WX_CODE_CHECK_PATH: "true",
  REPAIR_INTERNAL_COST_POLICY: "capitalize",
  WHOLESALE_DISCOUNT: "0",
  STORAGE_TIMEOUT_MS: "12000",
  OTP_DEV_CODE: "",
  STAFF_WECHAT_ONLY: "0",
  ...privateEnv,
};
// CLI会展开JSON数组环境变量，使用字符串编码保留原预约时段配置。
env.APPOINTMENT_SLOTS_B64 =
  env.APPOINTMENT_SLOTS_B64 ||
  Buffer.from(env.APPOINTMENT_SLOTS, "utf8").toString("base64");
// 北京时间每天 04:00，沿用已验证的线上维护配置。
const MAINTENANCE_CRON = "0 0 4 * * * *";
const maintenanceTrigger = () =>
  "maintenance-" +
  crypto
    .createHmac("sha256", env.MAINTENANCE_KEY)
    .update("timer-v1")
    .digest("hex")
    .slice(0, 32);
const names = positionals.length ? positionals : Object.keys(FUNCTION_ENV);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "xiamu-fn-"));
// 配置临时存放，但登录态仍从项目根目录读取，避免退回全局账号或重新弹登录。
const runTcb = (args, options) => execFileSync("tcb", [
  "--cwd", root, "--config-file", path.join(work, "cloudbaserc.json"), ...args
], options);

try {
  const functions = names.map((name) => {
    if (!FUNCTION_ENV[name]) throw new Error(`未登记的函数：${name}`);
    const vars = { CLOUDBASE_DATA_ENV_ID: dataEnvId };
    if (env.XIAMU_HTTP_API === "1" && !["agent-expiry", "cloud-maintenance"].includes(name))
      vars.XIAMU_HTTP_API = "1";
    for (const key of FUNCTION_ENV[name]) {
      if (name === "auth" && env.STAFF_WECHAT_ONLY === "1" &&
        ["OTP_DEV_CODE", "OTP_HASH_KEY", "SMS_PROVIDER", "SMS_DAILY_LIMIT"].includes(key))
        continue;
      if (env[key] === undefined || (key === "CLOUDBASE_API_KEY" && !env[key]))
        throw new Error(`${name} 缺少环境变量 ${key}`);
      vars[key] = env[key];
    }
    return {
      name,
      ...(name === "cloud-maintenance" && MAINTENANCE_CRON
        ? {
            triggers: [
              {
                name: maintenanceTrigger(),
                type: "timer",
                config: MAINTENANCE_CRON,
              },
            ],
          }
        : {}),
      runtime: "Nodejs18.15",
      timeout: name === "cloud-maintenance" ? 120 : 10,
      handler: "index.main",
      installDependency: true,
      ignore: ["node_modules", "node_modules/**"],
      envVariables: vars,
    };
  });
  execFileSync(process.execPath, [path.join(__dirname, "sync-cloudfunctions.js")], {
    stdio: "inherit",
  });
  fs.writeFileSync(
    path.join(work, "cloudbaserc.json"),
    JSON.stringify(
      { envId, functionRoot: fnRoot, functions },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  for (const name of names) {
    runTcb(["fn", "deploy", name, "--force", "--dir", path.join(fnRoot, name)],
      {
        cwd: work,
        stdio: "inherit",
      },
    );
    if (name === "cloud-maintenance") {
      const readTriggers = () => {
        const raw = runTcb(["fn", "detail", name, "--json"], {
          cwd: work,
          encoding: "utf8",
        });
        return JSON.parse(raw.slice(raw.indexOf("{"))).data?.Triggers || [];
      };
      const desired = MAINTENANCE_CRON ? maintenanceTrigger() : null,
        existing = readTriggers();
      const cronOf = (t) =>
        t.TriggerDesc?.startsWith("{")
          ? JSON.parse(t.TriggerDesc).cron
          : t.TriggerDesc;
      for (const trigger of existing.filter(
        (t) =>
          t.Type === "timer" &&
          (!desired || t.TriggerName !== desired || cronOf(t) !== MAINTENANCE_CRON),
      ))
        runTcb(["fn", "trigger", "delete", name, trigger.TriggerName],
          { cwd: work, stdio: "inherit" },
        );
      if (
        desired && !existing.some(
          (t) => t.TriggerName === desired && cronOf(t) === MAINTENANCE_CRON,
        )
      )
        runTcb(["fn", "trigger", "create", name], {
          cwd: work,
          stdio: "inherit",
        });
      const timers = readTriggers().filter((t) => t.Type === "timer");
      if (desired
        ? timers.length !== 1 || timers[0].TriggerName !== desired || cronOf(timers[0]) !== MAINTENANCE_CRON
        : timers.length !== 0)
        throw Error("维护触发器读回不一致");
      console.log(desired ? "cloud-maintenance 定时触发器已核对" : "cloud-maintenance 定时任务已暂停");
    }

    if (name === "agent-expiry") {
      const detailText = runTcb(["fn", "detail", name, "--json"], {
        cwd: work,
        encoding: "utf8",
      });
      const detail = JSON.parse(detailText.slice(detailText.indexOf("{")));
      const existing = (detail.data?.Triggers || []).find(
        (t) => t.TriggerName === "agent-order-expiry",
      );
      // 应先应用按业务访问释放锁的数据库迁移，再移除旧触发器。
      if (existing)
        runTcb(["fn", "trigger", "delete", name, "agent-order-expiry"],
          { cwd: work, stdio: "inherit" },
        );
    }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

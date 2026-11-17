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

// 代理锁库到期释放频率（7 段 Cron）。2026-11-09 定为每 10 分钟，节省体验版资源点；
// 到期设备最多晚 10 分钟回到可售。TODO(confirm): 正式上线后按套餐资源点重新评估频率。
const EXPIRY_CRON = "0 */10 * * * * *";

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
if (privateEnv.CLOUDBASE_ENV_ID !== envId)
  throw new Error("目标云环境与私有配置的 CLOUDBASE_ENV_ID 不一致");
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
const MAINTENANCE_CRON = "0 */10 * * * * *";
const maintenanceTrigger = () =>
  "maintenance-" +
  crypto
    .createHmac("sha256", env.MAINTENANCE_KEY)
    .update("timer-v1")
    .digest("hex")
    .slice(0, 32);
const names = positionals.length ? positionals : Object.keys(FUNCTION_ENV);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "xiamu-fn-"));
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
      ...(name === "agent-expiry"
        ? {
            triggers: [
              {
                name: "agent-order-expiry",
                type: "timer",
                config: EXPIRY_CRON,
              },
            ],
          }
        : {}),
      ...(name === "cloud-maintenance"
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
      timeout: 10,
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
    execFileSync(
      "tcb",
      ["fn", "deploy", name, "--force", "--dir", path.join(fnRoot, name)],
      {
        cwd: work,
        stdio: "inherit",
      },
    );
    if (name === "cloud-maintenance") {
      const readTriggers = () => {
        const raw = execFileSync("tcb", ["fn", "detail", name, "--json"], {
          cwd: work,
          encoding: "utf8",
        });
        return JSON.parse(raw.slice(raw.indexOf("{"))).data?.Triggers || [];
      };
      const desired = maintenanceTrigger(),
        existing = readTriggers();
      const cronOf = (t) =>
        t.TriggerDesc?.startsWith("{")
          ? JSON.parse(t.TriggerDesc).cron
          : t.TriggerDesc;
      for (const trigger of existing.filter(
        (t) =>
          t.TriggerName.startsWith("maintenance-") &&
          (t.TriggerName !== desired || cronOf(t) !== MAINTENANCE_CRON),
      ))
        execFileSync(
          "tcb",
          ["fn", "trigger", "delete", name, trigger.TriggerName],
          { cwd: work, stdio: "inherit" },
        );
      if (
        !existing.some(
          (t) => t.TriggerName === desired && cronOf(t) === MAINTENANCE_CRON,
        )
      )
        execFileSync("tcb", ["fn", "trigger", "create", name], {
          cwd: work,
          stdio: "inherit",
        });
      if (
        !readTriggers().some(
          (t) => t.TriggerName === desired && cronOf(t) === MAINTENANCE_CRON,
        )
      )
        throw Error("维护触发器读回不一致");
      console.log("cloud-maintenance 定时触发器已核对");
    }

    if (name === "agent-expiry") {
      const detailText = execFileSync("tcb", ["fn", "detail", name, "--json"], {
        cwd: work,
        encoding: "utf8",
      });
      const detail = JSON.parse(detailText.slice(detailText.indexOf("{")));
      const existing = (detail.data?.Triggers || []).find(
        (t) => t.TriggerName === "agent-order-expiry",
      );
      const cron = existing?.TriggerDesc?.startsWith("{")
        ? JSON.parse(existing.TriggerDesc).cron
        : existing?.TriggerDesc;
      // 频率以本脚本为准：现有触发器 Cron 不同就先删后建，删除失败则不再创建。
      if (existing && cron !== EXPIRY_CRON)
        execFileSync(
          "tcb",
          ["fn", "trigger", "delete", name, "agent-order-expiry"],
          { cwd: work, stdio: "inherit" },
        );
      if (!existing || cron !== EXPIRY_CRON)
        execFileSync("tcb", ["fn", "trigger", "create", name], {
          cwd: work,
          stdio: "inherit",
        });
    }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

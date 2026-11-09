#!/usr/bin/env node
/**
 * 部署云函数：node scripts/deploy-cloudfunctions.js [函数名...]（不传则部署全部）
 *
 * - 先同步 cloudfunctions/common 到各函数 shared/。
 * - 环境变量（API Key、OTP 密钥等）读本机 .local/cloudbase/functions.env，不进版本库。
 * - cloudbaserc.json 生成在系统临时目录，部署完删除，避免密钥落进仓库。
 * - 环境 ID 用 tcb 当前绑定的环境（tcb env use），不写进被跟踪文件。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const fnRoot = path.join(root, "cloudfunctions");
const envFile = path.join(root, ".local/cloudbase/functions.env");

// 各函数需要的环境变量；只下发必要的，缩小密钥暴露面
const FUNCTION_ENV = {
  auth: [
    "NODE_ENV",
    "SESSION_HOURS",
    "OTP_DEV_CODE",
    "OTP_HASH_KEY",
    "CLOUDBASE_API_KEY",
  ],
  shop: ["NODE_ENV", "CLOUDBASE_API_KEY"],
  "staff-stock": ["NODE_ENV", "CLOUDBASE_API_KEY", "WHOLESALE_DISCOUNT"],
  "staff-sales": ["NODE_ENV", "CLOUDBASE_API_KEY"],
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

execFileSync("node", [path.join(__dirname, "sync-cloudfunctions.js")], {
  stdio: "inherit",
});
const env = {
  AGENT_LOCK_MINUTES: "30",
  SHARE_HOURS: "72",
  WX_APP_ID: "",
  WX_APP_SECRET: "",
  WX_CODE_ENV_VERSION: "release",
  WX_CODE_CHECK_PATH: "true",
  REPAIR_INTERNAL_COST_POLICY: "capitalize",
  WHOLESALE_DISCOUNT: "0",
  STORAGE_TIMEOUT_MS: "12000",
  ...readEnv(),
};
const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : Object.keys(FUNCTION_ENV);
const envId = execFileSync("tcb", ["env", "list", "--json"], {
  encoding: "utf8",
});
const current = JSON.parse(envId.slice(envId.indexOf("{")))?.data?.[0]?.EnvId;
if (!current) throw new Error("tcb 未登录或没有可用环境");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "xiamu-fn-"));
try {
  const functions = names.map((name) => {
    if (!FUNCTION_ENV[name]) throw new Error(`未登记的函数：${name}`);
    const vars = {};
    for (const key of FUNCTION_ENV[name]) {
      if (env[key] === undefined)
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
      runtime: "Nodejs18.15",
      timeout: 10,
      handler: "index.main",
      installDependency: true,
      ignore: ["node_modules", "node_modules/**"],
      envVariables: vars,
    };
  });
  fs.writeFileSync(
    path.join(work, "cloudbaserc.json"),
    JSON.stringify(
      { envId: current, functionRoot: fnRoot, functions },
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

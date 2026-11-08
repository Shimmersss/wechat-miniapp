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
  auth: ["NODE_ENV", "SESSION_HOURS", "OTP_DEV_CODE", "OTP_HASH_KEY", "CLOUDBASE_API_KEY"],
  shop: ["NODE_ENV", "CLOUDBASE_API_KEY"],
};

function readEnv() {
  if (!fs.existsSync(envFile))
    throw new Error(`缺少 ${path.relative(root, envFile)}，格式为每行 KEY=VALUE`);
  const out = {};
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

execFileSync("node", [path.join(__dirname, "sync-cloudfunctions.js")], { stdio: "inherit" });
const env = readEnv();
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(FUNCTION_ENV);
const envId = execFileSync("tcb", ["env", "list", "--json"], { encoding: "utf8" });
const current = JSON.parse(envId.slice(envId.indexOf("{")))?.data?.[0]?.EnvId;
if (!current) throw new Error("tcb 未登录或没有可用环境");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "xiamu-fn-"));
try {
  const functions = names.map((name) => {
    if (!FUNCTION_ENV[name]) throw new Error(`未登记的函数：${name}`);
    const vars = {};
    for (const key of FUNCTION_ENV[name]) {
      if (env[key] === undefined) throw new Error(`${name} 缺少环境变量 ${key}`);
      vars[key] = env[key];
    }
    return {
      name,
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
    JSON.stringify({ envId: current, functionRoot: fnRoot, functions }, null, 2),
    { mode: 0o600 },
  );
  for (const name of names)
    execFileSync("tcb", ["fn", "deploy", name, "--force", "--dir", path.join(fnRoot, name)], {
      cwd: work,
      stdio: "inherit",
    });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

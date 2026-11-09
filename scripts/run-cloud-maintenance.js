#!/usr/bin/env node
/** 经官方Functions HTTP API管理端推进；服务密钥/定时器能力名仅在本机忽略目录及服务端。 */
const crypto = require("node:crypto");
const { variables, privateJSON, save } = require("./lib/cloud-verification");
async function invoke(options = {}) {
  const params = {
    Type: "Timer",
    TriggerName:
      "maintenance-" +
      crypto
        .createHmac("sha256", variables.MAINTENANCE_KEY)
        .update("timer-v1")
        .digest("hex")
        .slice(0, 32),
    ...(options.gc ? { RecheckGC: true } : {}),
    ...(options.restoreRun ? { RestoreRun: options.restoreRun } : {}),
  };
  const env = privateJSON("sms-config-before").envId;
  const r = await fetch(
    `https://${env}.api.tcloudbasegateway.com/v1/functions/cloud-maintenance`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + variables.CLOUDBASE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000),
    },
  );
  const result = await r.json();
  save("maintenance-last-invoke", result);
  if (!r.ok || result.code !== 0)
    throw Error(
      "维护函数执行未完成，HTTP " + r.status + "；请查本机原始记录及云端日志",
    );
  return result;
}
module.exports = { invoke };
if (require.main === module)
  invoke({ gc: process.argv.includes("--gc") })
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });

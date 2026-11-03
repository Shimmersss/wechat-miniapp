const { config } = require("./config");
const { buildApp } = require("./app");
async function main() {
  const cfg = config();
  const app = await buildApp(cfg);
  await app.listen({ host: cfg.host, port: cfg.port });
  console.log(`夏目数码 API 已启动：${cfg.publicOrigin}/api/v1`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => app.close().then(() => process.exit(0)));
}
main().catch((error) => {
  console.error("服务启动失败：", error.code || error.message);
  process.exitCode = 1;
});

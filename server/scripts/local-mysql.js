/** 本机开发 MySQL；专属目录与 3307，仅绑定 loopback，不修改已有 3306 服务。 */
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const local = path.join(root, ".local");
fs.mkdirSync(local, { recursive: true, mode: 0o700 });
const binary =
  process.env.MYSQLD_BIN ||
  path.join(
    execFileSync("brew", ["--prefix", "mysql"], { encoding: "utf8" }).trim(),
    "bin/mysqld",
  );
if (!fs.existsSync(path.join(local, "mysql/mysql.ibd"))) {
  fs.mkdirSync(path.join(local, "mysql"), { recursive: true, mode: 0o700 });
  execFileSync(binary, [
    "--no-defaults",
    "--initialize-insecure",
    `--datadir=${path.join(local, "mysql")}`,
    "--innodb-redo-log-capacity=104857600",
    "--innodb-buffer-pool-size=67108864",
    `--log-error=${path.join(local, "mysql-init.log")}`,
  ]);
}
const child = spawn(
  binary,
  [
    "--no-defaults",
    `--datadir=${path.join(local, "mysql")}`,
    `--socket=${path.join(local, "mysql.sock")}`,
    "--port=3307",
    "--bind-address=127.0.0.1",
    "--mysqlx=OFF",
    "--innodb-redo-log-capacity=104857600",
    "--innodb-buffer-pool-size=67108864",
    `--log-error=${path.join(local, "mysql.log")}`,
    `--pid-file=${path.join(local, "mysql.pid")}`,
    "--skip-name-resolve",
  ],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code || 0;
});

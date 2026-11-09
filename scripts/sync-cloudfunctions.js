#!/usr/bin/env node
/**
 * 把 cloudfunctions/common/ 与前后端共享常量复制到每个云函数的 shared/ 目录。
 * 云函数按目录单独打包，不能 require 目录外的文件；部署前必须先运行本脚本。
 * shared/ 是生成产物，已被 .gitignore 排除，不要手改。
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const fnRoot = path.join(root, "cloudfunctions");
const sources = [
  ...fs
    .readdirSync(path.join(fnRoot, "common"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(fnRoot, "common", f)),
  path.join(root, "miniprogram/constants/roles.js"),
  path.join(root, "miniprogram/constants/status.js"),
  path.join(root, "miniprogram/utils/template.js"),
  path.join(root, "miniprogram/utils/validate.js"),
];

for (const name of fs.readdirSync(fnRoot)) {
  const dir = path.join(fnRoot, name);
  if (name === "common" || !fs.existsSync(path.join(dir, "index.js"))) continue;
  const shared = path.join(dir, "shared");
  fs.rmSync(shared, { recursive: true, force: true });
  fs.mkdirSync(shared);
  for (const src of sources)
    fs.copyFileSync(src, path.join(shared, path.basename(src)));
  console.log(`${name}/shared ← ${sources.length} 个文件`);
}

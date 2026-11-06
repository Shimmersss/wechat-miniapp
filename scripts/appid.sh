#!/usr/bin/env bash
# AppID 只放本机：仓库里的 project.config.json 固定为占位 touristappid，
# 真实 AppID 写在 project.private.config.json（已 .gitignore，开发者工具会优先使用它）。
#
#   ./scripts/appid.sh             查看当前生效的 AppID
#   ./scripts/appid.sh wx…         设置本机 AppID（真机调试/预览用自己有开发者权限的那个）
#   ./scripts/appid.sh clear       去掉本机 AppID，回到占位（游客模式）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE="$ROOT/project.private.config.json"

node - "$PRIVATE" "${1:-show}" <<'EOF'
const fs = require('fs');
const [file, arg] = process.argv.slice(2);
const conf = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const save = () => fs.writeFileSync(file, JSON.stringify(conf, null, 2) + '\n');
if (arg === 'show') {
  console.log(conf.appid ? `本机 AppID：${conf.appid}` : '本机未设置 AppID，开发者工具使用占位 touristappid');
} else if (arg === 'clear') {
  delete conf.appid;
  save();
  console.log('已去掉本机 AppID');
} else if (/^wx[0-9a-f]{16}$/.test(arg)) {
  conf.appid = arg;
  save();
  console.log(`已设置本机 AppID：${arg}（重新编译或重启开发者工具后生效）`);
} else {
  console.error('用法: scripts/appid.sh [show|clear|wx开头的 AppID]');
  process.exit(1);
}
EOF

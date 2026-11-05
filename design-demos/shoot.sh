#!/usr/bin/env bash
# 把任一方案渲染成 PNG 截图（无头 Chrome，不开 GUI 窗口，不抢焦点）。
#
# 用法：
#   ./shoot.sh 01-retail-tool           # 默认 1800x1180
#   ./shoot.sh 02-candy 1800 1240       # 自定义画布尺寸
#
# 输出：<方案目录>/preview.png
set -euo pipefail
DIR="${1:?用法: ./shoot.sh <方案目录> [宽] [高]}"
W="${2:-1800}"
H="${3:-1180}"
[[ -d "$DIR" ]] || { echo "目录不存在: $DIR" >&2; exit 1; }
OUT="$(cd "$DIR" && pwd)/preview.png"
google-chrome --headless=new --disable-gpu --hide-scrollbars \
  --no-sandbox --disable-dev-shm-usage --allow-file-access-from-files \
  --force-device-scale-factor=2 \
  --window-size="${W},${H}" \
  --screenshot="$OUT" \
  --virtual-time-budget=6000 \
  "file://$(cd "$DIR" && pwd)/index.html" >/dev/null 2>&1
echo "已生成: $OUT"

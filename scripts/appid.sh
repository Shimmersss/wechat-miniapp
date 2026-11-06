#!/usr/bin/env bash
# AppID 切换：调试用真实 AppID，提交仓库用占位 AppID。
#
#   ./scripts/appid.sh           查看当前用的是哪个
#   ./scripts/appid.sh debug     切到调试 AppID（真机调试/预览用）
#   ./scripts/appid.sh repo      切到仓库 AppID（提交前用）
#
# 只改 project.config.json 的 appid 一行，其余内容原样保留。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$ROOT/project.config.json"

# 调试用（你本机真机调试、预览要用的 AppID）
DEBUG_APPID="wx6bb6b0674bdb37c0"
# 仓库用（提交到 GitHub 的 AppID，历史一直是这个）
REPO_APPID="wx1fb1655002985aeb"

[[ -f "$CONF" ]] || { echo "找不到 project.config.json：$CONF" >&2; exit 1; }

current() {
  grep -oE '"appid"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONF" | grep -oE 'wx[0-9a-zA-Z]+' | head -1
}

set_appid() {
  local target="$1"
  local now
  now="$(current)"
  if [[ "$now" == "$target" ]]; then
    echo "已经是 $target，无需修改"
    return 0
  fi
  # 用 perl 精确替换 appid 的值，保留原格式（缩进、换行风格）
  perl -pi -e "s/(\"appid\"\s*:\s*\")[^\"]*(\")/\${1}$target\${2}/" "$CONF"
  echo "已切换：$now → $target"
}

case "${1:-show}" in
  debug)
    set_appid "$DEBUG_APPID"
    echo "提示：重新编译或重启开发者工具后生效。"
    ;;
  repo)
    set_appid "$REPO_APPID"
    echo "提示：现在可以提交了（git status 里 project.config.json 应只剩其它改动）。"
    ;;
  show|"")
    now="$(current)"
    echo "当前 AppID：$now"
    if [[ "$now" == "$DEBUG_APPID" ]]; then
      echo "  → 调试模式（真机调试 / 预览用）"
    elif [[ "$now" == "$REPO_APPID" ]]; then
      echo "  → 仓库模式（准备提交）"
    else
      echo "  → 未知，既不是调试 ID 也不是仓库 ID"
    fi
    echo
    echo "调试：./scripts/appid.sh debug"
    echo "提交：./scripts/appid.sh repo"
    ;;
  *)
    echo "用法: $0 [show|debug|repo]" >&2
    exit 1
    ;;
esac

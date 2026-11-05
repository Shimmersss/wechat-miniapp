#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"

wait_for_api() {
  local attempt
  for attempt in {1..30}; do
    if curl --fail --silent --max-time 2 http://127.0.0.1:3000/api/v1/health; then
      printf '\n'
      return 0
    fi
    sleep 1
  done
  printf 'API did not become ready. Run %s logs for details.\n' "$0" >&2
  return 1
}

case "${1:-status}" in
  start)
    systemctl --user start xiamu-api.service
    wait_for_api
    ;;
  stop)
    systemctl --user stop xiamu-api.service xiamu-mysql.service
    ;;
  restart)
    systemctl --user restart xiamu-api.service
    wait_for_api
    ;;
  status)
    systemctl --user --no-pager --lines=3 status xiamu-api.service xiamu-mysql.service
    ;;
  logs)
    journalctl --user -u xiamu-api.service -u xiamu-mysql.service -n 50 -f
    ;;
  open)
    export CHOKIDAR_USEPOLLING="${CHOKIDAR_USEPOLLING:-1}"
    export CHOKIDAR_INTERVAL="${CHOKIDAR_INTERVAL:-1000}"
    exec "$HOME/.local/bin/wechat-devtools-cli" cli open --project "$project_dir"
    ;;
  *)
    printf 'Usage: %s {start|stop|restart|status|logs|open}\n' "$0" >&2
    exit 2
    ;;
esac

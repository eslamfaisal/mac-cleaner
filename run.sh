#!/usr/bin/env bash
# Restart the Mac Cleaner dashboard: free the port, then start fresh.
# Usage:  ./run.sh            (port 4545)
#         PORT=4600 ./run.sh  (custom port)
set -euo pipefail

cd "$(dirname "$0")"
PORT="${PORT:-4545}"

# Kill whatever is holding the port (previous run, stale node).
pids="$(lsof -ti "tcp:${PORT}" || true)"
if [ -n "$pids" ]; then
  echo "Freeing port ${PORT} (killing: ${pids})"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  # still alive? force it
  pids="$(lsof -ti "tcp:${PORT}" || true)"
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
fi

echo "Starting Mac Cleaner on http://127.0.0.1:${PORT}"
exec env PORT="$PORT" node server.js

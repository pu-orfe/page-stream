#!/bin/sh
set -eu

HOST=${COMPOSITOR_HOST:-compositor}
PORT1=${COMPOSITOR_PORT1:-10001}
PORT2=${COMPOSITOR_PORT2:-10002}
TIMEOUT=${COMPOSITOR_WAIT_TIMEOUT:-30}

wait_for_port() {
  host=$1; port=$2; timeout=$3
  i=0
  echo "waiting for ${host}:${port} (timeout ${timeout}s)"
  while :; do
    # Use bash /dev/tcp probe; fall back to nc if available
    if bash -c "cat < /dev/tcp/${host}/${port} >/dev/null 2>&1"; then
      echo "${host}:${port} reachable"
      return 0
    fi
    if command -v nc >/dev/null 2>&1; then
      if nc -z -w 1 ${host} ${port} >/dev/null 2>&1; then
        echo "${host}:${port} reachable (nc)"
        return 0
      fi
    fi
    i=$((i+1))
    if [ "$i" -ge "$timeout" ]; then
      echo "timeout waiting for ${host}:${port}" >&2
      return 1
    fi
    sleep 1
  done
}

wait_for_port "$HOST" "$PORT1" "$TIMEOUT" || true
wait_for_port "$HOST" "$PORT2" "$TIMEOUT" || true

# Ensure Xvfb is running on the requested DISPLAY before starting the app
DISPLAY=${DISPLAY:-:99}
if ! pgrep Xvfb >/dev/null 2>&1; then
  echo "Starting Xvfb on ${DISPLAY}"
  Xvfb ${DISPLAY} -screen 0 ${WIDTH:-960}x${HEIGHT:-1080}x24 -ac +extension RANDR +extension GLX 2>/dev/null &
  # give Xvfb a moment to initialize
  i=0
  while ! pgrep Xvfb >/dev/null 2>/dev/null && [ "$i" -lt 5 ]; do
    sleep 0.2
    i=$((i+1))
  done
fi

# Exec the original entrypoint but tell it to skip starting Xvfb (we already did)
export SKIP_XVFB=1
exec bash /out/scripts/entrypoint.sh "$@"

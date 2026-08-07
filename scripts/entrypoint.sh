#!/bin/env bash
set -euo pipefail

if [[ "${DEBUG:-}" != "" ]]; then
  set -x
fi

# Unified background process cleanup
cleanup_pids=()
cleanup() {
  echo "[entrypoint] Cleaning up background processes..." >&2
  for pid in "${cleanup_pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  # Remove our own X lock so a restart of this container starts clean. This covers the
  # graceful paths; the startup check above covers SIGKILL, where no trap runs at all.
  if [[ -n "${XVFB_NUM:-}" ]]; then
    rm -f "/tmp/.X${XVFB_NUM}-lock" "/tmp/.X11-unix/X${XVFB_NUM}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ $# -eq 0 ]]; then
  echo "Usage: page-stream --ingest <SRT/RTMP URI> [--url <page>] [options...]"
fi

# Forward refresh requests: touch /tmp/refresh or kill -HUP <pid>
REFRESH_FIFO=/tmp/page_refresh_fifo
if [[ ! -p "$REFRESH_FIFO" ]]; then
  mkfifo "$REFRESH_FIFO"
fi

LIGHT_NOVNC=${LIGHTWEIGHT_NOVNC:-0}

# SKIP_XVFB: when set to "1" the entrypoint will NOT start Xvfb. This
# is useful for wrapper scripts that start Xvfb themselves (avoids duplicate
# Xvfb processes and races). Default behavior (unset or not "1") is to
# start Xvfb as before.
#
# VIDEO_FILE: when set, we're in direct video file mode and don't need Xvfb.
# Also check CLI args for --video-file flag.
video_file_mode=0
if [[ -n "${VIDEO_FILE:-}" ]]; then
  video_file_mode=1
fi
# Check CLI args for --video-file
for arg in "$@"; do
  if [[ "$arg" == "--video-file" ]]; then
    video_file_mode=1
    break
  fi
done

if [[ "$video_file_mode" = "1" ]]; then
  echo "[entrypoint] Video file mode detected, skipping Xvfb"
elif [[ "${SKIP_XVFB:-}" = "1" ]]; then
  echo "[entrypoint] SKIP_XVFB=1 detected, not starting Xvfb in entrypoint"
  XVFB_W=${WIDTH:-1280}
  XVFB_H=${HEIGHT:-720}
  XVFB_D=${DISPLAY:-:99}
else
  if [[ "$LIGHT_NOVNC" != "1" ]]; then
    # Launch Xvfb background (normal mode)
    XVFB_W=${WIDTH:-1280}
    XVFB_H=${HEIGHT:-720}
    XVFB_D=${DISPLAY:-:99}
    # Clear a stale X lock before starting.
    #
    # `restart: unless-stopped` restarts the SAME container, so /tmp survives. When the
    # container is killed ungracefully - which is exactly what an OS reboot does - Xvfb
    # leaves /tmp/.X<N>-lock and /tmp/.X11-unix/X<N> behind. On the next start Xvfb sees
    # the lock, refuses the display, and the container enters a restart loop that never
    # heals on its own. This was the post-reboot failure: 11 restarts, every one of them
    # dying on the same orphaned lock.
    #
    # The lock is only removed when nothing is actually listening on the display, so a
    # genuinely running Xvfb is never disturbed.
    XVFB_NUM="${XVFB_D#:}"; XVFB_NUM="${XVFB_NUM%%.*}"
    XVFB_LOCK="/tmp/.X${XVFB_NUM}-lock"
    XVFB_SOCK="/tmp/.X11-unix/X${XVFB_NUM}"
    if [[ -e "$XVFB_LOCK" || -e "$XVFB_SOCK" ]]; then
      if xdpyinfo -display "$XVFB_D" >/dev/null 2>&1; then
        echo "[entrypoint] Display $XVFB_D is already live; leaving its lock alone" >&2
      else
        echo "[entrypoint] Removing stale X lock for $XVFB_D (no server is listening)" >&2
        echo "[entrypoint]   this is normal after an ungraceful stop, e.g. a host reboot" >&2
        rm -f "$XVFB_LOCK" "$XVFB_SOCK" || true
      fi
    fi

    # Keep Xvfb's stderr. It was previously sent to /dev/null, which discarded the one
    # message that explains this failure ("Server is already active for display N ... remove
    # /tmp/.X<N>-lock") and left only a generic timeout to debug from.
    XVFB_LOG="/tmp/xvfb-${XVFB_NUM}.log"
    Xvfb $XVFB_D -screen 0 ${XVFB_W}x${XVFB_H}x24 -ac +extension RANDR +extension GLX \
      >"$XVFB_LOG" 2>&1 &
    XVFB_PID=$!; cleanup_pids+=("$XVFB_PID")

    # Wait for Xvfb to be ready before continuing
    echo "[entrypoint] Waiting for Xvfb display $XVFB_D to be ready..." >&2
    for i in {1..600}; do
      if xdpyinfo -display "$XVFB_D" >/dev/null 2>&1; then
        echo "[entrypoint] Xvfb ready (after ${i} attempts)" >&2
        break
      fi
      # Fail fast if Xvfb has already died: waiting the full 60s for a process that exited
      # in the first second just delays the restart and muddies the logs.
      if ! kill -0 "$XVFB_PID" 2>/dev/null; then
        echo "[entrypoint] ERROR: Xvfb exited immediately. Its output was:" >&2
        sed 's/^/[xvfb] /' "$XVFB_LOG" >&2 || true
        exit 1
      fi
      sleep 0.1
      if [[ $i -eq 600 ]]; then
        echo "[entrypoint] ERROR: Xvfb failed to start within 60 seconds. Its output was:" >&2
        sed 's/^/[xvfb] /' "$XVFB_LOG" >&2 || true
        exit 1
      fi
    done
  else
    # In lightweight mode we don't start Xvfb or browser (test mode should skip heavy startup anyway)
    echo "[lightweight] Skipping Xvfb (test mode)"
  fi
fi

# Optional noVNC stack
if [[ "${ENABLE_NOVNC:-0}" == "1" ]]; then
  echo "[noVNC] Enabling VNC + web socket bridge (port 6080)"
  if [[ "$LIGHT_NOVNC" == "1" ]]; then
    # Lightweight fallback server (HTTP only) for host-based tests without websockify/x11vnc
    node -e 'require("http").createServer((req,res)=>{res.writeHead(200,{"Content-Type":"text/plain"});res.end("noVNC test placeholder\n");}).listen(6080,"127.0.0.1",()=>console.error("[noVNC] fallback HTTP started (lightweight)"));' &
    FALLBACK_PID=$!; cleanup_pids+=("$FALLBACK_PID")
  else
    # Start x11vnc and websockify if available
    x11vnc -display ${XVFB_D:-:99} -nopw -forever -shared -rfbport 5900 -localhost &
    X11VNC_PID=$!; cleanup_pids+=("$X11VNC_PID")
    if command -v websockify >/dev/null 2>&1; then
      websockify --web /usr/share/novnc/ 6080 localhost:5900 &
      WEBSOCKIFY_PID=$!; cleanup_pids+=("$WEBSOCKIFY_PID")
      # Provide a redirecting index that auto-connects using empty path (some noVNC versions default to /websockify which 404s in our setup)
      cat > /usr/share/novnc/index.html <<'REDIR'
<!doctype html><html><head><meta charset="utf-8"><title>noVNC Redirect</title></head><body>
<p>Redirecting to noVNC...</p>
<script>
  const host = location.hostname;
  const port = location.port || '6080';
  // Explicit empty path parameter ensures websocket uses root ('') instead of default 'websockify'
  const target = `vnc.html?autoconnect=1&host=${host}&port=${port}&path=`;
  location.replace(target);
</script>
</body></html>
REDIR
    else
      echo "[noVNC] WARNING: websockify not found, using lightweight fallback"
      node -e 'require("http").createServer((req,res)=>{res.writeHead(200,{"Content-Type":"text/plain"});res.end("noVNC fallback (no websockify)\n");}).listen(6080,"127.0.0.1",()=>console.error("[noVNC] fallback HTTP started"));' &
      FALLBACK_PID=$!; cleanup_pids+=("$FALLBACK_PID")
    fi
  fi
  # Readiness probe (works for both real and fallback)
  for i in {1..60}; do
    # Open a TCP connection using bash's /dev/tcp without leaving a stale subshell FD.
    if { exec 3<>/dev/tcp/127.0.0.1/6080; } 2>/dev/null; then
      # Minimal HTTP request; ignore write errors.
      printf 'GET / HTTP/1.0\r\n\r\n' >&3 || true
      sleep 0.1
      exec 3>&- || true
      echo "[noVNC] ready (after ${i} attempts)" >&2
      if [[ "${EXIT_AFTER_READY:-0}" == "1" && "${LIGHTWEIGHT_NOVNC:-0}" == "1" ]]; then
        echo "[noVNC] exiting after readiness (test mode)" >&2
        sleep 0.1
        exit 0
      fi
      break
    fi
    sleep 0.25
    if [[ $i -eq 60 ]]; then
      echo "[noVNC] WARNING: readiness probe timed out" >&2
    fi
  done
fi

# If per-container inject environment variables are set, append them to the
# arguments passed to the node process. This keeps compose files simple and
# avoids having to craft complex conditional command lines in docker-compose.
#
# Supports variables named like: STANDARD_1_INJECT_CSS, SOURCE_LEFT_INJECT_JS,
# etc. For each non-empty *_INJECT_CSS / *_INJECT_JS we append the corresponding
# --inject-css / --inject-js option. This also remains backwards-compatible
# with the older single INJECT_CSS / INJECT_JS env vars.

# Determine a single CSS injection source.
# Priority: explicit INJECT_CSS env var > first non-empty *_INJECT_CSS found in environment.
inject_css_val=""
if [[ -n "${INJECT_CSS:-}" ]]; then
  inject_css_val="${INJECT_CSS}"
  echo "[entrypoint] INJECT_CSS detected, will inject --inject-css ${inject_css_val}" >&2
else
  css_found=()
  for name in $(compgen -v); do
    case "$name" in
      *_INJECT_CSS)
        val="${!name:-}"
        if [[ -n "$val" ]]; then
          css_found+=("$name:$val")
        fi
        ;;
    esac
  done
  if [[ ${#css_found[@]} -gt 0 ]]; then
    # Use the first found value; warn if multiple present
    first="${css_found[0]}"
    inject_css_val="${first#*:}"
    echo "[entrypoint] Found per-container INJECT_CSS env(s): ${css_found[*]}. Using ${inject_css_val}" >&2
    if [[ ${#css_found[@]} -gt 1 ]]; then
      echo "[entrypoint] WARNING: multiple *_INJECT_CSS variables set; only the first will be used" >&2
    fi
  fi
fi
if [[ -n "$inject_css_val" ]]; then
  set -- "$@" "--inject-css" "$inject_css_val"
fi

# Determine a single JS injection source (same priority as CSS)
inject_js_val=""
if [[ -n "${INJECT_JS:-}" ]]; then
  inject_js_val="${INJECT_JS}"
  echo "[entrypoint] INJECT_JS detected, will inject --inject-js ${inject_js_val}" >&2
else
  js_found=()
  for name in $(compgen -v); do
    case "$name" in
      *_INJECT_JS)
        val="${!name:-}"
        if [[ -n "$val" ]]; then
          js_found+=("$name:$val")
        fi
        ;;
    esac
  done
  if [[ ${#js_found[@]} -gt 0 ]]; then
    first="${js_found[0]}"
    inject_js_val="${first#*:}"
    echo "[entrypoint] Found per-container INJECT_JS env(s): ${js_found[*]}. Using ${inject_js_val}" >&2
    if [[ ${#js_found[@]} -gt 1 ]]; then
      echo "[entrypoint] WARNING: multiple *_INJECT_JS variables set; only the first will be used" >&2
    fi
  fi
fi
if [[ -n "$inject_js_val" ]]; then
  set -- "$@" "--inject-js" "$inject_js_val"
fi

# Start node process
node dist/index.js "$@" &
APP_PID=$!

# Optional Healthchecks.io support
if [[ -n "${HEALTHCHECKS_IO_URL:-}" ]]; then
  echo "[entrypoint] Healthchecks.io URL detected. Starting background ping daemon..." >&2
  (
    # Wait for the main process to warm up
    sleep 10
    interval=${HEALTHCHECKS_IO_INTERVAL_SECONDS:-60}
    while kill -0 "$APP_PID" 2>/dev/null; do
      if command -v curl &>/dev/null; then
        curl -s -m 10 -o /dev/null --retry 3 "${HEALTHCHECKS_IO_URL}" || true
      elif command -v wget &>/dev/null; then
        wget -q -T 10 -O /dev/null --tries=3 "${HEALTHCHECKS_IO_URL}" || true
      fi
      sleep "$interval"
    done
    
    # If we reached here, APP_PID exited. Check exit status.
    wait "$APP_PID" && exit_status=$? || exit_status=$?
    if [[ $exit_status -ne 0 ]]; then
      echo "[healthchecks] Main process exited with status $exit_status. Sending failure signal to healthchecks.io..." >&2
      if command -v curl &>/dev/null; then
        curl -s -m 10 -o /dev/null --retry 3 "${HEALTHCHECKS_IO_URL}/fail" || true
      elif command -v wget &>/dev/null; then
        wget -q -T 10 -O /dev/null --tries=3 "${HEALTHCHECKS_IO_URL}/fail" || true
      fi
    fi
  ) &
  HC_PING_PID=$!; cleanup_pids+=("$HC_PING_PID")
fi

# Relay HUP to refresh
while true; do
  if read line < "$REFRESH_FIFO"; then
    echo "Received refresh request via fifo" >&2
    kill -HUP "$APP_PID" || true
  fi
done &
FIFO_LOOP_PID=$!; cleanup_pids+=("$FIFO_LOOP_PID")

# When container receives HUP -> refresh
trap 'echo "Container caught HUP -> refreshing"; kill -HUP $APP_PID' HUP
# Graceful stop
trap 'echo "Stopping..."; kill -TERM $APP_PID; wait $APP_PID || true; exit 0' TERM INT

wait $APP_PID

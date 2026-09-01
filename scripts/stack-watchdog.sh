#!/usr/bin/env bash
# stack-watchdog.sh — one check for the whole stack, with detail when it breaks.
#
# WHY THIS EXISTS ALONGSIDE THE PER-CONTAINER PINGS
#
# entrypoint.sh can ping Healthchecks.io per container (HEALTHCHECKS_IO_URL), which is a
# fine liveness signal but has three gaps that mattered during the August 2026 reboot loop:
#
#   1. It needs one check and one secret per channel - seven of each - and in practice none
#      of them were ever configured, so the feature sat inert and nobody was told anything.
#   2. It reports only on the app process. A container that is up but UNHEALTHY (Xvfb dead,
#      ffmpeg gone) still pings happily right up until the process exits.
#   3. It cannot report that Colima or the host itself is down, because it runs inside the
#      very thing that is missing.
#
# This runs on the HOST, checks everything at once, and is a dead-man's switch: if the Mac
# is off or Colima is down, the pings simply stop and Healthchecks.io raises the alarm.
# Resend then carries the detail Healthchecks.io cannot - which containers, restart counts,
# and the first real error line.
#
#   scripts/stack-watchdog.sh              # check once, notify if unhealthy
#   scripts/stack-watchdog.sh --dry-run    # print what it would report, send nothing
#   scripts/stack-watchdog.sh --test-alert # force a failure notification, to prove wiring
#
# Configuration (all optional; each channel is skipped if unset):
#   HEALTHCHECKS_STACK_URL   e.g. https://hc-ping.com/<uuid>   dead-man's switch
#   RESEND_API_KEY           re_...                            detail email
#   RESEND_TO                ops@example.edu                   comma-separated
#   RESEND_FROM              relay-alerts@orfe.princeton.edu   must be a verified domain
#   WATCHDOG_EXPECTED        comma-separated container names to require
set -uo pipefail

DRY_RUN=0
TEST_ALERT=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=1 ;;
    --test-alert) TEST_ALERT=1 ;;
    -h|--help)    sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# launchd does NOT inherit an interactive shell's PATH, and `bash -lc` only reads bash
# profiles - so a PATH set in ~/.zshrc (the macOS default shell) is invisible here. On the
# ORFE runner Homebrew lives at ~/.homebrew, which is not on any default PATH at all. The
# result was a watchdog that could not find `docker`, concluded Colima was down, and paged
# about a perfectly healthy stack.
for _bindir in "$HOME/.homebrew/bin" /opt/homebrew/bin /usr/local/bin /usr/bin /bin; do
  [ -d "$_bindir" ] && case ":$PATH:" in *":$_bindir:"*) ;; *) PATH="$_bindir:$PATH" ;; esac
done
export PATH
unset _bindir

HC_URL="${HEALTHCHECKS_STACK_URL:-}"
# Normalise: a pasted trailing slash would make the failure ping "<url>//fail", which
# 404s silently - so the one signal that matters most would simply never arrive.
HC_URL="${HC_URL%/}"
RESEND_KEY="${RESEND_API_KEY:-}"
RESEND_TO="${RESEND_TO:-}"
RESEND_FROM="${RESEND_FROM:-}"
# `-` not `:-`: only an UNSET variable falls back to the built-in list. If the deploy set it
# to an empty string that is a rendering fault, and quietly substituting a list that names
# every channel - including any deliberately disabled one - is exactly the false alarm this
# script exists to avoid. Distinguish the two cases and say which happened.
EXPECTED="${WATCHDOG_EXPECTED-standard-1,standard-2,standard-3,standard-4,standard-5,standard-6,compositor}"
EXPECTED_EMPTY=0
if [ -z "$EXPECTED" ]; then
  EXPECTED_EMPTY=1
  echo "[watchdog] WATCHDOG_EXPECTED is set but empty — nothing to check. Re-run" >&2
  echo "[watchdog] tools/render-config.py <dept>; the deploy derives it from channels.yml." >&2
fi

HOSTNAME_SHORT=$(hostname -s 2>/dev/null || echo unknown)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

problems=()
detail=""
add_detail() { detail="${detail}$1"$'\n'; }

# --- 1. Is the container runtime even alive? --------------------------------------------
# Checked first: if Colima is down every other symptom is downstream of it, and reporting
# seven unhealthy containers would bury the one fact that matters.
if ! command -v docker >/dev/null 2>&1; then
  # A MISSING BINARY IS NOT A DOWN STACK. Reporting it as one is a false alarm, and a
  # watchdog that cries wolf gets muted - at which point it is worse than no watchdog.
  problems+=("watchdog misconfigured: docker not on PATH")
  add_detail "WATCHDOG PROBLEM (not necessarily a stack problem):"
  add_detail "  'docker' is not on PATH, so the stack could not be inspected at all."
  add_detail "  PATH=$PATH"
  add_detail "  The stack itself may well be fine. Fix the watchdog's environment first."
elif ! docker info >/dev/null 2>&1; then
  problems+=("docker/colima unreachable")
  add_detail "CRITICAL: docker is installed but not responding — Colima is down or did not"
  add_detail "start at boot."
  add_detail ""
  if command -v colima >/dev/null 2>&1; then
    add_detail "$(colima status 2>&1 | head -5)"
  else
    add_detail "(colima binary not on PATH, so its status could not be read)"
  fi
else
  # --- 2. Every expected container present, running and healthy -------------------------
  IFS=',' read -ra want <<< "$EXPECTED"
  # ${want[@]+...} guards the expansion: an empty EXPECTED leaves `want` unset, and under
  # `set -u` bash 3.2 (the macOS default, which is what the runner has) aborts on "${want[@]}"
  # rather than iterating zero times. That would kill the watchdog mid-run with a bash error
  # and no notification at all - the one failure mode a monitor must never have.
  for c in ${want[@]+"${want[@]}"}; do
    [ -n "$c" ] || continue
    if ! docker inspect "$c" >/dev/null 2>&1; then
      problems+=("$c missing")
      add_detail "$c: NOT PRESENT (never created, or removed)"
      continue
    fi
    state=$(docker inspect "$c" --format '{{.State.Status}}' 2>/dev/null)
    health=$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null)
    restarts=$(docker inspect "$c" --format '{{.RestartCount}}' 2>/dev/null)

    # A high restart count is worth flagging even when the container is momentarily up:
    # that is precisely what a crash loop looks like at any single instant.
    looping=0
    [ "${restarts:-0}" -ge 5 ] && looping=1

    if [ "$state" != "running" ] || { [ "$health" != "healthy" ] && [ "$health" != "none" ]; } || [ "$looping" = "1" ]; then
      problems+=("$c ${state}/${health}${looping:+ restarts=$restarts}")
      add_detail "$c: state=$state health=$health restarts=$restarts"

      # The probe output names WHICH dependency died (Xvfb, chrome or ffmpeg). The status
      # alone never does, and that distinction is the whole diagnosis.
      probe=$(docker inspect "$c" --format '{{if .State.Health}}{{range .State.Health.Log}}{{.Output}}{{end}}{{end}}' 2>/dev/null | tail -c 300 | tr -d '\r')
      [ -n "$probe" ] && add_detail "    last probe: ${probe}"

      # First genuine error line from the logs, with credentials stripped. Ingest URLs
      # carry the stream password, and this text goes into an email.
      err=$(docker logs --tail 200 "$c" 2>&1 \
        | grep -iE "error|fatal|failed|refused|denied" \
        | grep -viE "^\s*$" \
        | tail -3 \
        | sed -E -e 's#(srt://|rtmps?://)[^ "]*#\1<REDACTED>#g' \
                 -e 's/(streamid=)[^" ]*/\1<REDACTED>/g' \
                 -e 's/(passphrase=)[^"& ]*/\1<REDACTED>/g' || true)
      [ -n "$err" ] && add_detail "    log: ${err}"
      add_detail ""
    fi
  done
fi

# An empty expectation means every container check above was skipped, so "no problems" would
# be a lie: the run proves nothing. Report it as a watchdog fault, the same way a missing
# docker binary is - not as a down stack.
if [ "$EXPECTED_EMPTY" = "1" ]; then
  problems+=("watchdog misconfigured: WATCHDOG_EXPECTED is empty")
  add_detail "WATCHDOG PROBLEM (not necessarily a stack problem):"
  add_detail "  WATCHDOG_EXPECTED is empty, so no container was actually checked."
  add_detail "  The stack may well be fine. Fix the watchdog's configuration first:"
  add_detail "  it is rendered from channels.yml into <dept>/.env by tools/render-config.py."
fi

if [ "$TEST_ALERT" = "1" ]; then
  problems+=("forced test alert")
  add_detail "This is a TEST raised by --test-alert. The stack was not actually inspected."
fi

# --- 2b. Capacity ------------------------------------------------------------------------
# Every channel is an Xvfb + Chromium + ffmpeg pipeline encoding 1080p30, so its cost is
# roughly constant rather than bursty: how many channels a host can carry is arithmetic, and
# the useful moment to learn you are near the limit is long before frames start dropping.
#
# THIS IS NOT A STACK FAILURE. Being busy is not being broken, and flipping Healthchecks.io
# to down for it would make a capacity warning indistinguishable from an outage - and train
# everyone to ignore both. So it never touches `problems`: it rides along in the success
# ping body and sends at most one email a day.
CPU_BUDGET="${WATCHDOG_CPU_BUDGET:-70}"
STATE_DIR="$HOME/Library/Application Support/page-stream"
CAPACITY_STAMP="$STATE_DIR/capacity-notified"
NOTIFY_EVERY_SEC="${WATCHDOG_CAPACITY_NOTIFY_SEC:-86400}"

capacity_note=""
over_budget=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CORES=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 0)
  # docker stats reports CPU as a percentage of ONE core, so the sum is divided by the core
  # count to get a share of the host. --no-stream takes a single sample.
  USED=$(docker stats --no-stream --format '{{.CPUPerc}}' 2>/dev/null \
    | tr -d '%' | awk '{s+=$1} END {printf "%.0f", s+0}')
  if [ "${CORES:-0}" -gt 0 ] && [ -n "$USED" ]; then
    PCT=$(awk -v u="$USED" -v c="$CORES" 'BEGIN {printf "%.0f", u/c}')
    capacity_note="cpu ${PCT}% of ${CORES} cores (budget ${CPU_BUDGET}%)"
    if [ "$PCT" -ge "$CPU_BUDGET" ]; then
      over_budget=1
      capacity_note="$capacity_note - AT OR OVER BUDGET"
    fi
  fi
fi
[ -n "$capacity_note" ] && echo "[watchdog] capacity: $capacity_note"

healthy=$([ ${#problems[@]} -eq 0 ] && echo yes || echo no)
summary="${#problems[@]} problem(s)"
[ "$healthy" = "yes" ] && summary="all channels healthy"

echo "[watchdog] $NOW host=$HOSTNAME_SHORT $summary"
[ -n "$detail" ] && printf '%s' "$detail"

if [ "$DRY_RUN" = "1" ]; then
  echo "[watchdog] --dry-run: no notifications sent"
  exit 0
fi

# --- 3. Healthchecks.io: the dead-man's switch ------------------------------------------
# Success pings on every healthy run. Silence - a dead host, a dead Colima, a dead cron -
# is itself the alarm, which is the one failure mode no on-host check can report.
if [ -n "$HC_URL" ]; then
  if [ "$healthy" = "yes" ]; then
    # A body on the success ping too: Healthchecks.io keeps it, so the capacity trend is
    # visible on the check's history without any of it counting as a failure.
    hc_code=$(printf '%s' "${capacity_note:-ok}" | curl -sS -m 15 --retry 3 -o /dev/null \
      -w '%{http_code}' --data-binary @- "$HC_URL" 2>/dev/null || echo 000)
    case "$hc_code" in
      200) echo "[watchdog] healthchecks.io: ok" ;;
      404) echo "[watchdog] healthchecks.io: 404 — HEALTHCHECKS_STACK_URL is wrong; the check is NOT armed" >&2 ;;
      000) echo "[watchdog] healthchecks.io: unreachable (network)" >&2 ;;
      *)   echo "[watchdog] healthchecks.io: unexpected HTTP $hc_code" >&2 ;;
    esac
  else
    # /fail flips the check immediately rather than waiting out the grace period.
    # The failure ping matters more than the success ping, so it gets the same specific
    # diagnosis: "FAILED" alone would leave you unable to tell a wrong URL from an outage.
    hc_code=$(printf '%s' "$detail" | curl -sS -m 15 --retry 3 -o /dev/null \
      -w '%{http_code}' --data-binary @- "${HC_URL}/fail" 2>/dev/null || echo 000)
    case "$hc_code" in
      200) echo "[watchdog] healthchecks.io: failure reported (detail attached)" ;;
      400|404) echo "[watchdog] healthchecks.io: HTTP $hc_code — HEALTHCHECKS_STACK_URL is wrong, so THIS ALERT DID NOT ARRIVE" >&2 ;;
      000) echo "[watchdog] healthchecks.io: unreachable — alert not delivered" >&2 ;;
      *)   echo "[watchdog] healthchecks.io: unexpected HTTP $hc_code — alert may not have arrived" >&2 ;;
    esac
  fi
else
  echo "[watchdog] HEALTHCHECKS_STACK_URL unset — no dead-man's switch configured" >&2
fi

# --- 4. Resend: the detail ---------------------------------------------------------------
# Only on failure. A healthy-run email every five minutes trains everyone to ignore it,
# which is worse than sending nothing.
if [ "$healthy" != "yes" ] && [ -n "$RESEND_KEY" ] && [ -n "$RESEND_TO" ] && [ -n "$RESEND_FROM" ]; then
  subject="[page-stream] ${#problems[@]} channel problem(s) on ${HOSTNAME_SHORT}"
  body="page-stream stack problem
host:     ${HOSTNAME_SHORT}
detected: ${NOW}

Problems:
$(printf '  - %s\n' "${problems[@]}")

Detail:
${detail}
Diagnostics (full capture, credentials redacted):
  gh workflow run diagnostics.yml --repo pu-orfe/page-stream-config
"
  # jq builds the JSON so newlines and quotes in log lines cannot break the payload.
  payload=$(jq -n --arg from "$RESEND_FROM" --arg to "$RESEND_TO" \
                  --arg subject "$subject" --arg text "$body" \
                  '{from:$from, to:($to|split(",")), subject:$subject, text:$text}')
  code=$(curl -fsS -m 20 -o /tmp/resend-resp.json -w '%{http_code}' \
    -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer ${RESEND_KEY}" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    echo "[watchdog] resend: email sent"
  else
    echo "[watchdog] resend: send FAILED (http $code) $(head -c 200 /tmp/resend-resp.json 2>/dev/null)" >&2
  fi
elif [ "$healthy" != "yes" ]; then
  echo "[watchdog] resend not configured — no detail email sent" >&2
fi

# --- 5. Capacity email, rate limited -----------------------------------------------------
# Once a day while the condition persists, not once every five minutes. A warning that
# repeats every run is a warning that gets filtered to a folder nobody opens.
if [ "$over_budget" = "1" ] && [ -n "$RESEND_KEY" ] && [ -n "$RESEND_TO" ] && [ -n "$RESEND_FROM" ]; then
  last=0
  [ -f "$CAPACITY_STAMP" ] && last=$(cat "$CAPACITY_STAMP" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ $((now - last)) -ge "$NOTIFY_EVERY_SEC" ]; then
    body="page-stream capacity notice
host:     ${HOSTNAME_SHORT}
observed: ${NOW}

${capacity_note}

Nothing is broken. Every channel is an Xvfb + Chromium + ffmpeg pipeline encoding 1080p30,
so cost per channel is near constant and this host is approaching the number of channels it
can carry. Adding another is a placement decision, not a tuning one:

  * page-stream-config/orfe/channels.yml -> hosts: registry and the per-channel host: field
  * moving a channel is one line, then a deploy

This notice is sent at most once every $((NOTIFY_EVERY_SEC / 3600))h while the condition holds."
    payload=$(jq -n --arg from "$RESEND_FROM" --arg to "$RESEND_TO" \
                    --arg subject "[page-stream] capacity ${PCT}% on ${HOSTNAME_SHORT}" \
                    --arg text "$body" \
                    '{from:$from, to:($to|split(",")), subject:$subject, text:$text}')
    code=$(curl -fsS -m 20 -o /dev/null -w '%{http_code}' \
      -X POST https://api.resend.com/emails \
      -H "Authorization: Bearer ${RESEND_KEY}" \
      -H "Content-Type: application/json" -d "$payload" 2>/dev/null || echo 000)
    if [ "$code" = "200" ]; then
      mkdir -p "$STATE_DIR" && printf '%s' "$now" > "$CAPACITY_STAMP"
      echo "[watchdog] capacity notice emailed"
    else
      echo "[watchdog] capacity notice FAILED (http $code)" >&2
    fi
  else
    echo "[watchdog] capacity over budget; already notified within the window"
  fi
elif [ "$over_budget" = "0" ]; then
  # Clear the stamp so the NEXT breach notifies immediately rather than waiting out a window
  # that started during a previous, unrelated one.
  rm -f "$CAPACITY_STAMP" 2>/dev/null || true
fi

# Exit non-zero on problems so launchd/cron logs and any wrapper can see it.
[ "$healthy" = "yes" ] || exit 1
exit 0

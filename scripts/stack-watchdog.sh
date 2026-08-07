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

HC_URL="${HEALTHCHECKS_STACK_URL:-}"
RESEND_KEY="${RESEND_API_KEY:-}"
RESEND_TO="${RESEND_TO:-}"
RESEND_FROM="${RESEND_FROM:-}"
EXPECTED="${WATCHDOG_EXPECTED:-standard-1,standard-2,standard-3,standard-4,standard-5,standard-6,compositor}"

HOSTNAME_SHORT=$(hostname -s 2>/dev/null || echo unknown)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

problems=()
detail=""
add_detail() { detail="${detail}$1"$'\n'; }

# --- 1. Is the container runtime even alive? --------------------------------------------
# Checked first: if Colima is down every other symptom is downstream of it, and reporting
# seven unhealthy containers would bury the one fact that matters.
if ! docker info >/dev/null 2>&1; then
  problems+=("docker/colima unreachable")
  add_detail "CRITICAL: docker is not responding — Colima is down or did not start at boot."
  add_detail ""
  add_detail "$(colima status 2>&1 | head -5)"
else
  # --- 2. Every expected container present, running and healthy -------------------------
  IFS=',' read -ra want <<< "$EXPECTED"
  for c in "${want[@]}"; do
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

if [ "$TEST_ALERT" = "1" ]; then
  problems+=("forced test alert")
  add_detail "This is a TEST raised by --test-alert. The stack was not actually inspected."
fi

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
    curl -fsS -m 15 --retry 3 -o /dev/null "$HC_URL" \
      && echo "[watchdog] healthchecks.io: ok" \
      || echo "[watchdog] healthchecks.io: ping FAILED (network?)" >&2
  else
    # /fail flips the check immediately rather than waiting out the grace period.
    printf '%s' "$detail" | curl -fsS -m 15 --retry 3 -o /dev/null \
      --data-binary @- "${HC_URL}/fail" \
      && echo "[watchdog] healthchecks.io: failure reported" \
      || echo "[watchdog] healthchecks.io: fail-ping FAILED" >&2
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

# Exit non-zero on problems so launchd/cron logs and any wrapper can see it.
[ "$healthy" = "yes" ] || exit 1
exit 0

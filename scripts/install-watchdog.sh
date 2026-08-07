#!/usr/bin/env bash
# install-watchdog.sh — run stack-watchdog.sh on a schedule via launchd.
#
# A LaunchAgent, not cron: launchd survives reboots, restarts the job if it dies, and runs
# as the logged-in user who owns the Colima VM (docker is per-user here, so a root
# LaunchDaemon could not see the socket at all).
#
#   scripts/install-watchdog.sh                 # install, 5-minute interval
#   scripts/install-watchdog.sh --interval 600  # every 10 minutes
#   scripts/install-watchdog.sh --uninstall
#
# Credentials are read from ~/.page-stream-watchdog.env, which this script creates with
# 0600 permissions if absent. They are deliberately NOT baked into the plist: plists are
# world-readable and end up in backups and support bundles.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
[ -t 1 ] || { RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; BOLD=''; NC=''; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="edu.princeton.orfe.page-stream.watchdog"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
ENV_FILE="$HOME/.page-stream-watchdog.env"
LOG_DIR="$HOME/Library/Logs/page-stream"
INTERVAL=300
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --interval)  INTERVAL="${2:?}"; shift ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)   sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

printf "${BLUE}${BOLD}======================================================================${NC}\n"
printf "${CYAN}${BOLD}            PAGE-STREAM STACK WATCHDOG INSTALLER                     ${NC}\n"
printf "${BLUE}${BOLD}======================================================================${NC}\n"

if [ "$UNINSTALL" = "1" ]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  printf "  ${GREEN}✓ watchdog removed${NC}\n"
  printf "  ${CYAN}·${NC} %s left in place (delete it yourself if you want the credentials gone)\n" "$ENV_FILE"
  exit 0
fi

printf "\n${BOLD}[1/4] Credentials${NC}\n"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'ENVEOF'
# page-stream watchdog configuration. Sourced by stack-watchdog.sh.
# Every value is optional; each notification channel is skipped when its vars are unset.

# Healthchecks.io — the dead-man's switch. Create a check with a period slightly LONGER
# than the watchdog interval and a grace of a few minutes, then paste its ping URL here.
# This is what tells you the Mac itself is off; nothing running on the Mac can.
HEALTHCHECKS_STACK_URL=

# Resend — carries the detail Healthchecks.io cannot: which channels, restart counts and
# the first real error line. RESEND_FROM must be on a domain verified in Resend.
RESEND_API_KEY=
RESEND_TO=
RESEND_FROM=

# Containers that must be present and healthy. Trim this if a channel is intentionally off,
# or the watchdog will page you about a channel you retired.
WATCHDOG_EXPECTED=standard-1,standard-2,standard-3,standard-4,standard-5,standard-6,compositor
ENVEOF
  chmod 600 "$ENV_FILE"
  printf "  ${YELLOW}⚠ created %s — fill it in, then re-run this script${NC}\n" "$ENV_FILE"
  printf "  ${CYAN}·${NC} it is chmod 600; the plist deliberately holds no secrets\n"
else
  chmod 600 "$ENV_FILE"
  set -a
  # shellcheck disable=SC1090  # path is user-supplied by design
  source "$ENV_FILE"
  set +a
  [ -n "${HEALTHCHECKS_STACK_URL:-}" ] \
    && printf "  ${GREEN}✓ Healthchecks.io configured${NC}\n" \
    || printf "  ${YELLOW}⚠ HEALTHCHECKS_STACK_URL unset — no dead-man's switch${NC}\n"
  if [ -n "${RESEND_API_KEY:-}" ] && [ -n "${RESEND_TO:-}" ] && [ -n "${RESEND_FROM:-}" ]; then
    printf "  ${GREEN}✓ Resend configured (to: %s)${NC}\n" "$RESEND_TO"
  else
    printf "  ${YELLOW}⚠ Resend incomplete — failures will not be emailed${NC}\n"
  fi
fi

printf "\n${BOLD}[2/4] Writing the LaunchAgent${NC}\n"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
# The job sources the env file at run time rather than embedding values, so rotating a key
# needs no reinstall - and no secret is ever written into a world-readable plist.
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>set -a; [ -f "${ENV_FILE}" ] &amp;&amp; . "${ENV_FILE}"; set +a; exec "${REPO_ROOT}/scripts/stack-watchdog.sh"</string>
  </array>
  <key>StartInterval</key><integer>${INTERVAL}</integer>
  <!-- Also run once at load, so a reboot is checked immediately rather than one interval
       later - the reboot is exactly when this stack is most likely to be broken. -->
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/watchdog.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/watchdog.err</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLISTEOF
printf "  ${GREEN}✓ %s${NC}\n" "$PLIST"
printf "  ${CYAN}·${NC} interval: %ss, plus one run at load\n" "$INTERVAL"

printf "\n${BOLD}[3/4] Loading${NC}\n"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  printf "  ${GREEN}✓ loaded via bootstrap${NC}\n"
elif launchctl load "$PLIST" 2>/dev/null; then
  printf "  ${GREEN}✓ loaded via legacy load${NC}\n"
else
  printf "  ${RED}✗ could not load the LaunchAgent${NC}\n"; exit 1
fi

printf "\n${BOLD}[4/4] Verifying${NC}\n"
sleep 2
if launchctl list | grep -q "$LABEL"; then
  printf "  ${GREEN}✓ registered with launchd${NC}\n"
else
  printf "  ${YELLOW}⚠ not visible in launchctl list yet${NC}\n"
fi
printf "\n"
printf "${BOLD}Next:${NC}\n"
printf "  test the wiring end to end:  %s/scripts/stack-watchdog.sh --test-alert\n" "$REPO_ROOT"
printf "  watch it run:                tail -f %s/watchdog.log\n" "$LOG_DIR"
printf "  remove it:                   %s --uninstall\n" "$0"
printf "\n"
printf "${YELLOW}Set the Healthchecks.io period LONGER than %ss, or a slow run will\n" "$INTERVAL"
printf "false-alarm before the next ping lands.${NC}\n"

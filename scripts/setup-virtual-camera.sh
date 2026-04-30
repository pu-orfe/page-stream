#!/usr/bin/env zsh
# Linux-only helper: load v4l2loopback so page-stream can write to a virtual camera.
#
# Usage:
#   sudo ./scripts/setup-virtual-camera.sh                # load with defaults
#   sudo ./scripts/setup-virtual-camera.sh --device 10 --label PageStream
#   sudo ./scripts/setup-virtual-camera.sh --status       # show currently loaded devices
#   sudo ./scripts/setup-virtual-camera.sh --teardown     # unload the module
#
# Defaults match what page-stream advertises in the README: a single virtual
# camera at /dev/video10 with the label "PageStream".

set -euo pipefail

DEVICE_NR="10"
LABEL="PageStream"
ACTION="load"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)
      DEVICE_NR="$2"
      shift 2
      ;;
    --label)
      LABEL="$2"
      shift 2
      ;;
    --status)
      ACTION="status"
      shift
      ;;
    --teardown|--unload)
      ACTION="teardown"
      shift
      ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: virtual camera support is Linux-only (requires the v4l2loopback kernel module)." >&2
  exit 1
fi

require_root() {
  if [[ "$(id -u)" != "0" ]]; then
    echo "ERROR: $1 requires root. Re-run with sudo." >&2
    exit 1
  fi
}

case "$ACTION" in
  status)
    if lsmod | grep -q '^v4l2loopback'; then
      echo "v4l2loopback is loaded."
      v4l2loopback_devices=$(ls /sys/devices/virtual/video4linux 2>/dev/null || true)
      if [[ -n "$v4l2loopback_devices" ]]; then
        for dev in $v4l2loopback_devices; do
          name_file="/sys/devices/virtual/video4linux/$dev/name"
          if [[ -f "$name_file" ]]; then
            printf "  /dev/%s -> %s\n" "$dev" "$(cat "$name_file")"
          else
            printf "  /dev/%s\n" "$dev"
          fi
        done
      fi
    else
      echo "v4l2loopback is NOT loaded."
    fi
    ;;
  teardown)
    require_root "--teardown"
    if lsmod | grep -q '^v4l2loopback'; then
      modprobe -r v4l2loopback
      echo "v4l2loopback unloaded."
    else
      echo "v4l2loopback was not loaded; nothing to do."
    fi
    ;;
  load)
    require_root "loading v4l2loopback"
    if ! modinfo v4l2loopback >/dev/null 2>&1; then
      echo "ERROR: v4l2loopback kernel module is not installed." >&2
      echo "  Debian/Ubuntu: sudo apt install v4l2loopback-dkms" >&2
      echo "  Fedora:        sudo dnf install v4l2loopback" >&2
      echo "  Arch:          sudo pacman -S v4l2loopback-dkms" >&2
      exit 1
    fi
    if lsmod | grep -q '^v4l2loopback'; then
      echo "v4l2loopback is already loaded; reloading to apply the requested device + label."
      modprobe -r v4l2loopback
    fi
    modprobe v4l2loopback \
      devices=1 \
      video_nr="$DEVICE_NR" \
      card_label="$LABEL" \
      exclusive_caps=1
    echo "Loaded v4l2loopback: /dev/video$DEVICE_NR (label: $LABEL)"
    echo
    echo "Use it with page-stream:"
    echo "  node dist/index.js --virtual-camera /dev/video$DEVICE_NR --url demo/index.html"
    ;;
esac

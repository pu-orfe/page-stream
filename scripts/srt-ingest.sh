#!/bin/sh
set -eu
mkdir -p /out
while true; do
  ffmpeg -hide_banner -loglevel info -nostdin -y -i "srt://0.0.0.0:9000?mode=listener" -c copy -f mpegts /out/composite.ts || true
  echo "SRT connection lost, retrying in 5 seconds..."
  sleep 5
done

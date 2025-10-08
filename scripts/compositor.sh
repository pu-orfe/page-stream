#!/bin/sh
set -eu
while true; do
  ffmpeg -hide_banner -loglevel info \
    -fflags +genpts+igndts \
    -thread_queue_size 64 -i "srt://0.0.0.0:10001?mode=listener&latency=10000" \
    -thread_queue_size 64 -i "srt://0.0.0.0:10002?mode=listener&latency=10000" \
    -filter_complex "[0:v]fps=30,setpts=N/FRAME_RATE/TB[v0];[1:v]fps=30,setpts=N/FRAME_RATE/TB[v1];[v0][v1]hstack=inputs=2[outv]" \
    -map "[outv]" -map 0:a \
    -async 1 -vsync cfr -r 30 \
    -c:v libx264 -preset ultrafast -tune zerolatency -b:v 3000k -maxrate 3500k -bufsize 6000k -g 30 -keyint_min 30 -sc_threshold 0 \
    -c:a aac -b:a 128k -ar 44100 \
    -f mpegts "${COMPOSITOR_INGEST:-srt://srt-ingest:9000?streamid=composite&latency=10000}" || true
  echo "Compositor stream ended, retrying in 5 seconds..."
  sleep 5
done

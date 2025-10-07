#!/bin/sh
set -eu
mkdir -p /out
ffmpeg -hide_banner -loglevel info -nostdin -y -thread_queue_size 64 -i "srt://0.0.0.0:9001?mode=listener" -c copy -f mpegts /out/std1.ts &
ffmpeg -hide_banner -loglevel info -nostdin -y -thread_queue_size 64 -i "srt://0.0.0.0:9002?mode=listener" -c copy -f mpegts /out/std2.ts &
ffmpeg -hide_banner -loglevel info -nostdin -y -thread_queue_size 64 -i "srt://0.0.0.0:9003?mode=listener" -c copy -f mpegts /out/std3.ts &
ffmpeg -hide_banner -loglevel info -nostdin -y -thread_queue_size 64 -i "srt://0.0.0.0:9004?mode=listener" -c copy -f mpegts /out/std4.ts &
wait

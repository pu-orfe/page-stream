import test from 'node:test';
import assert from 'node:assert/strict';
import { PageStreamer } from '../src/index.js';

test('buildFfmpegArgs includes INPUT_FFMPEG_FLAGS at input position', () => {
  // Set env var for this process; PageStreamer reads process.env
  process.env.INPUT_FFMPEG_FLAGS = '-thread_queue_size 512 -probesize 5M -analyzeduration 1M';
  const streamer = new PageStreamer({
    url: 'demo/index.html',
    ingest: 'file.ts',
    width: 960,
    height: 1080,
    fps: 30,
    preset: 'veryfast',
    videoBitrate: '2500k',
    audioBitrate: '128k',
    format: 'mpegts',
    extraFfmpeg: [],
    headless: false,
    fullscreen: true,
    appMode: true,
    reconnectAttempts: 0,
    reconnectInitialDelayMs: 1000,
    reconnectMaxDelayMs: 15000,
    healthIntervalSeconds: 0,
    autoRefreshSeconds: 0,
    suppressAutomationBanner: true,
    autoDismissInfobar: false,
    cropInfobar: 0,
  });
  const args = streamer.buildFfmpegArgs();
  // Check that the input flags appear before '-f','x11grab' in the args
  const vfIndex = args.indexOf('-f');
  assert.ok(vfIndex > 0, 'Expected -f to be present');
  const preInput = args.slice(0, vfIndex);
  assert.ok(preInput.includes('-thread_queue_size'), 'Expected thread_queue_size in input flags');
  assert.ok(preInput.includes('-probesize'), 'Expected probesize in input flags');
  assert.ok(preInput.includes('-analyzeduration'), 'Expected analyzeduration in input flags');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PageStreamer } from '../src/index.js';

// We run in PAGE_STREAM_TEST_MODE style by never calling start(); instead we instantiate and call internal method.
// buildFfmpegArgs is public enough for white-box verification.

test('ffmpeg args include crop filter when --crop-infobar set and no user filters provided', () => {
  const streamer = new PageStreamer({
    url: 'demo/index.html',
    ingest: 'file.ts',
    width: 1280,
    height: 720,
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
    cropInfobar: 40,
  });
  const args = streamer.buildFfmpegArgs();
  const vfIndex = args.indexOf('-vf');
  assert.ok(vfIndex > -1, 'Expected -vf to be inserted');
  const filter = args[vfIndex + 1];
  assert.match(filter, /crop=1280:680:0:40/, 'Expected crop filter with adjusted height');
});

test('crop filter skipped when user supplies -vf manually', () => {
  const streamer = new PageStreamer({
    url: 'demo/index.html',
    ingest: 'file.ts',
    width: 640,
    height: 360,
    fps: 30,
    preset: 'veryfast',
    videoBitrate: '1000k',
    audioBitrate: '128k',
    format: 'mpegts',
    extraFfmpeg: ['-vf','scale=640:360'],
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
    cropInfobar: 50,
  });
  const args = streamer.buildFfmpegArgs();
  // Ensure our scale filter remains and we did not insert another -vf later (ffmpeg would apply last one)
  const vfOccurrences = args.filter(a => a === '-vf').length;
  assert.equal(vfOccurrences, 1, 'Should have exactly one -vf (user provided)');
  const vfPos = args.indexOf('-vf');
  assert.equal(args[vfPos + 1], 'scale=640:360', 'User-provided filter should remain unchanged');
});

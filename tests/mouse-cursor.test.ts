import test from 'node:test';
import assert from 'node:assert/strict';
import { PageStreamer } from '../src/index.js';

test('buildFfmpegArgs disables mouse cursor drawing by default (-draw_mouse 0)', () => {
  delete process.env.DRAW_MOUSE;
  const streamer = new PageStreamer({
    url: 'demo/index.html',
    ingest: 'srt://127.0.0.1:9000?streamid=test',
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
    cropInfobar: 0,
    videoLoop: false,
  });
  const args = streamer.buildFfmpegArgs();
  const dmIdx = args.indexOf('-draw_mouse');
  assert.ok(dmIdx > -1, 'Expected -draw_mouse argument to be present');
  assert.equal(args[dmIdx + 1], '0', 'Expected -draw_mouse 0 by default');
});

test('buildFfmpegArgs enables mouse cursor drawing when drawMouse is true', () => {
  delete process.env.DRAW_MOUSE;
  const streamer = new PageStreamer({
    url: 'demo/index.html',
    ingest: 'srt://127.0.0.1:9000?streamid=test',
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
    cropInfobar: 0,
    videoLoop: false,
    drawMouse: true,
  });
  const args = streamer.buildFfmpegArgs();
  const dmIdx = args.indexOf('-draw_mouse');
  assert.ok(dmIdx > -1, 'Expected -draw_mouse argument to be present');
  assert.equal(args[dmIdx + 1], '1', 'Expected -draw_mouse 1 when drawMouse is true');
});

test('buildFfmpegArgs enables mouse cursor drawing when DRAW_MOUSE env var is set to 1', () => {
  process.env.DRAW_MOUSE = '1';
  try {
    const streamer = new PageStreamer({
      url: 'demo/index.html',
      ingest: 'srt://127.0.0.1:9000?streamid=test',
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
      cropInfobar: 0,
      videoLoop: false,
    });
    const args = streamer.buildFfmpegArgs();
    const dmIdx = args.indexOf('-draw_mouse');
    assert.ok(dmIdx > -1, 'Expected -draw_mouse argument to be present');
    assert.equal(args[dmIdx + 1], '1', 'Expected -draw_mouse 1 when DRAW_MOUSE=1');
  } finally {
    delete process.env.DRAW_MOUSE;
  }
});

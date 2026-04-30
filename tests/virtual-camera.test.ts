import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PageStreamer } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

// Tests for Linux v4l2loopback virtual camera output.

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number|null; stdout: string; stderr: string; }> {
  return new Promise(res => {
    const p = spawn('node', ['dist/index.js', ...args], {
      cwd: root,
      env: { ...process.env, PAGE_STREAM_TEST_MODE: '1', ...extraEnv },
    });
    let out = ''; let err = '';
    p.stdout?.on('data', d => out += d.toString());
    p.stderr?.on('data', d => err += d.toString());
    const killTimer = setTimeout(() => { try { p.kill('SIGINT'); } catch {} }, 800);
    const hardTimer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {}; res({ code: null, stdout: out, stderr: err }); }, 3000);
    p.on('close', code => { clearTimeout(killTimer); clearTimeout(hardTimer); res({ code, stdout: out, stderr: err }); });
  });
}

function makeStreamer(overrides: Partial<{
  ingest: string; videoFile: string; videoLoop: boolean;
  virtualCamera: string; virtualCameraPixFmt: string;
  width: number; height: number; fps: number;
}> = {}) {
  return new PageStreamer({
    url: 'demo/index.html',
    ingest: overrides.ingest ?? '',
    width: overrides.width ?? 1280,
    height: overrides.height ?? 720,
    fps: overrides.fps ?? 30,
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
    videoFile: overrides.videoFile,
    videoLoop: overrides.videoLoop ?? false,
    virtualCamera: overrides.virtualCamera,
    virtualCameraPixFmt: overrides.virtualCameraPixFmt ?? 'yuv420p',
  });
}

// =============================================================================
// CLI parsing
// =============================================================================

test('CLI requires either --ingest or --virtual-camera', async () => {
  const r = await runCli(['--url', 'demo/index.html']);
  assert.notEqual(r.code, 0, 'Expected non-zero exit when neither --ingest nor --virtual-camera is provided');
  assert.ok(/--ingest|--virtual-camera/.test(r.stderr + r.stdout), 'Expected error to mention required output target');
});

test('CLI accepts --virtual-camera without --ingest', async () => {
  const r = await runCli(['--virtual-camera', '/dev/video10']);
  const combined = r.stdout + r.stderr;
  assert.ok(/Streaming page/.test(combined), 'Expected streaming startup log');
  assert.ok(/virtual camera '\/dev\/video10'/.test(combined), 'Expected log to mention virtual camera target');
});

test('CLI accepts --virtual-camera together with --video-file', async () => {
  const tmpFile = path.join(os.tmpdir(), `pgstream-vc-${Date.now()}.mp4`);
  fs.writeFileSync(tmpFile, 'dummy video for vc test');
  try {
    const r = await runCli([
      '--virtual-camera', '/dev/video10',
      '--video-file', tmpFile,
    ]);
    const combined = r.stdout + r.stderr;
    assert.ok(/Streaming video file/.test(combined), 'Expected video file streaming log');
    assert.ok(/virtual camera '\/dev\/video10'/.test(combined), 'Expected log to mention virtual camera target');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// =============================================================================
// buildFfmpegArgs(): browser/x11grab input → v4l2 output
// =============================================================================

test('browser mode + virtual camera emits v4l2 output and skips libx264', () => {
  const streamer = makeStreamer({ virtualCamera: '/dev/video10' });
  const args = streamer.buildFfmpegArgs();

  assert.ok(args.includes('x11grab'), 'Browser mode should still use x11grab as input');

  // Output must be v4l2 with the device path as the muxed target
  const outFmtIdx = args.lastIndexOf('-f');
  assert.equal(args[outFmtIdx + 1], 'v4l2', 'Expected -f v4l2 for virtual camera output');
  assert.equal(args[args.length - 1], '/dev/video10', 'Expected device path as final arg');

  // Pixel format flag must be present
  const pixIdx = args.lastIndexOf('-pix_fmt');
  assert.ok(pixIdx > 0, 'Expected -pix_fmt to be set for v4l2 output');
  assert.equal(args[pixIdx + 1], 'yuv420p');

  // No streaming-protocol encoder/audio
  assert.ok(!args.includes('libx264'), 'Should not encode with libx264 when writing to v4l2');
  assert.ok(!args.includes('aac'), 'Should not include aac (v4l2 is video-only)');
  assert.ok(!args.includes('-b:v'), 'Should not set video bitrate for raw v4l2 output');
  assert.ok(!args.some(a => a.startsWith('anullsrc')), 'Should not add silent audio source for v4l2');
});

test('virtual camera honors custom --virtual-camera-pix-fmt', () => {
  const streamer = makeStreamer({ virtualCamera: '/dev/video10', virtualCameraPixFmt: 'yuyv422' });
  const args = streamer.buildFfmpegArgs();
  const pixIdx = args.lastIndexOf('-pix_fmt');
  assert.equal(args[pixIdx + 1], 'yuyv422');
});

// =============================================================================
// buildFfmpegArgs(): video-file input → v4l2 output
// =============================================================================

test('video file + virtual camera emits v4l2 output, drops audio', () => {
  const streamer = makeStreamer({ videoFile: '/path/to/video.mp4', virtualCamera: '/dev/video10' });
  const args = streamer.buildFfmpegArgs();

  // Input is the file
  const inputIdx = args.indexOf('-i');
  assert.equal(args[inputIdx + 1], '/path/to/video.mp4');

  // Output is v4l2 with the device
  const outFmtIdx = args.lastIndexOf('-f');
  assert.equal(args[outFmtIdx + 1], 'v4l2');
  assert.equal(args[args.length - 1], '/dev/video10');

  // No anullsrc, no libx264, no aac, no -b:v
  assert.ok(!args.some(a => /anullsrc/.test(a)), 'Should not append silent audio for v4l2 output');
  assert.ok(!args.includes('libx264'), 'Should not encode with libx264 for v4l2 output');
  assert.ok(!args.includes('aac'), 'Should not include aac for v4l2 output');
  assert.ok(!args.includes('-b:v'), 'Should not include -b:v for v4l2 output');

  // Should still scale/pad/fps for the target resolution
  const vfIdx = args.indexOf('-vf');
  assert.ok(vfIdx >= 0, 'Expected -vf filter chain');
  assert.ok(args[vfIdx + 1].includes('scale=1280:720'), 'Expected scale to target resolution');
});

test('video file + virtual camera + loop preserves -stream_loop ordering', () => {
  const streamer = makeStreamer({
    videoFile: '/path/to/video.mp4',
    videoLoop: true,
    virtualCamera: '/dev/video10',
  });
  const args = streamer.buildFfmpegArgs();
  const loopIdx = args.indexOf('-stream_loop');
  const inputIdx = args.indexOf('-i');
  assert.ok(loopIdx >= 0 && loopIdx < inputIdx, '-stream_loop should appear before -i');
  assert.equal(args[loopIdx + 1], '-1');
});

// =============================================================================
// Validation in start()
// =============================================================================

test('start() throws on non-Linux platforms when virtualCamera is set', async (t) => {
  const streamer = makeStreamer({ virtualCamera: '/dev/video10' });
  // Spoof process.platform
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  try {
    await assert.rejects(() => streamer.start(), /Linux-only/i);
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});

test('start() throws when the virtual camera device does not exist', async () => {
  if (process.platform !== 'linux') {
    // On non-Linux the platform check fires first, so this scenario can't be reached.
    return;
  }
  const streamer = makeStreamer({ virtualCamera: '/dev/definitely-not-a-real-device-xyz' });
  await assert.rejects(() => streamer.start(), /device not found|v4l2loopback/i);
});

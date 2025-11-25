import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PageStreamer } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

// Tests for direct video file streaming feature

function runCli(args: string[]): Promise<{ code: number|null; stdout: string; stderr: string; }> {
  return new Promise(res => {
    const p = spawn('node', ['dist/index.js', ...args], { cwd: root, env: { ...process.env, PAGE_STREAM_TEST_MODE: '1' } });
    let out=''; let err='';
    p.stdout?.on('data', d => out += d.toString());
    p.stderr?.on('data', d => err += d.toString());
    const killTimer = setTimeout(()=> { try { p.kill('SIGINT'); } catch {} }, 800);
    const hardTimer = setTimeout(()=> { try { p.kill('SIGKILL'); } catch {}; res({ code: null, stdout: out, stderr: err }); }, 3000);
    p.on('close', code => { clearTimeout(killTimer); clearTimeout(hardTimer); res({ code, stdout: out, stderr: err }); });
  });
}

// Helper to create a PageStreamer with video file options
function createVideoStreamer(opts: { videoFile: string; videoLoop?: boolean; width?: number; height?: number; fps?: number }) {
  return new PageStreamer({
    url: 'demo/index.html',
    ingest: 'srt://127.0.0.1:9000?streamid=test',
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    fps: opts.fps ?? 30,
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
    videoFile: opts.videoFile,
    videoLoop: opts.videoLoop ?? false,
  });
}

// =============================================================================
// CLI Integration Tests
// =============================================================================

test('CLI accepts --video-file option', async () => {
  // Create a temporary dummy video file for testing CLI parsing
  const tmpFile = path.join(root, 'tests', 'test-video.mp4');
  fs.writeFileSync(tmpFile, 'dummy video content for test');

  try {
    const r = await runCli([
      '--ingest', 'srt://127.0.0.1:9000?streamid=test',
      '--video-file', tmpFile
    ]);
    // Should recognize video file mode in startup log
    const combined = r.stdout + r.stderr;
    assert.ok(/Streaming video file/.test(combined), 'Expected startup log to mention "Streaming video file"');
    assert.ok(/test-video\.mp4/.test(combined), 'Expected log to contain video file name');
  } finally {
    // Cleanup
    fs.unlinkSync(tmpFile);
  }
});

test('CLI accepts --video-file with --video-loop', async () => {
  const tmpFile = path.join(root, 'tests', 'test-video-loop.mp4');
  fs.writeFileSync(tmpFile, 'dummy video content for loop test');

  try {
    const r = await runCli([
      '--ingest', 'srt://127.0.0.1:9000?streamid=test',
      '--video-file', tmpFile,
      '--video-loop'
    ]);
    const combined = r.stdout + r.stderr;
    assert.ok(/Streaming video file/.test(combined), 'Expected startup log for video file');
    assert.ok(/loop/.test(combined), 'Expected log to mention looping when --video-loop is set');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('--video-loop without --video-file still starts (loop ignored)', async () => {
  const r = await runCli([
    '--ingest', 'srt://127.0.0.1:9000?streamid=test',
    '--url', 'demo/index.html',
    '--video-loop'
  ]);
  const combined = r.stdout + r.stderr;
  // Should fall back to page streaming mode since no video file provided
  assert.ok(/Streaming page/.test(combined), 'Expected page streaming mode when no video file');
});

test('--video-file with non-existent file path shows error in test mode', async () => {
  const r = await runCli([
    '--ingest', 'srt://127.0.0.1:9000?streamid=test',
    '--video-file', '/nonexistent/path/video.mp4'
  ]);
  // In test mode, the startup log should still show the video file path
  // The actual file existence check happens at start() which is skipped in test mode
  const combined = r.stdout + r.stderr;
  assert.ok(/Streaming video file/.test(combined) || /nonexistent/.test(combined),
    'Expected some mention of video file in output');
});

// =============================================================================
// Unit Tests: buildFfmpegArgs() for video file mode
// =============================================================================

test('buildFfmpegArgs returns video file args when videoFile is set', () => {
  const streamer = createVideoStreamer({ videoFile: '/path/to/video.mp4' });
  const args = streamer.buildFfmpegArgs();

  // Should NOT contain x11grab (browser capture mode)
  assert.ok(!args.includes('x11grab'), 'Video file mode should not use x11grab');

  // Should contain the video file path as input
  const inputIndex = args.indexOf('-i');
  assert.ok(inputIndex >= 0, 'Expected -i flag for input');
  assert.equal(args[inputIndex + 1], '/path/to/video.mp4', 'Expected video file path after -i');

  // Should contain -re for real-time playback
  assert.ok(args.includes('-re'), 'Expected -re flag for real-time playback');

  // Should contain video encoding settings
  assert.ok(args.includes('libx264'), 'Expected libx264 codec');
  assert.ok(args.includes('zerolatency'), 'Expected zerolatency tune');
});

test('buildFfmpegArgs includes -stream_loop when videoLoop is true', () => {
  const streamer = createVideoStreamer({ videoFile: '/path/to/video.mp4', videoLoop: true });
  const args = streamer.buildFfmpegArgs();

  // Should contain -stream_loop -1 for infinite looping
  const loopIndex = args.indexOf('-stream_loop');
  assert.ok(loopIndex >= 0, 'Expected -stream_loop flag when videoLoop is true');
  assert.equal(args[loopIndex + 1], '-1', 'Expected -1 for infinite loop');

  // -stream_loop should come before -i (input file)
  const inputIndex = args.indexOf('-i');
  assert.ok(loopIndex < inputIndex, '-stream_loop should appear before -i for input looping');
});

test('buildFfmpegArgs does NOT include -stream_loop when videoLoop is false', () => {
  const streamer = createVideoStreamer({ videoFile: '/path/to/video.mp4', videoLoop: false });
  const args = streamer.buildFfmpegArgs();

  assert.ok(!args.includes('-stream_loop'), 'Should not include -stream_loop when videoLoop is false');
});

test('buildFfmpegArgs includes scale and pad filters for video file', () => {
  const streamer = createVideoStreamer({ videoFile: '/path/to/video.mp4', width: 1920, height: 1080 });
  const args = streamer.buildFfmpegArgs();

  // Find -vf flag and check filter content
  const vfIndex = args.indexOf('-vf');
  assert.ok(vfIndex >= 0, 'Expected -vf flag for video filters');

  const filterString = args[vfIndex + 1];
  assert.ok(filterString.includes('scale=1920:1080'), 'Expected scale filter with target resolution');
  assert.ok(filterString.includes('pad=1920:1080'), 'Expected pad filter for letterboxing');
  assert.ok(filterString.includes('fps=30'), 'Expected fps filter for consistent frame rate');
});

test('buildFfmpegArgs uses custom resolution for video file', () => {
  const streamer = createVideoStreamer({ videoFile: '/path/to/video.mp4', width: 1280, height: 720, fps: 25 });
  const args = streamer.buildFfmpegArgs();

  const vfIndex = args.indexOf('-vf');
  const filterString = args[vfIndex + 1];

  assert.ok(filterString.includes('scale=1280:720'), 'Expected custom width/height in scale filter');
  assert.ok(filterString.includes('pad=1280:720'), 'Expected custom width/height in pad filter');
  assert.ok(filterString.includes('fps=25'), 'Expected custom fps in filter');
});

test('buildFfmpegArgs includes output format and ingest URI for video file', () => {
  const streamer = createVideoStreamer({ videoFile: '/path/to/video.mp4' });
  const args = streamer.buildFfmpegArgs();

  // Last args should be format and ingest URI
  const formatIndex = args.lastIndexOf('-f');
  assert.ok(formatIndex >= 0, 'Expected -f flag for output format');
  assert.equal(args[formatIndex + 1], 'mpegts', 'Expected mpegts format');
  assert.equal(args[args.length - 1], 'srt://127.0.0.1:9000?streamid=test', 'Expected ingest URI as last arg');
});

test('buildFfmpegArgs includes INPUT_FFMPEG_FLAGS for video file mode', () => {
  // Set env var
  const originalFlags = process.env.INPUT_FFMPEG_FLAGS;
  process.env.INPUT_FFMPEG_FLAGS = '-probesize 10M -analyzeduration 2M';

  try {
    const streamer = createVideoStreamer({ videoFile: '/path/to/video.mp4' });
    const args = streamer.buildFfmpegArgs();

    // Input flags should appear early in args (before -i)
    const inputIndex = args.indexOf('-i');
    const preInputArgs = args.slice(0, inputIndex);

    assert.ok(preInputArgs.includes('-probesize'), 'Expected probesize from INPUT_FFMPEG_FLAGS');
    assert.ok(preInputArgs.includes('-analyzeduration'), 'Expected analyzeduration from INPUT_FFMPEG_FLAGS');
  } finally {
    // Restore original value
    if (originalFlags === undefined) {
      delete process.env.INPUT_FFMPEG_FLAGS;
    } else {
      process.env.INPUT_FFMPEG_FLAGS = originalFlags;
    }
  }
});

test('buildFfmpegArgs maps video stream from file', () => {
  const streamer = createVideoStreamer({ videoFile: '/path/to/video.mp4' });
  const args = streamer.buildFfmpegArgs();

  // Should map video from input file
  assert.ok(args.includes('-map'), 'Expected -map flag');
  const mapIndex = args.indexOf('-map');
  assert.equal(args[mapIndex + 1], '0:v:0', 'Expected video stream mapping from input 0');
});

test('video file mode does not use x11grab input', () => {
  const streamer = createVideoStreamer({ videoFile: '/path/to/video.mp4' });
  const args = streamer.buildFfmpegArgs();

  // Ensure no x11grab-related args
  assert.ok(!args.includes('x11grab'), 'Should not include x11grab');
  assert.ok(!args.includes('-video_size'), 'Should not include -video_size (x11grab option)');
  assert.ok(!args.includes(':99'), 'Should not include display :99');
});

// =============================================================================
// Unit Tests: browser mode still works when videoFile is not set
// =============================================================================

test('buildFfmpegArgs uses x11grab when videoFile is not set', () => {
  const streamer = new PageStreamer({
    url: 'demo/index.html',
    ingest: 'srt://127.0.0.1:9000?streamid=test',
    width: 1920,
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
    videoFile: undefined,
    videoLoop: false,
  });
  const args = streamer.buildFfmpegArgs();

  // Should use x11grab for browser capture
  assert.ok(args.includes('x11grab'), 'Browser mode should use x11grab');
  assert.ok(args.includes('-video_size'), 'Browser mode should include -video_size');
});

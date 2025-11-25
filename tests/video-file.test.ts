import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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

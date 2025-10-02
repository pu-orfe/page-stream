import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileWithRetry } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

// Simple tests just exercising CLI argument parsing and fallback logic

function runCli(args: string[]): Promise<{ code: number|null; stdout: string; stderr: string; }> {
  return new Promise(res => {
    const p = spawn('node', ['dist/index.js', ...args], { cwd: root, env: { ...process.env, PAGE_STREAM_TEST_MODE: '1' } });
    let out=''; let err='';
    p.stdout?.on('data', d => out += d.toString());
    p.stderr?.on('data', d => err += d.toString());
    const killTimer = setTimeout(()=> { try { p.kill('SIGINT'); } catch {} }, 800); // shorter in test mode
    const hardTimer = setTimeout(()=> { try { p.kill('SIGKILL'); } catch {}; res({ code: null, stdout: out, stderr: err }); }, 3000);
    p.on('close', code => { clearTimeout(killTimer); clearTimeout(hardTimer); res({ code, stdout: out, stderr: err }); });
  });
}

test('CLI requires ingest', async () => {
  const r1 = await runCli(['--url','demo/index.html']);
  assert.notEqual(r1.code, 0);
});

test('CLI accepts ingest and url', async () => {
  const r2 = await runCli(['--ingest','srt://127.0.0.1:9000?streamid=test','--url','demo/index.html']);
  // Should start (code will be SIGINT from our timeout, so null or non-zero acceptable)
  assert.ok(/Streaming page|ffmpeg/i.test(r2.stdout + r2.stderr), 'Expected startup log to contain Streaming page or ffmpeg banner');
});

test('readFileWithRetry reads existing file', async () => {
  const testFile = path.join(__dirname, 'test-file.txt');
  const content = 'test content';
  fs.writeFileSync(testFile, content);
  try {
    const result = await readFileWithRetry(testFile);
    assert.equal(result, content);
  } finally {
    fs.unlinkSync(testFile);
  }
});

test('readFileWithRetry throws on non-existent file', async () => {
  const nonExistent = path.join(__dirname, 'non-existent.txt');
  await assert.rejects(async () => {
    await readFileWithRetry(nonExistent, 1, 10); // low retries for speed
  }, /ENOENT/);
});

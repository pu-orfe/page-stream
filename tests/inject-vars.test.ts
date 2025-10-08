import { spawn } from 'child_process';
import test from 'node:test';
import { strict as assert } from 'assert';

function waitFor(pattern: RegExp, source: () => string, timeoutMs=3000, interval=50): Promise<string> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const data = source();
      if (pattern.test(data)) return resolve(data);
      if (Date.now() - start > timeoutMs) return reject(new Error('Timeout waiting for pattern '+pattern));
      setTimeout(tick, interval);
    };
    tick();
  });
}

test('entrypoint honors per-container INJECT_CSS/INJECT_JS env vars', async () => {
  const ep = spawn('bash', ['./scripts/entrypoint.sh','--ingest','srt://dummy?streamid=test'], {
    env: { ...process.env, PAGE_STREAM_TEST_MODE: '1', STANDARD_1_INJECT_CSS: '/out/demo/assets/inject.css', STANDARD_1_INJECT_JS: '/out/demo/assets/inject.js' },
    stdio: ['ignore','pipe','pipe']
  });
  let stdout=''; let stderr='';
  ep.stdout.on('data', (d: any) => stdout += d.toString());
  ep.stderr.on('data', (d: any) => stderr += d.toString());
  const out = () => stderr + stdout;
  // Wait for the entrypoint to print the injected file paths (supports both
  // global INJECT_* phrasing and per-container FOUND ... Using ... phrasing).
  await waitFor(/\/out\/demo\/assets\/inject.css/, out, 3000);
  await waitFor(/\/out\/demo\/assets\/inject.js/, out, 3000);
  ep.kill();
  // Ensure the paths were printed; exact prefix varies between global and
  // per-container env handling, so assert on the path presence only.
  assert.match(out(), /\/out\/demo\/assets\/inject.css/);
  assert.match(out(), /\/out\/demo\/assets\/inject.js/);
});

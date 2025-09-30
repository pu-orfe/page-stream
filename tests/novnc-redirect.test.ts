import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import net from 'node:net';

// This test inspects the generated redirect index.html created by entrypoint.sh when ENABLE_NOVNC=1.
// We run the entrypoint in PAGE_STREAM_TEST_MODE so Chromium/ffmpeg are skipped; then read the file.

function wait(ms:number){return new Promise(r=>setTimeout(r,ms));}

test('generated noVNC index.html includes empty path query ensuring root websocket', async () => {
  // Use a temp copy of entrypoint logic so we do not need full stack; rely on script generation side-effect.
  const ep = spawn('bash', ['./scripts/entrypoint.sh','--ingest','srt://dummy?streamid=test'], {
    env: { ...process.env, ENABLE_NOVNC: '1', PAGE_STREAM_TEST_MODE: '1', EXIT_AFTER_READY: '1', LIGHTWEIGHT_NOVNC: '1' },
    stdio: ['ignore','pipe','pipe']
  });
  let combined = '';
  ep.stdout.on('data', d=> combined += d.toString());
  ep.stderr.on('data', d=> combined += d.toString());
  await new Promise(r=>ep.on('close', r));
  // File should exist only if full websockify path available; in lightweight mode script still writes index.html
  const path = '/usr/share/novnc/index.html';
  if (!fs.existsSync(path)) {
    // If missing, skip rather than fail (environment might not have novnc package).
    console.warn('noVNC index.html not present; skipping assertion');
    return;
  }
  const contents = fs.readFileSync(path,'utf8');
  assert.match(contents, /vnc.html\?autoconnect=1&host=\${host}&port=\${port}&path=/, 'Redirect index must include explicit empty path= parameter');
});

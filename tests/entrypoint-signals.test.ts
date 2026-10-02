import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// THE CONTAINER MUST SURVIVE A REFRESH SIGNAL.
//
// HUP means "refresh the page", and the refresh workflow sends it with `docker kill -s HUP`.
// The entrypoint traps HUP and relays it to the app, then sat in a bare `wait $APP_PID`.
// bash's `wait` returns early (128+N) whenever a trapped signal arrives, so `set -e` ended
// the script with the app still running: exit 129, and Docker - which counts `docker kill`
// as a deliberate stop - did not restart it. On 2026-10-02 that took standard-3 off the air.
//
// These run the REAL entrypoint with a stand-in `node` that records the signals it gets.
// The other entrypoint tests read its text; this failure is about how the shell behaves
// when a signal lands, which no amount of reading the text can show.

const here = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(here, '..', '..', 'scripts', 'entrypoint.sh');

const STUB = `#!/bin/bash
trap 'echo HUP >> "$STUB_LOG"' HUP
trap 'echo TERM >> "$STUB_LOG"; exit 0' TERM
echo START >> "$STUB_LOG"
if [ -n "\${STUB_EXIT_AFTER:-}" ]; then sleep "$STUB_EXIT_AFTER"; exit "\${STUB_EXIT_CODE:-0}"; fi
while :; do sleep 0.2; done
`;

interface Run { proc: ChildProcess; log: string; dir: string; exited: Promise<number | null>; }

function start(env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'ep-signals-'));
  const bin = join(dir, 'bin');
  // A directory holding a script named node, first on PATH, stands in for the app.
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'), STUB);
  chmodSync(join(bin, 'node'), 0o755);
  const log = join(dir, 'stub.log');
  const proc = spawn('bash', [ENTRYPOINT, '--url', 'about:blank'], {
    env: { ...process.env, ...env, STUB_LOG: log, SKIP_XVFB: '1',
           PATH: `${bin}:${process.env.PATH ?? ''}` },
    stdio: 'ignore',
  });
  const exited = new Promise<number | null>(res => proc.on('exit', code => res(code)));
  return { proc, log, dir, exited };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await sleep(50); }
  return false;
}

function signals(run: Run): string[] {
  return existsSync(run.log) ? readFileSync(run.log, 'utf8').trim().split('\n') : [];
}

const skip = process.platform === 'win32' ? 'needs bash' : false;

test('a refresh signal reaches the app and does not end the container', { skip }, async () => {
  const run = start();
  try {
    assert.ok(await waitFor(() => signals(run).includes('START')), 'the stand-in app never started');
    // The trap must be installed before the signal arrives; it is set just after launch.
    await sleep(500);

    run.proc.kill('SIGHUP');
    assert.ok(await waitFor(() => signals(run).filter(s => s === 'HUP').length === 1),
      'the refresh signal never reached the app');
    await sleep(500);
    assert.equal(run.proc.exitCode, null,
      'the entrypoint exited on a refresh signal - the container would stop (the 2026-10-02 bug)');

    // And again: a loop that survives once but not twice would still take a channel down.
    run.proc.kill('SIGHUP');
    assert.ok(await waitFor(() => signals(run).filter(s => s === 'HUP').length === 2));
    await sleep(500);
    assert.equal(run.proc.exitCode, null, 'the entrypoint exited on the second refresh signal');

    run.proc.kill('SIGTERM');
    assert.equal(await run.exited, 0, 'a graceful stop must still exit 0');
    assert.ok(signals(run).includes('TERM'), 'the stop never reached the app');
  } finally {
    run.proc.kill('SIGKILL');
    rmSync(run.dir, { recursive: true, force: true });
  }
});

test("the app's own exit status still becomes the container's", { skip }, async () => {
  // Exit codes are part of the contract (10 = reconnects exhausted, 11 = non-retry ffmpeg
  // failure); orchestration reads them. Waiting in a loop must not swallow them.
  const run = start({ STUB_EXIT_AFTER: '1', STUB_EXIT_CODE: '10' });
  try {
    assert.equal(await run.exited, 10);
  } finally {
    run.proc.kill('SIGKILL');
    rmSync(run.dir, { recursive: true, force: true });
  }
});

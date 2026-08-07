import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A stale /tmp/.X<N>-lock used to put a container into a permanent restart loop.
//
// `restart: unless-stopped` restarts the SAME container, so /tmp survives. An ungraceful
// kill - which is what an OS reboot is - leaves the lock behind, Xvfb then refuses the
// display forever, and nothing heals it. Worse, Xvfb's stderr was sent to /dev/null, so
// the log showed a generic 60s timeout instead of the message naming the lock file.
//
// These tests assert the entrypoint's source, because reproducing a real Xvfb lock needs
// the container image; the shape of the guard is what regressed and what matters.

// dist/tests/ -> repo root -> scripts/
const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = join(here, '..', '..', 'scripts', 'entrypoint.sh');
const src = readFileSync(entrypoint, 'utf8');

test('entrypoint removes a stale X lock before starting Xvfb', () => {
  assert.match(src, /rm -f "\$XVFB_LOCK" "\$XVFB_SOCK"/,
    'no stale-lock removal: a host reboot will leave the container looping forever');
});

test('stale-lock removal is guarded by a liveness check', () => {
  // Deleting the lock unconditionally would let two Xvfb servers fight over one display.
  const block = src.slice(src.indexOf('XVFB_LOCK='), src.indexOf('XVFB_LOG='));
  assert.match(block, /xdpyinfo -display "\$XVFB_D"/,
    'lock is removed without checking whether a server is actually live');
});

test('Xvfb stderr is captured, not discarded', () => {
  assert.doesNotMatch(src, /Xvfb \$XVFB_D[^\n]*2>\/dev\/null/,
    'Xvfb stderr is being discarded - this hid the real cause of the reboot loop');
  assert.match(src, /XVFB_LOG=/, 'Xvfb output is not captured to a log');
});

test('Xvfb failure surfaces the captured output', () => {
  const failures = src.match(/ERROR: Xvfb [^\n]*/g) ?? [];
  assert.ok(failures.length >= 2, 'expected both an immediate-exit and a timeout failure path');
  // Every failure path must print the log, or we are back to debugging a bare timeout.
  const after = src.slice(src.indexOf('ERROR: Xvfb exited immediately'));
  assert.match(after, /sed 's\/\^\/\[xvfb\] \/' "\$XVFB_LOG"/,
    'failure path does not echo the Xvfb log');
});

test('entrypoint fails fast when Xvfb dies immediately', () => {
  assert.match(src, /kill -0 "\$XVFB_PID"/,
    'no liveness check: a dead Xvfb still waits the full 60s before restarting');
});

test('cleanup removes the lock on graceful exit', () => {
  const cleanup = src.slice(src.indexOf('cleanup() {'), src.indexOf('trap cleanup EXIT'));
  assert.match(cleanup, /\.X\$\{XVFB_NUM\}-lock/,
    'graceful shutdown leaves a lock that the next start must clean up');
});

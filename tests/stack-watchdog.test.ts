import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The watchdog decides whether anyone gets paged, so its behaviour is exercised for real
// rather than grepped: the script is RUN, against a fake `docker` on PATH. That is what
// caught the bug these tests now pin - an empty WATCHDOG_EXPECTED aborted the whole script
// with "unbound variable" under bash 3.2, so the monitor died silently and sent nothing.
//
// WATCHDOG_EXPECTED is rendered from channels.yml by page-stream-config's render-config.py,
// which omits any channel marked `enabled: false`. The contract tested here is the far end
// of that: a producer absent from the list must not be reported as a problem, because it was
// stopped on purpose.

// dist/tests/ -> repo root -> scripts/
const here = dirname(fileURLToPath(import.meta.url));
const watchdog = join(here, '..', '..', 'scripts', 'stack-watchdog.sh');

/**
 * A stand-in for the docker CLI. Containers named in FAKE_RUNNING are running and healthy;
 * those in FAKE_UNHEALTHY exist but fail their probe; anything else does not exist.
 */
function fakeDockerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-test-'));
  const docker = join(dir, 'docker');
  writeFileSync(docker, `#!/bin/bash
# minimal docker stand-in; only the subcommands stack-watchdog.sh uses
case "$1" in
  info) exit 0 ;;
  logs) echo "fake: no errors"; exit 0 ;;
  inspect)
    name="$2"
    listed() { case ",$1," in *",$name,"*) return 0 ;; esac; return 1; }
    if listed "\${FAKE_RUNNING:-}"; then state=running; health=healthy; restarts=0
    elif listed "\${FAKE_UNHEALTHY:-}"; then state=running; health=unhealthy; restarts=7
    else exit 1
    fi
    # No --format means the script is only testing existence.
    [ "$#" -lt 3 ] && exit 0
    fmt="$4"
    case "$fmt" in
      *State.Status*)  echo "$state" ;;
      *Health.Log*)    echo "Xvfb missing" ;;
      *Health.Status*) echo "$health" ;;
      *RestartCount*)  echo "$restarts" ;;
      *) echo "" ;;
    esac
    exit 0 ;;
esac
exit 0
`);
  chmodSync(docker, 0o755);
  return dir;
}

/** Run the watchdog in --dry-run (never sends notifications) and return its combined output. */
function run(env: Record<string, string>): string {
  const dir = fakeDockerDir();
  // PATH is fully specified so the script's own PATH self-heal finds nothing to prepend and
  // the fake docker stays first. Otherwise a real docker in /usr/local/bin would win.
  const PATH = [dir, '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin',
    '/opt/homebrew/bin', `${process.env.HOME}/.homebrew/bin`].join(':');
  try {
    return execFileSync('/bin/bash', [watchdog, '--dry-run'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH, HEALTHCHECKS_STACK_URL: '', RESEND_API_KEY: '', ...env },
    });
  } catch (e: any) {
    // --dry-run exits 0, so a throw means the script itself broke. Surface both streams.
    return `${e.stdout ?? ''}${e.stderr ?? ''}THREW:${e.status}`;
  }
}

const ALL = 'standard-1,standard-2,standard-3,standard-4,standard-5,standard-6,compositor';

test('a healthy stack reports no problems', () => {
  const out = run({ WATCHDOG_EXPECTED: ALL, FAKE_RUNNING: ALL });
  assert.match(out, /all channels healthy/, out);
});

test('a producer omitted from WATCHDOG_EXPECTED is not reported as down', () => {
  // The disable path: standard-5 is stopped on purpose, so it is absent from BOTH the
  // expectation and the running set. That must be silence, not an alert - a watchdog that
  // pages about a deliberate outage gets muted, and a muted watchdog is worse than none.
  const enabled = ALL.split(',').filter((c) => c !== 'standard-5').join(',');
  const out = run({ WATCHDOG_EXPECTED: enabled, FAKE_RUNNING: enabled });
  assert.match(out, /all channels healthy/, out);
  assert.doesNotMatch(out, /standard-5/, 'alerted about a channel that was disabled on purpose');
});

test('a container that is still expected but missing IS reported', () => {
  // The converse, and the reason the two lists must come from one source: if only the
  // compose side were updated, this is the false alarm you would get every five minutes.
  const running = ALL.split(',').filter((c) => c !== 'standard-5').join(',');
  const out = run({ WATCHDOG_EXPECTED: ALL, FAKE_RUNNING: running });
  assert.match(out, /standard-5: NOT PRESENT/, out);
  assert.doesNotMatch(out, /all channels healthy/, out);
});

test('an unhealthy container is reported with its probe output', () => {
  const out = run({ WATCHDOG_EXPECTED: 'standard-1', FAKE_UNHEALTHY: 'standard-1' });
  assert.match(out, /standard-1: state=running health=unhealthy/, out);
  assert.match(out, /last probe: Xvfb missing/, 'probe output withheld — it names what died');
});

test('an empty WATCHDOG_EXPECTED does not crash the script', () => {
  // The regression: `IFS=',' read -ra want <<< ""` leaves the array unset, and "${want[@]}"
  // aborts under `set -u` on bash 3.2 — the macOS default, which the runner uses.
  const out = run({ WATCHDOG_EXPECTED: '', FAKE_RUNNING: ALL });
  assert.doesNotMatch(out, /unbound variable/, 'script aborted instead of reporting');
  assert.doesNotMatch(out, /THREW:/, `script exited non-zero: ${out}`);
});

test('an empty WATCHDOG_EXPECTED is a watchdog fault, not a healthy stack', () => {
  // Checking nothing and reporting "healthy" would be the worst outcome: a green dashboard
  // that proves nothing at all.
  const out = run({ WATCHDOG_EXPECTED: '', FAKE_RUNNING: ALL });
  assert.doesNotMatch(out, /all channels healthy/, 'claimed healthy without checking anything');
  assert.match(out, /WATCHDOG PROBLEM/, out);
  assert.match(out, /render-config\.py/, 'does not say how to fix it');
});

test('an unset WATCHDOG_EXPECTED still falls back to the built-in list', () => {
  // Only an EMPTY value is a fault; unset means "nobody configured me", which should still
  // check the standard stack rather than silently check nothing.
  const out = run({ FAKE_RUNNING: ALL });
  assert.match(out, /all channels healthy/, out);
});

test('the failure ping URL cannot acquire a double slash', () => {
  const src = readFileSync(watchdog, 'utf8');
  assert.match(src, /HC_URL="\$\{HC_URL%\/\}"/,
    'a pasted trailing slash makes "<url>//fail" 404 and the alert never arrives');
});

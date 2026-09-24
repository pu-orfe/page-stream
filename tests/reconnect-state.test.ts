import test from 'node:test';
import assert from 'node:assert/strict';
import { PageStreamer } from '../src/index.js';

// WHAT THE HEALTH LINE IS FOR
//
// `[health] {...}` is the only thing that says, from outside the container, whether a
// channel is streaming or sitting in a reconnect backoff. Docker cannot: the container
// stays healthy either way, because Xvfb and Chromium are up and only ffmpeg is gone.
//
// On 2026-09-23 the relay lost all nine publishers twice when DNS stopped resolving
// orfe-web.princeton.edu on display-1. They recovered on their own in under two minutes.
// Twenty minutes later every container was still reporting `"retrying":true` with a
// growing restartAttempt, while all nine paths were live on the relay and taking bytes at
// their configured rate. The field had been stuck true since each container's FIRST ever
// reconnect: the timer handle was never cleared once the timer fired.
//
// A flag that is true while the thing it describes is false is worse than no flag. These
// tests pin the transitions rather than the mechanism.

function streamer(over: Partial<Record<string, unknown>> = {}) {
  return new PageStreamer({
    url: 'demo/index.html',
    ingest: 'srt://relay.example:8890?streamid=x',
    width: 1280,
    height: 720,
    fps: 30,
    preset: 'veryfast',
    videoBitrate: '1000k',
    audioBitrate: '128k',
    format: 'mpegts',
    extraFfmpeg: [],
    headless: false,
    fullscreen: true,
    appMode: true,
    reconnectAttempts: 0,
    reconnectInitialDelayMs: 20,
    reconnectMaxDelayMs: 20,
    healthIntervalSeconds: 0,
    autoRefreshSeconds: 0,
    suppressAutomationBanner: true,
    autoDismissInfobar: false,
    cropInfobar: 0,
    videoLoop: false,
    ...over,
  } as never);
}

/** The health payload, without waiting out an interval timer. */
function health(s: PageStreamer): Record<string, unknown> {
  const any = s as unknown as Record<string, unknown>;
  return {
    restartAttempt: any.restartAttempt,
    lastFfmpegExitCode: any.lastFfmpegExitCode,
    retrying: !!any.restartTimer,
  };
}

/**
 * Stand in for the launch so no ffmpeg is spawned. It ONLY counts calls: clearing the
 * timer handle here would make these tests pass against a fix that does not exist, which
 * is how the stuck flag survived in the first place. The clearing under test belongs to
 * the scheduled callback in scheduleRestartIfNeeded, and that callback still runs.
 */
function stubLaunch(s: PageStreamer): { calls: number } {
  const counter = { calls: 0 };
  (s as unknown as { launchFfmpeg: () => Promise<void> }).launchFfmpeg = async () => {
    counter.calls += 1;
  };
  return counter;
}

test('a pending reconnect reports retrying', async () => {
  const s = streamer();
  stubLaunch(s);
  (s as unknown as { scheduleRestartIfNeeded: (c: number) => void }).scheduleRestartIfNeeded(1);

  const h = health(s);
  assert.equal(h.retrying, true, 'ffmpeg is down and a restart is pending');
  assert.equal(h.restartAttempt, 1);
  await new Promise(r => setTimeout(r, 60));
  await (s as unknown as { stop: () => Promise<void> }).stop();
});

test('retrying goes false once the reconnect actually happens', async () => {
  const s = streamer();
  const launched = stubLaunch(s);
  (s as unknown as { scheduleRestartIfNeeded: (c: number) => void }).scheduleRestartIfNeeded(1);

  await new Promise(r => setTimeout(r, 60));

  assert.equal(launched.calls, 1, 'the scheduled restart should have fired');
  assert.equal(
    health(s).retrying,
    false,
    'still claiming to be retrying after the restart fired - this is the 2026-09-23 bug, ' +
    'where every healthy container reported retrying:true for the rest of its life'
  );
  await (s as unknown as { stop: () => Promise<void> }).stop();
});

test('a second, later outage reports retrying again', async () => {
  // The flag has to work more than once. A fix that clears it and never re-arms would
  // pass the test above and leave the next real outage invisible.
  const s = streamer();
  stubLaunch(s);
  const sched = (s as unknown as { scheduleRestartIfNeeded: (c: number) => void });

  sched.scheduleRestartIfNeeded(1);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(health(s).retrying, false);

  sched.scheduleRestartIfNeeded(1);
  assert.equal(health(s).retrying, true, 'a fresh outage must show as retrying');
  assert.equal(health(s).restartAttempt, 2, 'reconnects are counted over the container life');

  await new Promise(r => setTimeout(r, 60));
  await (s as unknown as { stop: () => Promise<void> }).stop();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveTarget, resolveStartUrl } from '../src/index.js';

// A real file to point at, since resolution is existence-sensitive.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgstream-url-'));
const realPage = path.join(tmpDir, 'slate.html');
fs.writeFileSync(realPage, '<!doctype html><title>slate</title>');
const missingPage = path.join(tmpDir, 'does-not-exist.html');

test('remote URLs pass through untouched, query and all', () => {
  for (const url of [
    'https://orfe.princeton.edu/news',
    'http://example.com/a?b=c#d',
    'HTTPS://EXAMPLE.COM/upper',
  ]) {
    assert.deepEqual(resolveTarget(url), { navigateUrl: url });
  }
});

test('a filesystem path becomes a file:// URL and reports its local path', () => {
  const resolved = resolveTarget(realPage);
  assert.equal(resolved.navigateUrl, pathToFileURL(realPage).href);
  assert.equal(resolved.localPath, realPage);
});

test('a relative path is resolved against the working directory', () => {
  const resolved = resolveTarget('demo/index.html');
  assert.equal(resolved.localPath, path.resolve('demo/index.html'));
  assert.ok(resolved.navigateUrl.startsWith('file://'));
});

test('a file:// URL is accepted, not treated as a missing path', () => {
  const url = pathToFileURL(realPage).href;
  const resolved = resolveTarget(url);
  assert.equal(resolved.navigateUrl, url);
  assert.equal(resolved.localPath, realPage);
});

test('a query string survives on a file:// URL, and is not part of the local path', () => {
  const url = `${pathToFileURL(realPage).href}?channel=ORFE%20Live%20Events`;
  const resolved = resolveTarget(url);
  assert.equal(resolved.navigateUrl, url, 'the page needs its query to configure itself');
  assert.equal(resolved.localPath, realPage, 'the query is not part of the filename');
});

test('a query string survives on a plain path too', () => {
  const resolved = resolveTarget(`${realPage}?channel=Test&debug=1`);
  assert.equal(
    resolved.navigateUrl,
    `${pathToFileURL(realPage).href}?channel=Test&debug=1`
  );
  assert.equal(resolved.localPath, realPage);
});

test('a fragment survives as well', () => {
  const resolved = resolveTarget(`${realPage}#section`);
  assert.equal(resolved.navigateUrl, `${pathToFileURL(realPage).href}#section`);
  assert.equal(resolved.localPath, realPage);
});

test('a filename containing ? is preferred over treating it as a query', () => {
  const odd = path.join(tmpDir, 'what?.html');
  fs.writeFileSync(odd, 'x');
  const resolved = resolveTarget(odd);
  assert.equal(resolved.localPath, odd, 'the file exists, so nothing should be split off');
});

test('resolveStartUrl returns the navigable URL when the local page exists', () => {
  assert.equal(resolveStartUrl(realPage), pathToFileURL(realPage).href);
});

test('resolveStartUrl throws on a missing local page rather than substituting content', () => {
  assert.throws(() => resolveStartUrl(missingPage), (err: Error) => {
    assert.match(err.message, /Local page not found/);
    assert.match(err.message, /does-not-exist\.html/);
    assert.match(err.message, /--fallback-demo-page/, 'the error should name the opt-out');
    return true;
  });
});

test('resolveStartUrl throws for a file:// URL whose target is missing', () => {
  const url = pathToFileURL(missingPage).href;
  assert.throws(() => resolveStartUrl(url), /Local page not found/);
});

test('resolveStartUrl throws when a query string is attached to a missing page', () => {
  // The regression that shipped a demo page to a public display: the query made the
  // existence check fail, and the old code silently swapped in different content.
  assert.throws(
    () => resolveStartUrl(`${missingPage}?channel=ORFE%20Live%20Events`),
    /Local page not found/
  );
});

test('--fallback-demo-page restores the legacy substitution, opt-in only', () => {
  const startUrl = resolveStartUrl(missingPage, {
    fallbackDemoPage: true,
    demoPage: realPage,
  });
  assert.equal(startUrl, pathToFileURL(realPage).href);
});

test('a remote URL is never existence-checked', () => {
  assert.equal(
    resolveStartUrl('https://example.com/definitely/not/on/disk'),
    'https://example.com/definitely/not/on/disk'
  );
});

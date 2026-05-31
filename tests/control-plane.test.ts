import { strict as assert } from 'node:assert';
import test from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let root = __dirname;
while (root !== '/' && !fs.existsSync(path.join(root, 'package.json'))) {
  root = path.dirname(root);
}


// Helper to make HTTP requests
function request(url: string, options: http.RequestOptions = {}, body?: any): Promise<{ statusCode: number | undefined; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: data
      }));
    });
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

test('Control Plane API tests', async (t) => {
  // Start the control API server in a separate process or import it.
  // Starting it via child_process ensures it behaves exactly as run from cli/npm.
  const controlPort = 3009; // Use unique port for tests to avoid conflict
  
  const serverProc = spawn('node', ['dist/src/control-api/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      CONTROL_PORT: String(controlPort),
      CONTROL_PLANE_MOCK: '1',
      PAGE_STREAM_TEST_MODE: '1'
    }
  });

  // Wait for server to boot
  await new Promise((resolve) => setTimeout(resolve, 800));

  await t.test('GET /api/streams returns list of streams in mock mode', async () => {
    const res = await request(`http://localhost:${controlPort}/api/streams`);
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json));
    assert.ok(json.length > 0);
    const firstStream = json[0];
    assert.ok(firstStream.id);
    assert.ok(firstStream.status);
  });

  await t.test('POST /api/streams/:id/refresh triggers page reload', async () => {
    const res = await request(
      `http://localhost:${controlPort}/api/streams/standard-1/refresh`,
      { method: 'POST' }
    );
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.success, true);
  });

  await t.test('POST /api/streams/:id/restart restarts stream container', async () => {
    const res = await request(
      `http://localhost:${controlPort}/api/streams/standard-1/restart`,
      { method: 'POST' }
    );
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.success, true);
  });

  await t.test('POST /api/streams/:id/url updates target page URL', async () => {
    const newUrl = 'https://google.com';
    const res = await request(
      `http://localhost:${controlPort}/api/streams/standard-1/url`,
      { method: 'POST' },
      { url: newUrl }
    );
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.success, true);
    
    // Verify changes persisted in mock data
    const getRes = await request(`http://localhost:${controlPort}/api/streams`);
    const streams = JSON.parse(getRes.body);
    const updated = streams.find((s: any) => s.id === 'standard-1');
    assert.equal(updated.url, newUrl);
  });

  await t.test('GET /api/streams/:id/logs retrieves stream logs', async () => {
    const res = await request(`http://localhost:${controlPort}/api/streams/standard-1/logs`);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('[health]') || res.body.includes('[mock-logs]'));
  });

  // Cleanup server process
  serverProc.kill('SIGTERM');
  await new Promise((resolve) => serverProc.on('close', resolve));
});

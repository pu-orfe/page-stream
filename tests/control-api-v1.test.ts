import { strict as assert } from 'node:assert';
import test from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let root = __dirname;
while (root !== '/' && !fs.existsSync(path.join(root, 'package.json'))) {
  root = path.dirname(root);
}

function request(url: string, options: http.RequestOptions = {}, body?: any): Promise<{status: number|undefined; body: string}> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('Control API v1', async (t) => {
  const port = 3011;
  const proc = spawn('node', ['dist/src/control-api/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      CONTROL_PORT: String(port),
      CONTROL_PLANE_MOCK: '1',
      PAGE_STREAM_TEST_MODE: '1',
    },
  });
  await new Promise(r => setTimeout(r, 800));

  try {
    await t.test('GET /api/v1/health', async () => {
      const r = await request(`http://localhost:${port}/api/v1/health`);
      assert.equal(r.status, 200);
      assert.match(r.body, /"status":"ok"/);
    });

    await t.test('GET /api/v1/streams returns mocks in test mode', async () => {
      const r = await request(`http://localhost:${port}/api/v1/streams`);
      assert.equal(r.status, 200);
      const data = JSON.parse(r.body);
      assert.ok(Array.isArray(data.streams));
      assert.ok(data.streams.length > 0);
    });

    await t.test('GET /api/v1/streams/:id/logs returns text', async () => {
      const r = await request(`http://localhost:${port}/api/v1/streams/standard-1/logs`);
      assert.equal(r.status, 200);
      assert.ok(r.body.length > 0);
    });

    await t.test('POST /api/v1/actions/refresh records an action', async () => {
      const r = await request(
        `http://localhost:${port}/api/v1/actions/refresh`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        { target: 'standard-1' }
      );
      assert.equal(r.status, 202);
      const action = JSON.parse(r.body);
      assert.equal(action.kind, 'refresh');
      assert.equal(action.status, 'succeeded');

      const list = await request(`http://localhost:${port}/api/v1/actions`);
      const { actions } = JSON.parse(list.body);
      assert.ok(actions.find((a: any) => a.id === action.id));
    });

    await t.test('GET /api/v1/drift returns in-sync when no runtime env visible', async () => {
      const r = await request(`http://localhost:${port}/api/v1/drift`);
      assert.equal(r.status, 200);
      const report = JSON.parse(r.body);
      assert.equal(report.inSync, true);
    });

    await t.test('unknown v1 route 404s inside namespace, not falls through', async () => {
      const r = await request(`http://localhost:${port}/api/v1/nope`);
      assert.equal(r.status, 404);
    });
  } finally {
    proc.kill('SIGTERM');
    await new Promise(r => proc.on('close', r));
  }
});

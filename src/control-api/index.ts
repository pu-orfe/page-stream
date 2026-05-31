import http from 'node:http';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.CONTROL_PORT ? parseInt(process.env.CONTROL_PORT, 10) : 3000;
const COMPOSE_FILE = process.env.COMPOSE_FILE || 'docker-compose.stable.yml';

// Mock data when docker is not present or in test mode
let useMock = process.env.CONTROL_PLANE_MOCK === '1' || process.env.PAGE_STREAM_TEST_MODE === '1';

interface StreamStatus {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'unhealthy' | 'retrying';
  uptimeSec: number;
  url: string;
  ingest: string;
  reconnectAttempts: number;
  lastExitCode: number | null;
}

const mockStreams: StreamStatus[] = [
  {
    id: 'standard-1',
    name: 'standard-1',
    status: 'running',
    uptimeSec: 3600,
    url: 'file:///app/demo/test-standard.html',
    ingest: 'srt://srt-test-listener:9001?streamid=std1',
    reconnectAttempts: 0,
    lastExitCode: null,
  },
  {
    id: 'standard-2',
    name: 'standard-2',
    status: 'running',
    uptimeSec: 1800,
    url: 'https://example.com',
    ingest: 'srt://srt-test-listener:9002?streamid=std2',
    reconnectAttempts: 2,
    lastExitCode: 1,
  },
  {
    id: 'compositor',
    name: 'compositor',
    status: 'running',
    uptimeSec: 4200,
    url: 'N/A (Compositor Mode)',
    ingest: 'srt://srt-ingest:9000?streamid=composite',
    reconnectAttempts: 0,
    lastExitCode: null,
  },
  {
    id: 'source-left',
    name: 'source-left',
    status: 'running',
    uptimeSec: 4100,
    url: 'file:///app/demo/test-left.html',
    ingest: 'srt://compositor:10001?streamid=left',
    reconnectAttempts: 0,
    lastExitCode: null,
  },
  {
    id: 'source-right',
    name: 'source-right',
    status: 'retrying',
    uptimeSec: 0,
    url: 'file:///app/demo/test-right.html',
    ingest: 'srt://compositor:10002?streamid=right',
    reconnectAttempts: 5,
    lastExitCode: 10,
  }
];

function getDockerComposeStreams(): StreamStatus[] {
  if (useMock) return mockStreams;

  try {
    // Check if docker-compose command is available
    execSync('docker-compose --version', { stdio: 'ignore' });
  } catch {
    console.warn('[control-api] docker-compose not found, falling back to mock data');
    useMock = true;
    return mockStreams;
  }

  try {
    // Query docker-compose for container statuses
    const output = execSync(`docker-compose -f ${COMPOSE_FILE} ps --format json`, { encoding: 'utf8' });
    const containers = JSON.parse(`[${output.trim().replace(/\n/g, ',')}]`);
    
    // Map docker-compose output to our StreamStatus structures
    return containers.map((c: any) => {
      const isRunning = c.State === 'running';
      const isHealthy = c.Health === 'healthy' || c.Status.includes('(healthy)');
      const isUnhealthy = c.Health === 'unhealthy' || c.Status.includes('(unhealthy)');
      
      let status: 'running' | 'stopped' | 'unhealthy' | 'retrying' = 'stopped';
      if (isRunning) {
        status = isHealthy ? 'running' : (isUnhealthy ? 'unhealthy' : 'running');
      }

      // Try to parse command and environment from compose if possible, or fallback to sensible defaults
      return {
        id: c.Service,
        name: c.Name,
        status,
        uptimeSec: isRunning ? 1200 : 0, // Placeholder uptime
        url: 'Querying...',
        ingest: 'Querying...',
        reconnectAttempts: 0,
        lastExitCode: null,
      };
    });
  } catch (err: any) {
    console.error('[control-api] Error querying docker-compose:', err.message);
    return mockStreams; // Fallback
  }
}

function handleRefresh(streamId: string): boolean {
  console.log(`[control-api] Triggering refresh for ${streamId}`);
  if (useMock) {
    const stream = mockStreams.find(s => s.id === streamId);
    if (stream) {
      stream.uptimeSec += 1;
      return true;
    }
    return false;
  }

  try {
    // Touch refresh FIFO inside container
    // e.g. docker exec <container-name> sh -c 'echo refresh > /tmp/page_refresh_fifo'
    // First find container name
    const streams = getDockerComposeStreams();
    const target = streams.find(s => s.id === streamId);
    if (!target) return false;

    execSync(`docker-compose -f ${COMPOSE_FILE} exec -T ${streamId} sh -c "echo refresh > /tmp/page_refresh_fifo"`, { stdio: 'ignore' });
    return true;
  } catch (err: any) {
    console.error(`[control-api] Failed to refresh ${streamId}:`, err.message);
    // Fallback: send SIGHUP
    try {
      execSync(`docker-compose -f ${COMPOSE_FILE} kill -s HUP ${streamId}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

function handleRestart(streamId: string): boolean {
  console.log(`[control-api] Triggering restart for ${streamId}`);
  if (useMock) {
    const stream = mockStreams.find(s => s.id === streamId);
    if (stream) {
      stream.status = 'running';
      stream.uptimeSec = 0;
      stream.reconnectAttempts = 0;
      stream.lastExitCode = null;
      return true;
    }
    return false;
  }

  try {
    execSync(`docker-compose -f ${COMPOSE_FILE} restart ${streamId}`, { stdio: 'ignore' });
    return true;
  } catch (err: any) {
    console.error(`[control-api] Failed to restart ${streamId}:`, err.message);
    return false;
  }
}

function handleSetUrl(streamId: string, url: string): boolean {
  console.log(`[control-api] Changing URL for ${streamId} to ${url}`);
  if (useMock) {
    const stream = mockStreams.find(s => s.id === streamId);
    if (stream) {
      stream.url = url;
      return true;
    }
    return false;
  }

  try {
    // Recreate container with environment variable override
    // We can do this by setting env and executing compose up -d
    const envVarName = `${streamId.toUpperCase().replace(/-/g, '_')}_URL`;
    const command = `${envVarName}='${url}' docker-compose -f ${COMPOSE_FILE} up -d ${streamId}`;
    execSync(command, { stdio: 'ignore' });
    return true;
  } catch (err: any) {
    console.error(`[control-api] Failed to set URL for ${streamId}:`, err.message);
    return false;
  }
}

function getLogs(streamId: string): string {
  if (useMock) {
    return `[mock-logs] ${streamId} running smoothly...\n[health] {"type":"health","ts":"${new Date().toISOString()}","uptimeSec":120.5,"ingest":"srt://...","protocol":"SRT","restartAttempt":0,"lastFfmpegExitCode":null,"retrying":false}`;
  }

  try {
    return execSync(`docker-compose -f ${COMPOSE_FILE} logs --tail=100 ${streamId}`, { encoding: 'utf8' });
  } catch (err: any) {
    return `Error fetching logs: ${err.message}`;
  }
}

// Set up server
const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Serve static files for web dashboard if requested
  if (pathname === '/' || pathname.startsWith('/web/')) {
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace('/web/', '');
    // Resolve inside src/web
    const filePath = path.resolve(__dirname, '..', 'web', relativePath);
    if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
      let contentType = 'text/html';
      if (filePath.endsWith('.css')) contentType = 'text/css';
      if (filePath.endsWith('.js')) contentType = 'application/javascript';
      
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // REST API Route Handling
  if (pathname === '/api/streams' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getDockerComposeStreams()));
    return;
  }

  // Action routes
  const refreshMatch = pathname.match(/^\/api\/streams\/([a-zA-Z0-9_-]+)\/refresh$/);
  if (refreshMatch && req.method === 'POST') {
    const streamId = refreshMatch[1];
    const success = handleRefresh(streamId);
    res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success }));
    return;
  }

  const restartMatch = pathname.match(/^\/api\/streams\/([a-zA-Z0-9_-]+)\/restart$/);
  if (restartMatch && req.method === 'POST') {
    const streamId = restartMatch[1];
    const success = handleRestart(streamId);
    res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success }));
    return;
  }

  const logsMatch = pathname.match(/^\/api\/streams\/([a-zA-Z0-9_-]+)\/logs$/);
  if (logsMatch && req.method === 'GET') {
    const streamId = logsMatch[1];
    const logs = getLogs(streamId);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(logs);
    return;
  }

  const urlMatch = pathname.match(/^\/api\/streams\/([a-zA-Z0-9_-]+)\/url$/);
  if (urlMatch && req.method === 'POST') {
    const streamId = urlMatch[1];
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing url field' }));
          return;
        }
        const success = handleSetUrl(streamId, data.url);
        res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  // Not Found
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`[control-api] Server listening on http://localhost:${PORT}`);
  console.log(`[control-api] Mock mode: ${useMock}`);
});

export default server;

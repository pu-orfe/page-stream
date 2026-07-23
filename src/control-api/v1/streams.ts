import { execFileSync, spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuth } from './auth.js';

const COMPOSE_FILE = process.env.COMPOSE_FILE || 'docker-compose.stable.yml';
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || 'orfe';
const TEST_MODE = process.env.PAGE_STREAM_TEST_MODE === '1';

export interface StreamView {
  id: string;
  name: string;
  image: string;
  state: string;
  health: string | null;
  createdAt: string | null;
}

const MOCK: StreamView[] = [
  { id: 'standard-1', name: 'orfe-standard-1', image: 'page-stream:latest', state: 'running', health: 'healthy', createdAt: null },
  { id: 'compositor', name: 'orfe-compositor',  image: 'linuxserver/ffmpeg:latest', state: 'running', health: 'healthy', createdAt: null },
];

export function listStreams(): StreamView[] {
  if (TEST_MODE) return MOCK;
  try {
    const raw = execFileSync(
      'docker',
      ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, 'ps', '--format', 'json', '--all'],
      { encoding: 'utf8' }
    );
    const rows = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    return rows.map((r: any): StreamView => ({
      id: r.Service,
      name: r.Name,
      image: r.Image,
      state: r.State,
      health: r.Health || null,
      createdAt: r.CreatedAt || null,
    }));
  } catch {
    return [];
  }
}

export async function handleList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ streams: listStreams() }));
}

export async function handleDetail(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const stream = listStreams().find(s => s.id === id);
  if (!stream) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', id }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(stream));
}

export async function handleLogs(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (TEST_MODE) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`[mock] tail -n 100 ${id}\n`);
    return;
  }
  try {
    const out = execFileSync(
      'docker',
      ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, 'logs', '--no-color', '--tail=200', id],
      { encoding: 'utf8' }
    );
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(out);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'logs_failed', message: (err as Error).message }));
  }
}

export async function handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

  if (TEST_MODE) { res.end(); return; }

  const child = spawn('docker', ['events', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      res.write(`event: docker\ndata: ${line}\n\n`);
    }
  });
  req.on('close', () => { child.kill('SIGTERM'); });
}

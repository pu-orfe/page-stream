import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { requireAuth } from './auth.js';

export type ActionKind = 'refresh';

export interface Action {
  id: string;
  kind: ActionKind;
  target: string;
  status: 'pending' | 'succeeded' | 'failed';
  initiatedBy: string;
  createdAt: string;
  completedAt?: string;
  ttlSeconds?: number;
  result?: unknown;
  error?: string;
}

const RING_SIZE = 200;
const store: Action[] = [];

function record(action: Action): void {
  store.push(action);
  if (store.length > RING_SIZE) store.shift();
}

export function listActions(): Action[] {
  return store.slice().reverse();
}

const COMPOSE_FILE = process.env.COMPOSE_FILE || 'docker-compose.stable.yml';
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || 'orfe';
const TEST_MODE = process.env.PAGE_STREAM_TEST_MODE === '1';

function refreshContainer(target: string): void {
  if (TEST_MODE) return;
  try {
    execFileSync(
      'docker',
      ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, 'exec', '-T', target,
        'sh', '-c', 'echo refresh > /tmp/page_refresh_fifo'],
      { stdio: 'ignore' }
    );
  } catch {
    execFileSync(
      'docker',
      ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, 'kill', '-s', 'HUP', target],
      { stdio: 'ignore' }
    );
  }
}

export async function handleActionsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ actions: listActions() }));
}

export async function handleRefresh(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAuth(req, res, 'operator')) return;

  let body = '';
  for await (const chunk of req) body += chunk;
  const parsed = body ? JSON.parse(body) : {};
  const target = parsed.target;
  if (typeof target !== 'string' || !target) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'target required' }));
    return;
  }

  const action: Action = {
    id: randomUUID(),
    kind: 'refresh',
    target,
    status: 'pending',
    initiatedBy: req.principal!.id,
    createdAt: new Date().toISOString(),
    ttlSeconds: 0,
  };
  record(action);

  try {
    refreshContainer(target);
    action.status = 'succeeded';
    action.completedAt = new Date().toISOString();
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(action));
  } catch (err) {
    action.status = 'failed';
    action.error = (err as Error).message;
    action.completedAt = new Date().toISOString();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(action));
  }
}

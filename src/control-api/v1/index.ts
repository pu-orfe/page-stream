import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleList, handleDetail, handleLogs, handleEvents } from './streams.js';
import { handleActionsList, handleRefresh } from './actions.js';
import { handleDrift } from './drift.js';

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }));
}

export async function routeV1(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith('/api/v1/')) return false;

  const method = req.method || 'GET';

  if (pathname === '/api/v1/health' && method === 'GET') { await handleHealth(req, res); return true; }
  if (pathname === '/api/v1/streams' && method === 'GET') { await handleList(req, res); return true; }
  if (pathname === '/api/v1/events' && method === 'GET') { await handleEvents(req, res); return true; }
  if (pathname === '/api/v1/drift' && method === 'GET') { await handleDrift(req, res); return true; }
  if (pathname === '/api/v1/actions' && method === 'GET') { await handleActionsList(req, res); return true; }
  if (pathname === '/api/v1/actions/refresh' && method === 'POST') { await handleRefresh(req, res); return true; }

  const detail = pathname.match(/^\/api\/v1\/streams\/([a-zA-Z0-9_-]+)$/);
  if (detail && method === 'GET') { await handleDetail(req, res, detail[1]); return true; }

  const logs = pathname.match(/^\/api\/v1\/streams\/([a-zA-Z0-9_-]+)\/logs$/);
  if (logs && method === 'GET') { await handleLogs(req, res, logs[1]); return true; }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', pathname }));
  return true;
}

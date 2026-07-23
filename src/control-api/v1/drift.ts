import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuth } from './auth.js';

const COMPOSE_FILE = process.env.COMPOSE_FILE || 'docker-compose.stable.yml';
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || 'orfe';
const CONFIG_ENV_FILE = process.env.CONFIG_ENV_FILE || '/config/orfe.env';
const CONFIG_GIT_SHA = process.env.CONFIG_GIT_SHA || 'unknown';
const TEST_MODE = process.env.PAGE_STREAM_TEST_MODE === '1';

export interface Discrepancy {
  service: string;
  key: string;
  runtime: string;
  desired: string;
  kind: 'env-differs' | 'env-missing-runtime' | 'env-missing-desired';
}

export interface DriftReport {
  inSync: boolean;
  configSha: string;
  checkedAt: string;
  discrepancies: Discrepancy[];
}

function parseEnvFile(path: string): Record<string, string> {
  if (!fs.existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function runtimeEnv(): Record<string, Record<string, string>> {
  if (TEST_MODE) return {};
  try {
    const raw = execFileSync(
      'docker',
      ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, 'ps', '--format', '{{.Service}} {{.Names}}'],
      { encoding: 'utf8' }
    );
    const services: Record<string, Record<string, string>> = {};
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      const [service, name] = line.split(' ');
      if (!name) continue;
      try {
        const inspect = execFileSync('docker', ['inspect', '--format', '{{json .Config.Env}}', name], { encoding: 'utf8' });
        const envArr: string[] = JSON.parse(inspect.trim());
        const env: Record<string, string> = {};
        for (const kv of envArr) {
          const eq = kv.indexOf('=');
          if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
        services[service] = env;
      } catch { /* skip container that vanished mid-inspect */ }
    }
    return services;
  } catch {
    return {};
  }
}

const WATCH_KEYS = /^(STANDARD_\d+_(URL|INJECT_(CSS|JS)|INGEST)|SOURCE_(LEFT|RIGHT)_(URL|INGEST|INJECT_(CSS|JS))|COMPOSITOR_INGEST)$/;

export function computeDrift(): DriftReport {
  const desired = parseEnvFile(CONFIG_ENV_FILE);
  const runtime = runtimeEnv();
  const discrepancies: Discrepancy[] = [];

  for (const [service, env] of Object.entries(runtime)) {
    for (const key of Object.keys(env)) {
      if (!WATCH_KEYS.test(key)) continue;
      if (!(key in desired)) {
        discrepancies.push({ service, key, runtime: env[key], desired: '', kind: 'env-missing-desired' });
      } else if (desired[key] !== env[key]) {
        discrepancies.push({ service, key, runtime: env[key], desired: desired[key], kind: 'env-differs' });
      }
    }
    for (const key of Object.keys(desired)) {
      if (!WATCH_KEYS.test(key)) continue;
      if (!(key in env) && key.toLowerCase().includes(service.toLowerCase().replace(/-/g, '_'))) {
        discrepancies.push({ service, key, runtime: '', desired: desired[key], kind: 'env-missing-runtime' });
      }
    }
  }

  return {
    inSync: discrepancies.length === 0,
    configSha: CONFIG_GIT_SHA,
    checkedAt: new Date().toISOString(),
    discrepancies,
  };
}

export async function handleDrift(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(computeDrift()));
}

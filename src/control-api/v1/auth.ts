import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Principal {
  id: string;
  name: string;
  roles: string[];
  provider: string;
}

declare module 'node:http' {
  interface IncomingMessage {
    principal?: Principal;
  }
}

const DEV_AUTH = process.env.PAGE_STREAM_DEV_AUTH === '1';
const TEST_MODE = process.env.PAGE_STREAM_TEST_MODE === '1';

function decodeEasyAuth(header: string | string[] | undefined): Principal | null {
  if (!header || Array.isArray(header)) return null;
  try {
    const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const claims: Array<{ typ: string; val: string }> = payload.claims ?? [];
    const roles = claims.filter(c => c.typ === 'roles').map(c => c.val);
    const nameClaim = claims.find(c => c.typ === 'name' || c.typ === 'preferred_username');
    return {
      id: payload.name_typ ? payload.userDetails : payload.userId ?? 'unknown',
      name: nameClaim?.val ?? payload.userDetails ?? 'unknown',
      roles: roles.length ? roles : ['viewer'],
      provider: payload.identityProvider ?? 'aad',
    };
  } catch {
    return null;
  }
}

export function authenticate(req: IncomingMessage): Principal | null {
  if (TEST_MODE) {
    return { id: 'test-user', name: 'Test User', roles: ['viewer', 'operator'], provider: 'test' };
  }
  if (DEV_AUTH) {
    const devUser = req.headers['x-dev-user'];
    if (typeof devUser === 'string' && devUser) {
      const [id, ...roles] = devUser.split(':');
      return { id, name: id, roles: roles.length ? roles : ['viewer'], provider: 'dev' };
    }
  }
  return decodeEasyAuth(req.headers['x-ms-client-principal']);
}

export function requireAuth(req: IncomingMessage, res: ServerResponse, requiredRole?: string): boolean {
  const principal = authenticate(req);
  if (!principal) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthenticated', hint: 'Access via the Easy Auth-fronted endpoint.' }));
    return false;
  }
  if (requiredRole && !principal.roles.includes(requiredRole)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden', required: requiredRole, have: principal.roles }));
    return false;
  }
  req.principal = principal;
  return true;
}

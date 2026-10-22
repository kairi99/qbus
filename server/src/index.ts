import { makeCode, normalizeCode } from '../../src/net/protocol';

export { Room } from './roomDO';

export interface Env {
  ROOM: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
}

const cryptoRand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

function allowed(req: Request, env: Env): boolean {
  const origin = req.headers.get('Origin');
  if (!origin) return true;
  return env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin);
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin');
  return origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
    : {};
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    if (!allowed(req, env)) return new Response('forbidden', { status: 403 });

    if (url.pathname === '/rooms') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(req), 'Access-Control-Max-Age': '86400' } });
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      for (let i = 0; i < 8; i++) {
        const code = makeCode(cryptoRand);
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const r = await stub.fetch(`https://room/init?code=${code}`, { method: 'POST' });
        if (r.status === 201) {
          return new Response(JSON.stringify({ code }), { status: 201, headers: { 'Content-Type': 'application/json', ...cors(req) } });
        }
      }
      return new Response('no free code', { status: 503, headers: cors(req) });
    }

    // Does a room exist (and take new players)? The menu asks before joining: a WebSocket
    // that fails its handshake can't tell "no such room" from a network blip.
    const info = /^\/rooms\/([^/]+)$/.exec(url.pathname);
    if (info && req.method === 'GET') {
      const code = normalizeCode(decodeURIComponent(info[1]));
      if (!code) return new Response('bad code', { status: 400, headers: cors(req) });
      const r = await env.ROOM.get(env.ROOM.idFromName(code)).fetch('https://room/info');
      return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json', ...cors(req) } });
    }

    const m = /^\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
    if (m) {
      if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
      const code = normalizeCode(decodeURIComponent(m[1]));
      if (!code) return new Response('bad code', { status: 400 });
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(req);
    }
    return new Response('not found', { status: 404 });
  },
};

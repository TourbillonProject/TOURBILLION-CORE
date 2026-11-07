import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { ServerEvent } from '@tc/shared';
import { APP_VERSION } from './config.js';
import type { Ctx } from './context.js';
import { SESSION_COOKIE } from './security/auth.js';

/**
 * Checks the Origin of a WebSocket upgrade. Browsers send cookies on
 * cross-site WebSocket handshakes, so without this check any website could
 * open a socket as the signed-in owner (cross-site WebSocket hijacking).
 */
export function originAllowed(req: FastifyRequest, publicUrl: string | null): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  if (host && o.host === host) return true;
  if (publicUrl && o.origin === new URL(publicUrl).origin) return true;
  return false;
}

export function registerClientSocket(app: FastifyInstance, ctx: Ctx) {
  const clients = new Set<WebSocket>();

  ctx.bus.on((event: ServerEvent) => {
    const msg = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  });

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const sid = ctx.auth.validateSession(req.cookies?.[SESSION_COOKIE]);
    if (!sid || !originAllowed(req, ctx.config.publicUrl)) {
      socket.close(4401, 'unauthorized');
      return;
    }
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'hello', serverTime: new Date().toISOString(), version: APP_VERSION } satisfies ServerEvent));
    let alive = true;
    socket.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 25_000);
    socket.on('message', (raw) => {
      // Clients only send keep-alives; everything else goes through authenticated HTTP routes.
      if (String(raw) === 'ping') socket.send('{"type":"pong"}');
    });
    socket.on('close', () => {
      clearInterval(ping);
      clients.delete(socket);
    });
  });

  return { count: () => clients.size };
}

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Security headers for every response. The CSP allows exactly what the PWA
 * needs: its own scripts, the official YouTube IFrame Player API, YouTube's
 * privacy-enhanced embed domain, and https images (reader mode, thumbnails).
 */
export function securityHeaders(isHttps: (req: FastifyRequest) => boolean) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '';
    const csp = [
      "default-src 'self'",
      "script-src 'self' https://www.youtube.com https://s.ytimg.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      `connect-src 'self' wss://${host} ws://${host}`,
      'frame-src https://www.youtube-nocookie.com https://www.youtube.com',
      "worker-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    reply.header('Content-Security-Policy', csp);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    // YouTube embeds require a referrer; this keeps it to the origin only for cross-site requests.
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (isHttps(req)) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  };
}

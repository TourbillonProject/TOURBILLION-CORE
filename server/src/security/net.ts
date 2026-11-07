import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

/**
 * Outbound network guard (SSRF defence).
 *
 * Every server-side fetch made on behalf of the owner or an agent goes through
 * `safeFetch`. It refuses non-HTTP(S) schemes, resolves the hostname itself
 * and refuses private, loopback, link-local and reserved addresses, and pins
 * the TCP connection to the address it validated (so DNS rebinding cannot
 * swap in an internal address between check and connect). Redirects are
 * followed manually and re-validated on every hop.
 */

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['100::', 64],
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) embed an IPv4 address.
    const embedded = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (embedded) return blocked.check(embedded[1], 'ipv4');
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
    }
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP at all — treat as unsafe
}

export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkPolicyError';
  }
}

export interface NetPolicy {
  allowPrivateNetwork: boolean;
  /** Exact hostnames that may resolve to private addresses (e.g. a LAN SearXNG). Redirects away from them are still checked. */
  trustedHosts?: string[];
}

export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NetworkPolicyError(`Not a valid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkPolicyError(`Only http and https URLs are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) throw new NetworkPolicyError('URLs with embedded credentials are not allowed');
  return url;
}

/** Resolves a hostname and validates every address against the policy. */
export async function resolveAllowed(hostname: string, policy: NetPolicy): Promise<{ address: string; family: number }[]> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const trusted = policy.allowPrivateNetwork || (policy.trustedHosts ?? []).includes(host.toLowerCase());
  let addrs: { address: string; family: number }[];
  if (net.isIP(host)) {
    addrs = [{ address: host, family: net.isIP(host) }];
  } else {
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host) && !trusted) {
      throw new NetworkPolicyError(`Blocked internal hostname: ${host}`);
    }
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  }
  if (!trusted) {
    const bad = addrs.find((a) => isPrivateAddress(a.address));
    if (bad) throw new NetworkPolicyError(`Blocked private or reserved address ${bad.address} for ${host}`);
  }
  if (addrs.length === 0) throw new NetworkPolicyError(`Could not resolve ${host}`);
  return addrs;
}

export interface SafeFetchOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  policy: NetPolicy;
  signal?: AbortSignal;
}

export interface SafeResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  redirects: string[];
  body: Buffer;
  truncated: boolean;
  text(): string;
  json<T = unknown>(): T;
}

export const DEFAULT_UA = 'TourbillionCore/0.1 (+personal research assistant)';

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeResponse> {
  const redirects: string[] = [];
  let current = parsePublicUrl(rawUrl);
  let method = opts.method ?? 'GET';
  let body = opts.body;
  const maxRedirects = opts.maxRedirects ?? 5;

  for (let hop = 0; ; hop++) {
    const addrs = await resolveAllowed(current.hostname, opts.policy);
    const pinned = addrs[0];
    const res = await requestOnce(current, method, body, opts, pinned);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      if (hop >= maxRedirects) throw new NetworkPolicyError(`Too many redirects (>${maxRedirects})`);
      const next = parsePublicUrl(new URL(res.headers.location, current).toString());
      redirects.push(next.toString());
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      current = next;
      continue;
    }
    return { ...res, url: current.toString(), redirects };
  }
}

function requestOnce(
  url: URL,
  method: string,
  body: string | Buffer | undefined,
  opts: SafeFetchOptions,
  pinned: { address: string; family: number },
): Promise<Omit<SafeResponse, 'url' | 'redirects'>> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        headers: {
          'user-agent': DEFAULT_UA,
          accept: '*/*',
          'accept-encoding': 'gzip, deflate, br',
          ...(opts.headers ?? {}),
          ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
        },
        timeout: opts.timeoutMs ?? 15_000,
        // Pin the connection to the validated address.
        lookup: (_host, _o, cb) => {
          (cb as (err: Error | null, address: string, family: number) => void)(null, pinned.address, pinned.family);
        },
        signal: opts.signal,
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        }
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          return resolve(makeResponse(status, headers, Buffer.alloc(0), false));
        }
        let stream: NodeJS.ReadableStream = res;
        const enc = (headers['content-encoding'] ?? '').toLowerCase();
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on('data', (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            res.destroy();
            resolve(makeResponse(status, headers, Buffer.concat(chunks), true));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => {
          if (!truncated) resolve(makeResponse(status, headers, Buffer.concat(chunks), false));
        });
        stream.on('error', (e) => {
          if (!truncated) reject(e);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${opts.timeoutMs ?? 15_000} ms`)));
    req.on('error', reject);
    if (body && method !== 'GET' && method !== 'HEAD') req.write(body);
    req.end();
  });
}

function makeResponse(status: number, headers: Record<string, string>, body: Buffer, truncated: boolean) {
  return {
    status,
    headers,
    body,
    truncated,
    text: () => body.toString('utf8'),
    json: <T>() => JSON.parse(body.toString('utf8')) as T,
  };
}

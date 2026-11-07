/** Thin fetch wrapper. Adds the CSRF verification header and normalises errors. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Json = Record<string, unknown> | unknown[];

async function request<T>(method: string, path: string, body?: Json | FormData, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-tc-request': '1', accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  opts.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted && !opts.signal?.aborted) throw new ApiError('The server took too long to respond.', 0, 'timeout');
    if (opts.signal?.aborted) throw err;
    throw new ApiError(navigator.onLine ? 'Cannot reach the TOURBILLION server. It may be offline or restarting.' : 'This iPad is offline.', 0, 'network');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as { message?: string; error?: string };
    if (res.status === 401 && d.error === 'unauthenticated') window.dispatchEvent(new CustomEvent('tc:unauthenticated'));
    throw new ApiError(d.message ?? `Request failed (${res.status})`, res.status, d.error ?? 'error');
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, opts?: { signal?: AbortSignal; timeoutMs?: number }) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body: Json | FormData = {}, opts?: { signal?: AbortSignal; timeoutMs?: number }) => request<T>('POST', path, body, opts),
  patch: <T>(path: string, body: Json) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { nowIso } from '../db.js';
import { safeFetch, type NetPolicy } from '../security/net.js';
import type { SecretStore } from '../security/secrets.js';
import type { IntegrationRegistry } from '../services/integrations.js';

/**
 * Gmail via Google's official OAuth 2.0 (authorization code + PKCE) and the
 * Gmail REST API. Tokens are stored encrypted on the server. The owner's
 * Google password is never seen by TOURBILLION CORE.
 *
 * Requires a Google Cloud OAuth client (Web application) with redirect URI
 * <TC_PUBLIC_URL>/api/integrations/gmail/callback — see docs/SETUP.md.
 */

const TOKEN_SECRET = 'gmail.tokens';
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  email?: string;
}

export interface MailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
}

export interface MailMessage extends MailSummary {
  body: string;
}

export class GmailService {
  constructor(
    private config: AppConfig,
    private db: Database,
    private secrets: SecretStore,
    private policy: NetPolicy,
    private integrations: IntegrationRegistry,
  ) {
    integrations.register({
      id: 'gmail',
      name: 'Gmail',
      description: 'Search, read and summarise mail; draft replies; organise labels. Sending always asks for approval.',
      permissions: ['gmail.modify: read messages, manage labels, create drafts, send (approval-gated)', 'No permanent deletion'],
      requires: ['TC_GOOGLE_CLIENT_ID', 'TC_GOOGLE_CLIENT_SECRET', 'TC_PUBLIC_URL (https) for the OAuth redirect'],
      isConfigured: () => this.oauthConfigured(),
      details: () => ({ account: this.secrets.getJson<Tokens>(TOKEN_SECRET)?.email ?? null, authorised: this.isConnected(), redirectUri: this.redirectUri() }),
      test: async () => {
        if (!this.isConnected()) throw new Error('Not authorised yet. Use “Connect” to sign in with Google.');
        const p = await this.api<{ emailAddress: string; messagesTotal: number }>('/users/me/profile');
        return { account: p.emailAddress, messagesTotal: p.messagesTotal };
      },
      disconnect: () => this.disconnect(),
      canConnect: true,
    });
  }

  oauthConfigured() {
    return !!(this.config.google.clientId && this.config.google.clientSecret && this.config.publicUrl);
  }

  isConnected() {
    return !!this.secrets.getJson<Tokens>(TOKEN_SECRET)?.refresh_token;
  }

  redirectUri() {
    return this.config.publicUrl ? `${this.config.publicUrl}/api/integrations/gmail/callback` : null;
  }

  startAuth(sessionId: string): string {
    if (!this.oauthConfigured()) throw new Error('Gmail OAuth is not configured on the server (TC_GOOGLE_CLIENT_ID, TC_GOOGLE_CLIENT_SECRET, TC_PUBLIC_URL).');
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    this.db.run('DELETE FROM oauth_states WHERE created_at < ?', new Date(Date.now() - 15 * 60_000).toISOString());
    this.db.run('INSERT INTO oauth_states(state, provider, verifier, session_id, created_at) VALUES (?, ?, ?, ?, ?)', state, 'gmail', verifier, sessionId, nowIso());
    const params = new URLSearchParams({
      client_id: this.config.google.clientId!,
      redirect_uri: this.redirectUri()!,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${this.config.endpoints.googleOAuth}?${params}`;
  }

  async handleCallback(code: string, state: string, sessionId: string) {
    const row = this.db.get<{ verifier: string; session_id: string; created_at: string }>('SELECT verifier, session_id, created_at FROM oauth_states WHERE state = ? AND provider = ?', state, 'gmail');
    this.db.run('DELETE FROM oauth_states WHERE state = ?', state);
    if (!row) throw new Error('Unknown or expired OAuth state. Start the connection again.');
    if (row.session_id !== sessionId) throw new Error('OAuth state belongs to a different session.');
    if (Date.now() - Date.parse(row.created_at) > 15 * 60_000) throw new Error('OAuth state expired. Start again.');
    const body = new URLSearchParams({
      code,
      client_id: this.config.google.clientId!,
      client_secret: this.config.google.clientSecret!,
      redirect_uri: this.redirectUri()!,
      grant_type: 'authorization_code',
      code_verifier: row.verifier,
    }).toString();
    const res = await safeFetch(this.config.endpoints.googleToken, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, policy: this.policy, timeoutMs: 20_000 });
    const data = res.json<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string; scope?: string }>();
    if (res.status !== 200 || !data.access_token || !data.refresh_token) {
      throw new Error(`Google token exchange failed: ${data.error_description ?? data.error ?? `HTTP ${res.status}`}${!data.refresh_token && data.access_token ? ' (no refresh token returned)' : ''}`);
    }
    this.secrets.setJson(TOKEN_SECRET, { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 } satisfies Tokens);
    const p = await this.api<{ emailAddress: string }>('/users/me/profile');
    const t = this.secrets.getJson<Tokens>(TOKEN_SECRET)!;
    this.secrets.setJson(TOKEN_SECRET, { ...t, email: p.emailAddress });
    this.integrations.markSuccess('gmail', { account: p.emailAddress });
    return p.emailAddress;
  }

  private async accessToken(force = false): Promise<string> {
    const t = this.secrets.getJson<Tokens>(TOKEN_SECRET);
    if (!t) throw new Error('Gmail is not connected.');
    if (!force && t.expires_at - 60_000 > Date.now()) return t.access_token;
    const body = new URLSearchParams({ client_id: this.config.google.clientId ?? '', client_secret: this.config.google.clientSecret ?? '', refresh_token: t.refresh_token, grant_type: 'refresh_token' }).toString();
    const res = await safeFetch(this.config.endpoints.googleToken, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, policy: this.policy, timeoutMs: 20_000 });
    const data = res.json<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>();
    if (res.status !== 200 || !data.access_token) {
      const msg = `Google token refresh failed (${data.error ?? res.status}). The authorisation may have been revoked or expired — reconnect Gmail.`;
      this.integrations.markError('gmail', msg);
      throw new Error(msg);
    }
    this.secrets.setJson(TOKEN_SECRET, { ...t, access_token: data.access_token, expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 });
    return data.access_token;
  }

  private async api<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}, retried = false): Promise<T> {
    const token = await this.accessToken(retried);
    const res = await safeFetch(`${this.config.endpoints.gmail}${path}`, {
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      policy: this.policy,
      timeoutMs: 30_000,
    });
    if (res.status === 401 && !retried) return this.api<T>(path, init, true);
    if (res.status < 200 || res.status >= 300) {
      let msg = `Gmail API HTTP ${res.status}`;
      try {
        msg += `: ${res.json<{ error?: { message?: string } }>().error?.message ?? ''}`;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    return (res.body.length ? res.json<T>() : ({} as T));
  }

  async disconnect() {
    const t = this.secrets.getJson<Tokens>(TOKEN_SECRET);
    if (t?.refresh_token) {
      try {
        await safeFetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token)}`, { method: 'POST', policy: this.policy, timeoutMs: 10_000, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      } catch {
        /* revocation is best-effort; local tokens are deleted regardless */
      }
    }
    this.secrets.delete(TOKEN_SECRET);
  }

  async search(q: string, max = 15): Promise<MailSummary[]> {
    const list = await this.api<{ messages?: { id: string; threadId: string }[] }>(`/users/me/messages?${new URLSearchParams({ q, maxResults: String(Math.min(max, 50)) })}`);
    const out: MailSummary[] = [];
    for (const m of list.messages ?? []) {
      const msg = await this.api<GmailMessage>(`/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
      out.push(summarise(msg));
    }
    return out;
  }

  async readThread(threadId: string): Promise<{ id: string; messages: MailMessage[] }> {
    if (!/^[A-Za-z0-9]+$/.test(threadId)) throw new Error('Invalid thread id');
    const t = await this.api<{ id: string; messages: GmailMessage[] }>(`/users/me/threads/${threadId}?format=full`);
    return { id: t.id, messages: t.messages.map((m) => ({ ...summarise(m), body: extractBody(m.payload).slice(0, 50_000) })) };
  }

  async createDraft(d: { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string; cc?: string }): Promise<{ draftId: string; messageId: string }> {
    const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
    const headers = [
      `To: ${clean(d.to)}`,
      ...(d.cc ? [`Cc: ${clean(d.cc)}`] : []),
      `Subject: ${encodeHeader(clean(d.subject))}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      ...(d.inReplyTo ? [`In-Reply-To: ${clean(d.inReplyTo)}`, `References: ${clean(d.inReplyTo)}`] : []),
    ];
    const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${d.body}`, 'utf8').toString('base64url');
    const r = await this.api<{ id: string; message: { id: string } }>('/users/me/drafts', { method: 'POST', body: { message: { raw, ...(d.threadId ? { threadId: d.threadId } : {}) } } });
    return { draftId: r.id, messageId: r.message.id };
  }

  async getDraft(draftId: string): Promise<{ id: string; to: string; subject: string; body: string }> {
    const d = await this.api<{ id: string; message: GmailMessage }>(`/users/me/drafts/${encodeURIComponent(draftId)}?format=full`);
    const s = summarise(d.message);
    return { id: d.id, to: s.to, subject: s.subject, body: extractBody(d.message.payload) };
  }

  async sendDraft(draftId: string): Promise<{ id: string; threadId: string }> {
    return this.api<{ id: string; threadId: string }>('/users/me/drafts/send', { method: 'POST', body: { id: draftId } });
  }

  async modifyThread(threadId: string, add: string[], remove: string[]) {
    return this.api(`/users/me/threads/${encodeURIComponent(threadId)}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } });
  }

  async labels(): Promise<{ id: string; name: string; type: string }[]> {
    return (await this.api<{ labels: { id: string; name: string; type: string }[] }>('/users/me/labels')).labels;
  }
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  payload: GmailPart;
}

function header(m: GmailMessage, name: string): string {
  return m.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function summarise(m: GmailMessage): MailSummary {
  return { id: m.id, threadId: m.threadId, from: header(m, 'From'), to: header(m, 'To'), subject: header(m, 'Subject'), date: header(m, 'Date'), snippet: m.snippet ?? '', labels: m.labelIds ?? [] };
}

function decode(data?: string): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

export function extractBody(p: GmailPart): string {
  const plain = findPart(p, 'text/plain');
  if (plain) return decode(plain.body?.data);
  const html = findPart(p, 'text/html');
  if (html) return htmlToText(decode(html.body?.data));
  return decode(p.body?.data);
}

function findPart(p: GmailPart, mime: string): GmailPart | null {
  if (p.mimeType === mime && p.body?.data) return p;
  for (const c of p.parts ?? []) {
    const f = findPart(c, mime);
    if (f) return f;
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function encodeHeader(s: string): string {
  // RFC 2047 encoded-word for non-ASCII subjects.
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

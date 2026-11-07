import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for the Anthropic Messages API that speaks the real wire
 * protocol (SSE events) so the official SDK, our streaming loop, tool use,
 * thinking blocks, refusals and structured output are exercised for real.
 * It is a test double: it returns scripted turns, not model output.
 */

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; name: string; input: unknown; id?: string };

export interface ScriptedTurn {
  blocks: Block[];
  stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn';
  /** Optional predicate: only use this turn when the request matches. */
  when?: (req: any) => boolean;
}

export interface FakeAnthropic {
  url: string;
  key: string;
  requests: { path: string; headers: http.IncomingHttpHeaders; body: any }[];
  queue: ScriptedTurn[];
  close: () => Promise<void>;
}

let seq = 0;

export async function startFakeAnthropic(key = 'sk-ant-test-0123456789abcdefghij'): Promise<FakeAnthropic> {
  const state: FakeAnthropic = { url: '', key, requests: [], queue: [], close: async () => {} };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      const auth = String(req.headers.authorization ?? '') || `Bearer ${String(req.headers['x-api-key'] ?? '')}`;
      if (auth !== `Bearer ${key}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' }));
        return;
      }
      if (req.method === 'POST' && path === '/v1/messages') {
        const body = JSON.parse(raw || '{}');
        state.requests.push({ path: req.url ?? '', headers: req.headers, body });
        const idx = state.queue.findIndex((t) => !t.when || t.when(body));
        const turn = idx >= 0 ? state.queue.splice(idx, 1)[0] : { blocks: [{ type: 'text', text: '(fake: no scripted turn left)' }] as Block[] };
        stream(res, turn, body.model ?? 'claude-opus-5-5');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"not_found_error","message":"no route"}}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}

function stream(res: http.ServerResponse, turn: ScriptedTurn, model: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const hasTool = turn.blocks.some((b) => b.type === 'tool_use');
  const stop = turn.stop_reason ?? (hasTool ? 'tool_use' : 'end_turn');
  send('message_start', {
    type: 'message_start',
    message: { id: `msg_fake_${++seq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 } },
  });
  turn.blocks.forEach((b, index) => {
    if (b.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const chunk of b.text.match(/.{1,12}/gs) ?? []) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk } });
    } else if (b.type === 'thinking') {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig_fake' } });
    } else {
      const id = b.id ?? `toolu_fake_${++seq}`;
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      for (const chunk of json.match(/.{1,20}/gs) ?? []) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: chunk } });
    }
    send('content_block_stop', { type: 'content_block_stop', index });
  });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stop, stop_sequence: null, ...(stop === 'refusal' ? { stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined by fake classifier' } } : {}) },
    usage: { output_tokens: 42 },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

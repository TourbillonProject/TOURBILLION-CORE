import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, StopReason, ToolCall, TurnRequest, TurnResult } from './types.js';
import { ProviderError, ProviderNotConfiguredError } from './types.js';

/**
 * Anthropic Claude provider (official SDK).
 *
 * - Streams every turn (long outputs never hit HTTP timeouts).
 * - Adaptive thinking with summarized display, so the UI can show genuine
 *   reasoning progress rather than a fake spinner.
 * - Server-side refusal fallback (`fallbacks: "default"`), with `refusal`
 *   handled explicitly before content is used.
 * - The API key is read from the server-side secret store per request; it is
 *   never sent to the browser.
 */
export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic Claude';

  constructor(
    private getApiKey: () => string | null,
    private baseURL: string,
  ) {}

  isConfigured() {
    return !!this.getApiKey();
  }

  private client(): Anthropic {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new ProviderNotConfiguredError();
    return new Anthropic({ apiKey, authToken: null, baseURL: this.baseURL, maxRetries: 2, timeout: 10 * 60_000 });
  }

  async test(): Promise<Record<string, unknown>> {
    try {
      const page = await this.client().models.list({ limit: 20 });
      const ids = page.data.map((m) => m.id);
      return { models: ids.slice(0, 20), checkedAt: new Date().toISOString() };
    } catch (err) {
      throw mapError(err);
    }
  }

  async streamTurn(req: TurnRequest, model: string): Promise<TurnResult> {
    const client = this.client();
    const tools: Anthropic.Beta.BetaToolUnion[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    }));
    if (req.webSearch) {
      tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 } as Anthropic.Beta.BetaToolUnion);
    }

    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model,
      max_tokens: req.maxTokens ?? 32000,
      // Stable system prompt first and cached; volatile context travels in the user turn.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: req.messages as Anthropic.Beta.BetaMessageParam[],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: {
        effort: req.effort ?? 'medium',
        ...(req.outputSchema ? { format: { type: 'json_schema', schema: req.outputSchema } } : {}),
      },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      stream: true,
      ...(tools.length ? { tools } : {}),
    };

    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = client.beta.messages.stream(params, { signal: req.signal });
      stream.on('text', (d) => req.onText?.(d));
      stream.on('thinking', (d) => req.onThinking?.(d));
      stream.on('contentBlock', (block) => {
        if (block.type === 'server_tool_use') req.onServerTool?.(block.name, block.input);
      });
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError) throw err;
      throw mapError(err);
    }

    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const block of message.content) {
      if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
      else if (block.type === 'text') text += block.text;
    }
    const iterations = (message.usage.iterations ?? []) as { type: string }[];
    const fellBack = iterations.some((i) => i.type === 'fallback_message');
    const stop = (message.stop_reason ?? 'other') as string;
    const stopReason: StopReason = ['end_turn', 'tool_use', 'max_tokens', 'pause_turn', 'refusal', 'stop_sequence'].includes(stop)
      ? (stop as StopReason)
      : 'other';

    return {
      content: message.content as unknown[],
      stopReason,
      toolCalls,
      text,
      model: message.model,
      servedBy: fellBack ? message.model : null,
      refusal:
        stopReason === 'refusal'
          ? { category: message.stop_details?.category ?? null, explanation: message.stop_details?.explanation ?? null }
          : null,
      usage: {
        inputTokens: message.usage.input_tokens ?? 0,
        outputTokens: message.usage.output_tokens ?? 0,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        webSearches: message.usage.server_tool_use?.web_search_requests ?? 0,
      },
    };
  }
}

function mapError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof ProviderNotConfiguredError) return new ProviderError(err.message, 'auth');
  if (err instanceof Anthropic.AuthenticationError) {
    return new ProviderError('Anthropic rejected the API key (401). It may be invalid, revoked or expired.', 'auth', 401);
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(`Anthropic denied access (403): ${err.message}`, 'auth', 403);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError('Anthropic rate limit reached (429). Wait a moment and try again.', 'rate_limit', 429);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new ProviderError(`Anthropic rejected the request (400): ${err.message}`, 'bad_request', 400);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderError(`Model or endpoint not found (404): ${err.message}`, 'bad_request', 404);
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new ProviderError(`Anthropic service error (${err.status}). Try again shortly.`, 'overloaded', err.status);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError('Could not reach the Anthropic API. Check the server’s network connection.', 'network');
  }
  if (err instanceof Anthropic.APIError) {
    return new ProviderError(`Anthropic API error ${err.status ?? ''}: ${err.message}`, err.status === 529 ? 'overloaded' : 'other', err.status);
  }
  if (err instanceof Anthropic.AnthropicError) {
    // e.g. a tool input the stream could not parse as JSON
    return new ProviderError(err.message, 'invalid_output');
  }
  return new ProviderError(err instanceof Error ? err.message : String(err), 'other');
}

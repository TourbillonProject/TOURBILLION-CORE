/**
 * Provider-neutral model interface. The orchestration layer talks to
 * `AIProvider`; a provider translates to its own wire format. Message content
 * blocks are stored exactly as the provider returned them so that later turns
 * can be replayed byte-for-byte (required for Claude's thinking blocks).
 */

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: unknown[] | string;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'pause_turn' | 'refusal' | 'stop_sequence' | 'other';

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

export interface TurnRequest {
  system: string;
  messages: StoredMessage[];
  tools: ToolSpec[];
  webSearch?: boolean;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** JSON schema the final answer must follow (structured outputs). */
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onServerTool?: (name: string, input: unknown) => void;
}

export interface TurnResult {
  content: unknown[];
  stopReason: StopReason;
  toolCalls: ToolCall[];
  text: string;
  usage: TurnUsage;
  model: string;
  refusal: { category: string | null; explanation: string | null } | null;
  /** Set when a server-side fallback model served the turn. */
  servedBy: string | null;
}

export class ProviderNotConfiguredError extends Error {
  constructor(message = 'No AI provider is connected. Open Connected Apps → Claude to connect one.') {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate_limit' | 'overloaded' | 'bad_request' | 'network' | 'invalid_output' | 'other',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  get retryable() {
    return this.kind === 'rate_limit' || this.kind === 'overloaded' || this.kind === 'network';
  }
}

export interface AIProvider {
  readonly id: string;
  readonly name: string;
  isConfigured(): boolean;
  /** Performs a real authenticated round-trip; resolves with non-secret details. */
  test(): Promise<Record<string, unknown>>;
  streamTurn(req: TurnRequest, model: string): Promise<TurnResult>;
}

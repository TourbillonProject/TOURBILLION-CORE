import type { AppConfig } from '../config.js';
import type { SecretStore } from '../security/secrets.js';
import type { SettingsStore } from '../services/core.js';
import type { IntegrationRegistry } from '../services/integrations.js';
import { AnthropicProvider } from './anthropic.js';
import type { AIProvider, TurnRequest, TurnResult } from './types.js';
import { ProviderError, ProviderNotConfiguredError } from './types.js';

export const ANTHROPIC_SECRET = 'anthropic.api_key';

/**
 * Owns the model providers. Today: Anthropic Claude (primary). Additional
 * providers implement `AIProvider` and register here; nothing else changes.
 */
export class AIService {
  private providers = new Map<string, AIProvider>();
  private activeId = 'anthropic';
  /** Test hook: replace the provider (never exposed over HTTP). */
  override: AIProvider | null = null;

  constructor(
    private config: AppConfig,
    private secrets: SecretStore,
    private settings: SettingsStore,
    private integrations: IntegrationRegistry,
  ) {
    const anthropic = new AnthropicProvider(() => this.anthropicKey(), config.anthropic.baseUrl);
    this.providers.set(anthropic.id, anthropic);

    integrations.register({
      id: 'claude',
      name: 'Anthropic Claude',
      description: 'Primary reasoning engine. Uses an Anthropic API key stored encrypted on the server.',
      permissions: ['Send prompts and context to the Anthropic Messages API', 'Optional: Anthropic server-side web search (billed per search)'],
      requires: ['Anthropic API key (console.anthropic.com) — API billing is separate from a Claude.ai subscription'],
      isConfigured: () => !!this.anthropicKey(),
      details: () => ({
        keySource: this.keySource(),
        model: this.model(),
        effort: this.settings.get('aiEffort'),
        webSearch: this.settings.get('aiWebSearch'),
      }),
      test: async () => this.provider().test(),
      disconnect: () => this.removeKey(),
    });
  }

  private anthropicKey(): string | null {
    return this.secrets.get(ANTHROPIC_SECRET) ?? this.config.anthropic.apiKey ?? null;
  }

  keySource(): 'stored' | 'environment' | 'none' {
    if (this.secrets.has(ANTHROPIC_SECRET)) return 'stored';
    if (this.config.anthropic.apiKey) return 'environment';
    return 'none';
  }

  setKey(key: string) {
    this.secrets.set(ANTHROPIC_SECRET, key.trim());
  }

  removeKey() {
    this.secrets.delete(ANTHROPIC_SECRET);
  }

  provider(): AIProvider {
    if (this.override) return this.override;
    const p = this.providers.get(this.activeId);
    if (!p) throw new ProviderNotConfiguredError();
    return p;
  }

  isReady(): boolean {
    return this.provider().isConfigured();
  }

  model(): string {
    return this.settings.get('aiModel') || this.config.anthropic.defaultModel;
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const provider = this.provider();
    if (!provider.isConfigured()) throw new ProviderNotConfiguredError();
    try {
      const result = await provider.streamTurn({ effort: this.settings.get('aiEffort'), ...req }, this.model());
      this.integrations.markSuccess('claude', { lastModel: result.model });
      return result;
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth') this.integrations.markError('claude', err.message);
      throw err;
    }
  }
}

import { enabledProviders, type AasConfig } from '../config.ts';
import { OpenAiCompatibleProvider } from '../providers/openai-compatible.ts';
import { AnthropicProvider } from '../providers/anthropic.ts';
import { ProviderRegistry } from './registry.ts';

/** 設定から有効なProviderだけを登録する。クラウドは既定で無効。 */
export function buildRegistry(config: AasConfig): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const p of enabledProviders(config)) {
    const apiKey = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
    if (p.kind === 'anthropic') {
      registry.register(new AnthropicProvider({ id: p.id, apiKey, fallbackModels: p.models }));
    } else {
      registry.register(new OpenAiCompatibleProvider({
        id: p.id,
        baseUrl: p.baseUrl!,
        locality: p.locality,
        apiKey,
        fallbackModels: p.models,
      }));
    }
  }
  return registry;
}

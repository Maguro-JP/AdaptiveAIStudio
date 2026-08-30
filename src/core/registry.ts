import type { ChatProvider, ModelDescriptor, ModelId } from '../providers/contract.ts';

/** Providerの保持と、失敗時の一時的な除外(冷却)を管理する。 */
export class ProviderRegistry {
  readonly #providers = new Map<string, ChatProvider>();
  /** providerId -> 冷却解除時刻(epoch ms)。Infinity は手動解除まで */
  readonly #cooldownUntil = new Map<string, number>();

  register(p: ChatProvider): void {
    this.#providers.set(p.id, p);
  }

  get(id: string): ChatProvider | undefined {
    return this.#providers.get(id);
  }

  list(): ChatProvider[] {
    return [...this.#providers.values()];
  }

  cooldown(providerId: string, ms: number): void {
    if (ms <= 0) return;
    this.#cooldownUntil.set(providerId, ms === Infinity ? Infinity : Date.now() + ms);
  }

  clearCooldown(providerId: string): void {
    this.#cooldownUntil.delete(providerId);
  }

  isAvailable(providerId: string): boolean {
    const until = this.#cooldownUntil.get(providerId);
    if (until === undefined) return true;
    if (Date.now() >= until) {
      this.#cooldownUntil.delete(providerId);
      return true;
    }
    return false;
  }

  cooldownRemainingMs(providerId: string): number {
    const until = this.#cooldownUntil.get(providerId);
    if (until === undefined) return 0;
    return until === Infinity ? Infinity : Math.max(0, until - Date.now());
  }

  /** "provider:model" を分解する。model 側に ':' を含むケース(qwen2.5:7b)に対応。 */
  resolve(modelId: ModelId): { provider: ChatProvider; model: string } | undefined {
    const sep = modelId.indexOf(':');
    if (sep === -1) return undefined;
    const provider = this.#providers.get(modelId.slice(0, sep));
    if (!provider) return undefined;
    return { provider, model: modelId.slice(sep + 1) };
  }

  async listAllModels(): Promise<ModelDescriptor[]> {
    const results = await Promise.all(
      this.list().map((p) => p.listModels().catch(() => [] as ModelDescriptor[])),
    );
    return results.flat();
  }
}

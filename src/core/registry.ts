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

  /** providerId -> 冷やした理由（全部が冷えているときに、何で冷えているかを言うため） */
  readonly #cooldownReason = new Map<string, string>();
  /** 冷やしを付けた時刻（単調な時計）。成功で解くとき、試しを始めた後に付いた冷やしは残すため */
  readonly #cooledAt = new Map<string, number>();

  cooldown(providerId: string, ms: number, reason?: string): void {
    if (ms <= 0) return;
    this.#cooldownUntil.set(providerId, ms === Infinity ? Infinity : this.#now() + ms);
    this.#cooledAt.set(providerId, this.#now());
    if (reason) this.#cooldownReason.set(providerId, reason);
    else this.#cooldownReason.delete(providerId);
  }

  /** 冷やしている理由。冷やしていなければ undefined。 */
  cooldownReason(providerId: string): string | undefined {
    return this.isAvailable(providerId) ? undefined : this.#cooldownReason.get(providerId);
  }

  /** 冷やしは単調な時計で数える（壁時計だと、時計が 1 時間戻ると 1 分の冷やしが 61 分になる）。試験で入れ替えられる。 */
  #now: () => number = () => performance.now();

  /** 試験用: 時計を入れ替える。 */
  setClockForTest(now: () => number): void {
    this.#now = now;
  }

  /** いまの時刻（冷やしと同じ単調な時計）。試しを始めた時刻を記録するのに使う */
  clock(): number {
    return this.#now();
  }

  /**
   * 冷やしを解く。`since` を渡すと、その時刻より後に付いた冷やしは残す（並んで走る別の依頼が付けた冷やしを、先に始めていた
   * 依頼の成功が消していた）
   */
  clearCooldown(providerId: string, since?: number): void {
    const at = this.#cooledAt.get(providerId);
    if (since !== undefined && at !== undefined && at > since) return;
    this.#cooledAt.delete(providerId);
    this.#cooldownUntil.delete(providerId);
    this.#cooldownReason.delete(providerId);
  }

  isAvailable(providerId: string): boolean {
    const until = this.#cooldownUntil.get(providerId);
    if (until === undefined) return true;
    if (this.#now() >= until) {
      this.#cooldownUntil.delete(providerId);
      return true;
    }
    return false;
  }

  cooldownRemainingMs(providerId: string): number {
    const until = this.#cooldownUntil.get(providerId);
    if (until === undefined) return 0;
    return until === Infinity ? Infinity : Math.max(0, until - this.#now());
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

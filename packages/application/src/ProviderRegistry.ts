import type { ModelDescriptor, ProviderId } from '@aas/core';
import type { ChatProvider } from '@aas/provider-contract';
import { type Clock, systemClock } from '@aas/shared';

const MANUAL_RELEASE = Number.POSITIVE_INFINITY;

export class ProviderRegistry {
  readonly #providers = new Map<ProviderId, ChatProvider>();
  readonly #cooldownUntil = new Map<ProviderId, number>();

  constructor(private readonly clock: Clock = systemClock) {}

  register(p: ChatProvider): void {
    this.#providers.set(p.id, p);
  }

  get(id: ProviderId): ChatProvider {
    const p = this.#providers.get(id);
    if (!p) throw new Error(`provider not registered: ${id}`);
    return p;
  }

  has(id: ProviderId): boolean {
    return this.#providers.has(id);
  }

  list(): ChatProvider[] {
    return [...this.#providers.values()];
  }

  /** durationMs が null なら手動解除まで冷却する。 */
  cooldown(id: ProviderId, durationMs: number | null): void {
    if (durationMs === 0) return;
    this.#cooldownUntil.set(id, durationMs === null ? MANUAL_RELEASE : this.clock.now() + durationMs);
  }

  clearCooldown(id: ProviderId): void {
    this.#cooldownUntil.delete(id);
  }

  isCoolingDown(id: ProviderId): boolean {
    const until = this.#cooldownUntil.get(id);
    if (until === undefined) return false;
    if (until !== MANUAL_RELEASE && until <= this.clock.now()) {
      this.#cooldownUntil.delete(id);
      return false;
    }
    return true;
  }

  async listAvailableModels(): Promise<ModelDescriptor[]> {
    const out: ModelDescriptor[] = [];
    for (const p of this.#providers.values()) {
      if (this.isCoolingDown(p.id)) continue;
      try {
        if (!(await p.health()).reachable) continue;
        out.push(...(await p.listModels()));
      } catch {
        // 到達できない Provider は候補から外すだけ。全体は止めない。
      }
    }
    return out;
  }
}

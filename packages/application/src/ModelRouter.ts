import type { ModelDescriptor, ModelId, RoutingPolicy, TaskKind } from '@aas/core';
import type { ProviderRegistry } from './ProviderRegistry.js';

export interface RouterOptions {
  /** 会話に固定モデルがある場合、それを先頭に置く。 */
  pinnedModelId?: ModelId;
}

export class ModelRouter {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly catalog: ReadonlyMap<ModelId, ModelDescriptor>,
  ) {}

  /** タスク種別 + ポリシー + 現在の可用性から候補列を返す。 */
  resolve(task: TaskKind, policy: RoutingPolicy, opts: RouterOptions = {}): ModelId[] {
    const configured = policy.byTask[task] ?? policy.default;
    const ordered = opts.pinnedModelId
      ? [opts.pinnedModelId, ...configured.filter((m) => m !== opts.pinnedModelId)]
      : [...configured];

    return ordered.filter((id) => {
      const d = this.catalog.get(id);
      if (!d) return false;
      if (!this.registry.has(d.providerId)) return false;
      return !this.registry.isCoolingDown(d.providerId);
    });
  }

  descriptor(id: ModelId): ModelDescriptor | undefined {
    return this.catalog.get(id);
  }
}

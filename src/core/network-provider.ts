/**
 * ネットワークの送り口（docs/NETWORK-MODEL.md の段階 1）。
 *
 * id は `network`、モデルは `network` の1つだけ。重みは持たない。今は、受けた依頼を、これが無かったときに使っていた
 * 中の候補へそのまま渡す（候補選び・やり直し・切り替え・失敗の扱いは `ChatOrchestrator` のまま）。知識の蔵はまだ使わない。
 *
 * 呼ぶ側（Session、Agent、ChatOrchestrator の呼び手）は何も変えない。候補の先頭に `network:network` が来るだけ。
 */
import type { ChatProvider, HealthStatus, ModelDescriptor, ProviderChunk, ProviderRequest } from '../providers/contract.ts';
import { ChatOrchestrator, type ChatEvent, type ChatInput } from './orchestrator.ts';
import type { ProviderRegistry } from './registry.ts';

export const NETWORK_PROVIDER_ID = 'network';
export const NETWORK_MODEL_ID = 'network:network';
/** 画面に出す名前。 */
export const NETWORK_LABEL = 'ネットワーク';

/** 候補に `network` が入っているか。 */
export function isNetworkModel(id: string | undefined): boolean {
  return id === NETWORK_MODEL_ID;
}

/** 候補から `network` を外したもの（中で使うモデル）。並びはそのまま。 */
export function innerCandidates(candidates: readonly string[]): string[] {
  return candidates.filter((c) => !isNetworkModel(c));
}

/** 中で使うモデルがあれば、先頭に `network` を置く。無ければそのまま（「モデルがありません」の道を変えない）。 */
export function withNetwork(candidates: readonly string[]): string[] {
  const inner = innerCandidates(candidates);
  return inner.length > 0 ? [NETWORK_MODEL_ID, ...inner] : inner;
}

export class NetworkProvider implements ChatProvider {
  readonly id = NETWORK_PROVIDER_ID;
  /** この機械の中で回す口として扱う（失敗で冷やさない。冷やすのは中の外の口）。 */
  readonly locality = 'local' as const;
  readonly #inner: () => readonly string[];
  readonly #orchestrator: ChatOrchestrator;

  /** `inner`: 依頼に中の候補が添えられていないときに使う候補（これが無かったときの候補）。 */
  constructor(registry: ProviderRegistry, inner: () => readonly string[]) {
    this.#inner = inner;
    this.#orchestrator = new ChatOrchestrator(registry);
  }

  async health(): Promise<HealthStatus> {
    return innerCandidates(this.#inner()).length > 0
      ? { ok: true }
      : { ok: false, reason: '中で使うモデルがありません' };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{
      id: NETWORK_MODEL_ID, providerId: NETWORK_PROVIDER_ID, model: 'network',
      displayName: NETWORK_LABEL, locality: 'local', verified: true,
    }];
  }

  /**
   * 中の候補へ渡し、出来事をそのまま返す（試し・切り替え・本文・ツールの呼び出し・失敗・どのモデルが答えたか）。
   * `candidates` が空なら、作ったときに渡された候補を使う。
   */
  relay(input: ChatInput, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const given = innerCandidates(input.candidates);
    const candidates = given.length > 0 ? given : innerCandidates(this.#inner());
    return this.#orchestrator.run({ ...input, candidates }, signal);
  }

  /** 送り口の契約の形。`ChatOrchestrator` を通さずに呼ばれたとき用。失敗は中の失敗をそのまま投げる。 */
  async *chat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    const { model: _model, ...rest } = req;
    for await (const ev of this.relay({ ...rest, candidates: [] }, signal)) {
      if (ev.type === 'text') yield { type: 'text', delta: ev.delta };
      else if (ev.type === 'toolCall') yield { type: 'toolCall', call: ev.call };
      else if (ev.type === 'usage') yield ev;
      else if (ev.type === 'done') yield { type: 'done', finishReason: ev.finishReason ?? 'unknown' };
      else if (ev.type === 'failed') throw ev.error;
    }
  }

  async canSeeImages(_model: string, signal?: AbortSignal): Promise<boolean> {
    return this.#orchestrator.canSeeImages(innerCandidates(this.#inner())[0], signal);
  }
}

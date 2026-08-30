/**
 * Ollama を LocalRuntime として扱う薄い実装。
 *
 * プロセス管理は Ollama 自身が行うので、こちらは一覧と接続先を返すだけ。
 * 細かいオフロード制御はできない（それが llamacpp を持つ理由）。
 */
import type { AvailableModel, LoadedModel, LocalRuntime } from './local-runtime.ts';

export interface OllamaRuntimeOptions {
  baseUrl?: string;
}

export class OllamaRuntime implements LocalRuntime {
  readonly id = 'ollama';
  readonly #baseUrl: string;
  readonly #loaded = new Set<string>();

  constructor(opts: OllamaRuntimeOptions = {}) {
    this.#baseUrl = (opts.baseUrl ?? 'http://localhost:11434/v1').replace(/\/$/, '');
  }

  async list(): Promise<AvailableModel[]> {
    try {
      const res = await fetch(`${this.#baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return [];
      const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
      return (json.data ?? [])
        .map((m) => m.id)
        .filter((v): v is string => typeof v === 'string')
        .map((ref) => ({ ref }));
    } catch {
      return [];
    }
  }

  async ensureLoaded(ref: string): Promise<LoadedModel> {
    // Ollama は初回リクエスト時に自動でロードする。ここでは接続先を返すだけ。
    this.#loaded.add(ref);
    return { baseUrl: this.#baseUrl, model: ref };
  }

  async unload(ref: string): Promise<void> {
    // keep_alive: 0 で即時解放を要求する。VRAMを空けるために必要。
    this.#loaded.delete(ref);
    try {
      await fetch(`${this.#baseUrl.replace(/\/v1$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: ref, keep_alive: 0 }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // 解放できなくても致命的ではない
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#loaded].map((ref) => this.unload(ref)));
  }

  loaded(): string[] {
    return [...this.#loaded];
  }
}

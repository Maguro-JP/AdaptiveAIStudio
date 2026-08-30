/**
 * ローカル推論ランタイムの抽象。
 *
 * Ollama と llama.cpp を同じ形で扱い、設定で切り替えられるようにする。
 * どちらにも依存しないことが目的（片方が壊れても、もう片方で動く）。
 */
import type { Plan } from './planner.ts';

export interface LoadedModel {
  /** OpenAI互換APIのベースURL。Provider層はこれだけを見る。 */
  baseUrl: string;
  /** Provider へ渡すモデル名 */
  model: string;
  /** 実際に適用された実行計画。null は外部が決めた場合（Ollama等） */
  plan?: Plan;
  /** 起動〜応答可能までの実測秒数 */
  loadSeconds?: number;
}

export interface AvailableModel {
  /** ランタイム内での識別子（ファイル名やタグ） */
  ref: string;
  /** ファイルサイズ（分かる場合） */
  sizeBytes?: number;
}

export interface LocalRuntime {
  readonly id: string;
  /** 導入済みモデルの一覧 */
  list(): Promise<AvailableModel[]>;
  /** 使える状態にする。既にロード済みなら即座に返る。 */
  ensureLoaded(ref: string, signal?: AbortSignal): Promise<LoadedModel>;
  /** 解放する。VRAMを空けるために必要。 */
  unload(ref: string): Promise<void>;
  /** 全て解放する（終了時） */
  shutdown(): Promise<void>;
  /** 現在ロード済みのref */
  loaded(): string[];
}

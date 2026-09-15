/**
 * ローカル推論ランタイムの抽象。
 *
 * Ollama と llama.cpp を同じ形で扱い、設定で切り替えられるようにする。
 * どちらにも依存しないことが目的（片方が壊れても、もう片方で動く）。
 */
import type { Backend } from './inproc.ts';
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
  /**
   * 実際に開いた窓（トークン）。分からない道では省略してよい。
   *
   * **開く側と、見積もる側が別の数字を持たないため。**上の層が設定から
   * 見積もると、狭められたときは溢れ、広げたときは刈りすぎる。
   */
  windowOf?(ref: string): number | undefined;
  /**
   * 読む側が実際に使う backend（GPU か CPU か、VRAM はいくつか）。inproc だけ。
   *
   * **選ぶ側はこれを見る。**nvidia-smi に GPU が見えるかどうかで決めると、
   * 読む側が CPU で回っているのに「GPU が在るから大きい方」を選ぶ（実機でそうなった）。
   */
  backend?(): Promise<Backend>;
}

/**
 * GGUF を自分で置く道か。
 *
 * llamacpp と inproc は、どちらも置き場の .gguf を読む。
 * **どちらか一方だけを見る分岐を書かない。**片方を足したときに、
 * 取ってくる先が Ollama のままになっていて気づかなかった。
 */
export function usesGguf(runtimeId: string): boolean {
  return runtimeId === 'llamacpp' || runtimeId === 'inproc';
}

/**
 * 続けて失敗している間は一度だけ言う。書けたら戻し、次に失敗したらまた言う。
 *
 * 記録（監査・測った数）は本体を止めないために失敗を捨てていたので、書けない場所を指していても誰も気づかなかった。
 * かといって毎回言うと、ツールを一回呼ぶたびに同じ警告が並ぶ。
 */
export class WarnOnce {
  #say?: (text: string) => void;
  #failing = false;

  /** 言う先。渡されるまでは覚えるだけで言わない。 */
  to(say: (text: string) => void): void {
    this.#say = say;
  }

  ok(): void {
    this.#failing = false;
  }

  fail(text: string): void {
    if (this.#failing) return;
    this.#failing = true;
    this.#say?.(text);
  }
}

/** 失敗の短い名前（EACCES 等）。無ければ文の頭。 */
export function failCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code) return code;
  return e instanceof Error ? e.message.split('\n')[0] ?? '不明' : String(e);
}

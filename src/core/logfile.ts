/**
 * 記録（log）を、ファイルにも残す。
 *
 * ここまで本体の記録は画面へ流すだけで、どこにも残らなかった。困ったときに
 * 「何が起きたか」を訊くと、利用者が画面から文字を拾うことになる。
 * 一行ずつ足し、大きくなったら一つ前へ回す（.1）。書けなくても本体は止めない。
 */
import { appendFile, mkdir, rename, stat, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 人が読む時刻。JST で書く（記録を読むのは人なので、機械の UTC に合わせない）。 */
export function jstStamp(now = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}`
    + ` ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:${p(jst.getUTCSeconds())}`;
}

export class LogFile {
  readonly #path: string;
  readonly #max: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string, opts: { maxBytes?: number } = {}) {
    this.#path = path;
    this.#max = opts.maxBytes ?? 2 * 1024 * 1024;
  }

  get path(): string { return this.#path; }

  /** 一行足す。順番は守る。書けなくても投げない（記録のために本体を止めない）。 */
  append(line: string, now = new Date()): Promise<void> {
    const text = `${jstStamp(now)} ${line.replace(/\r?\n/g, '\n    ')}\n`;
    this.#queue = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const size = await stat(this.#path).then((s) => s.size).catch(() => 0);
      // 際限なく育てない。一つ前を残して回す。
      if (size > this.#max) await rename(this.#path, `${this.#path}.1`).catch(() => undefined);
      await appendFile(this.#path, text, 'utf8');
    }).catch(() => undefined);
    return this.#queue;
  }

  /** 末尾の何行か。無ければ空。 */
  async tail(lines: number): Promise<string> {
    await this.#queue;
    const text = await readFile(this.#path, 'utf8').catch(() => '');
    if (!text) return '';
    const all = text.replace(/\n$/, '').split('\n');
    return all.slice(-lines).join('\n');
  }
}

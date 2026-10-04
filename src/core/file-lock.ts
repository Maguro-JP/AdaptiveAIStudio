/**
 * 別のプロセスとの間で、同じファイルへの「読み直して合わせて書く」を一つずつにする錠。
 *
 * 同じプロセスの中は `inOrder` で並ぶ。ところが画面（server）と端末（CLI）は別々に読み込んで持つので、
 * 両方がほぼ同時に読み直すと、後から付け替えた方が先の書き込みを知らないまま上書きした
 * （却下した提案が開いたまま戻る、済ませた当番がもう一度「やるべき」になる）。
 *
 * - 取る: `<名前>.lock` を排他で作る（`wx`）。在れば少し待って取り直す。
 * - 古い錠: 作られてから `staleMs` を過ぎたものは、落ちたプロセスが残したものとして消して取り直す。
 *   中でするのは小さなファイルを読んで書くだけなので、既定の 10 秒を超えて持つことは無い。
 * - 取れない: `timeoutMs` 待っても取れなければ投げる。呼ぶ側は「書けなかった」として扱う（黙って上書きしない）。
 * - 返す: 自分が作った錠のときだけ消す（古いとして消された後に、ほかが取り直した錠を消さない）。
 */
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 待っても錠を取れなかった。中身は何も変えていない。 */
export class FileLockBusy extends Error {}

export interface FileLockOptions {
  /** これより古い錠は残骸として消す。 */
  staleMs?: number;
  /** これだけ待っても取れなければ投げる。 */
  timeoutMs?: number;
}

export async function withFileLock<T>(path: string, run: () => Promise<T>, opts: FileLockOptions = {}): Promise<T> {
  const lock = `${path}.lock`;
  const token = `${process.pid} ${randomUUID()}`;
  await acquire(lock, token, opts.staleMs ?? 10_000, opts.timeoutMs ?? 5_000);
  try {
    return await run();
  } finally {
    await release(lock, token);
  }
}

async function acquire(lock: string, token: string, staleMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let tries = 0; ; tries++) {
    try {
      const fh = await open(lock, 'wx');
      try { await fh.writeFile(token, 'utf8'); } finally { await fh.close(); }
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // まだ一度も書いていない保存先（初めての保存）。フォルダを作って取り直す
      if (code === 'ENOENT' && tries === 0) { await mkdir(dirname(lock), { recursive: true }); continue; }
      // Windows では、消している途中の錠を開こうとすると EPERM になる。在るのと同じく待って取り直す
      if (code !== 'EEXIST' && code !== 'EPERM') throw e;
    }
    const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => undefined);
    if (age !== undefined && age > staleMs) {
      await unlink(lock).catch(() => undefined);
      continue;
    }
    if (Date.now() >= deadline) throw new FileLockBusy(`ほかのプロセスが ${lock} を持ったままです`);
    await new Promise((r) => setTimeout(r, Math.min(20 * (tries + 1), 200)));
  }
}

async function release(lock: string, token: string): Promise<void> {
  const now = await readFile(lock, 'utf8').catch(() => undefined);
  if (now === token) await unlink(lock).catch(() => undefined);
}

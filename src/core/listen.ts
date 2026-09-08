/**
 * 口を開ける。開かなかったら、**理由を言って返る。**
 *
 * `listen` は失敗すると `error` を投げる。約束（Promise）の中で
 * 拾い忘れると、resolve も reject もされず**永久に返らない**。
 * 画面が出ないのでも、失敗と言うのでもなく、黙って固まる。
 * 実際に `inproc` でそうなっていた。
 *
 * 塞がっている理由のほとんどは「もう一つ立ち上がっている」なので、
 * そこまで言う。番号だけ言われても次の一手が分からない。
 */
import type { Server } from 'node:http';

export interface ListenWhere {
  port: number;
  host?: string;
  /** 何の口か。人へ見せる文に出す。 */
  what: string;
}

/** 実際に決まった番号。0 を渡すと空いているものが選ばれるので、聞き直す。 */
export function boundPort(server: Server, fallback: number): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : fallback;
}

export function listenMessage(where: ListenWhere, e: NodeJS.ErrnoException): string {
  if (e.code === 'EADDRINUSE') {
    return `${where.what}の口 ${where.port} は既に使われています。`
      + 'もう一つ立ち上がっていませんか。開いているほうをお使いください。';
  }
  if (e.code === 'EACCES') {
    return `${where.what}の口 ${where.port} は開けませんでした（許可がありません）。`;
  }
  return `${where.what}の口 ${where.port} を開けませんでした: ${e.message}`;
}

/**
 * 口が開けなかったこと。
 *
 * **これを普通の例外にしていたので、Node のスタックが出た。**画面を二度
 * 立ち上げただけで、利用者の目に入るのは 6 行の英語の呼び出し履歴。
 * 肝心の一行はその中に埋もれる。受け止める側が見分けられるようにする。
 */
export class CannotListen extends Error {}

/** 開けて、決まった番号を返す。開かなければ理由を持って投げる。 */
export async function listenOrExplain(server: Server, where: ListenWhere): Promise<number> {
  const host = where.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    const failed = (e: NodeJS.ErrnoException) => reject(new CannotListen(listenMessage(where, e)));
    server.once('error', failed);
    server.listen(where.port, host, () => {
      server.off('error', failed);
      resolve();
    });
  });
  return boundPort(server, where.port);
}

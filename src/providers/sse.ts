/**
 * 一行・一本文の上限（文字数）。改行を送らない相手（壊れた・悪意のある口）から、上限なしに溜め込んで落ちないため。
 * MCP の行の上限（`src/mcp/client.ts`）と同じ大きさ。
 */
export const MAX_SSE_LINE = 8 * 1024 * 1024;

/** 上限を超えたときの失敗。 */
export class TooLargeError extends Error {
  constructor(max: number) {
    super(`返事の一行が大きすぎます（${max} 字を超えたので切りました）`);
  }
}

/** 本文を上限つきで読む。`cut` なら上限で切って返し、そうでなければ投げる。 */
export async function readTextCapped(body: ReadableStream<Uint8Array> | null, max = MAX_SSE_LINE, cut = false): Promise<string> {
  if (!body) return '';
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out + decoder.decode();
      out += decoder.decode(value, { stream: true });
      if (out.length > max) {
        await reader.cancel().catch(() => undefined);
        if (cut) return out.slice(0, max);
        throw new TooLargeError(max);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Server-Sent Events の行読み。全アダプタで共有する。 */
export async function* readSseLines(
  body: ReadableStream<Uint8Array>,
  max = MAX_SSE_LINE,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  // 最後まで読み切ったか。**途中でやめられたかどうかを分けて扱う。**
  let drained = false;
  /**
   * 一つの知らせが複数の `data:` 行に分かれて届いたときに溜めておく分。前の行が JSON の途中（`{` か `[` で始まり、まだ読めない）
   * なら、読めるようになるか空行が来るまで、次の `data:` 行と改行で繋ぐ（行ごとに渡すと、どちらも読めずに黙って捨てられ、
   * 返事の字が欠けていた）。それ以外は一行ずつ、届いたそばから渡す（空行を送らない相手でも、これまでどおり）
   */
  let pending: string | undefined;
  const incompleteJson = (text: string): boolean => {
    if (!/^\s*[{[]/.test(text)) return false;
    try { JSON.parse(text); return false; } catch { return true; }
  };
  function* take(line: string): Generator<string> {
    if (line === '') {
      // 空行は知らせの終わり
      if (pending !== undefined) { const out = pending; pending = undefined; yield out; }
      return;
    }
    if (!line.startsWith('data:')) return;
    // `data:` の後ろの空白は一つだけ落とす（決まりのとおり。中身の空白まで削らない）
    const data = line.slice(line.startsWith('data: ') ? 6 : 5);
    if (pending !== undefined) {
      pending += '\n' + data;
      if (!incompleteJson(pending)) { const out = pending; pending = undefined; yield out; }
      return;
    }
    // 読める一行は、その場で渡す（次の行を待つと、返事の字が遅れて出る）
    if (incompleteJson(data)) pending = data;
    else yield data;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 行の終わりは \r\n・\n・\r のどれでもよい（\r だけの相手の流れを一つの塊として読んでいた）。
      // 末尾の \r は、次に \n が届くかもしれないので残しておく
      let m: RegExpExecArray | null;
      while ((m = /\r\n|\n|\r(?=[^\n])/.exec(buffer)) !== null) {
        const line = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        yield* take(line);
      }
      // 改行の来ないまま溜まり続けるものは切る（届くたびに見張りを延ばすので、時間切れでも止まらなかった）
      if (buffer.length > max) throw new TooLargeError(max);
    }
    for (const line of buffer.split(/\r\n|\n|\r/)) yield* take(line);
    if (pending !== undefined) yield pending;
    drained = true;
  } finally {
    // 読む側が途中でやめたら（[DONE] で抜ける、途中で落ちる）、
    // **繋ぎを切る。**releaseLock は錠を外すだけで、繋ぎは開いたまま残る。
    // 開いたままだと、返す側は誰も読まない答えを作り続け、
    // 次の依頼をその後ろで待たせる（inproc は依頼を順に捌くため）。
    if (!drained) await reader.cancel().catch(() => { /* もう閉じている */ });
    reader.releaseLock();
  }
}

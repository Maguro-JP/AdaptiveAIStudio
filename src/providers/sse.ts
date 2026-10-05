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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
      // 改行の来ないまま溜まり続けるものは切る（届くたびに見張りを延ばすので、時間切れでも止まらなかった）
      if (buffer.length > max) throw new TooLargeError(max);
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) yield tail.slice(5).trim();
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

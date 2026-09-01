/** Server-Sent Events の行読み。全アダプタで共有する。 */
export async function* readSseLines(
  body: ReadableStream<Uint8Array>,
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

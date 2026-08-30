/** SSE の data: 行だけを取り出す最小パーサ。 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    const rest = buffer.trim();
    if (rest.startsWith('data:')) yield rest.slice(5).trim();
  } finally {
    reader.releaseLock();
    await stream.cancel().catch(() => {});
  }
}

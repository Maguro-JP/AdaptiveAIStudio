/** 子のプロセス（inproc-host）に読ませる、偽のライブラリ。数GBの本物の代わり。 */
export async function load(): Promise<unknown> {
  return {
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
      }),
    }),
    LlamaChatSession: class {
      setChatHistory() {}
      async prompt(_text: string, o: { onTextChunk?: (t: string) => void } = {}) {
        for (const part of [...'別のプロセスから']) o.onTextChunk?.(part);
        return '別のプロセスから';
      }
    },
  };
}

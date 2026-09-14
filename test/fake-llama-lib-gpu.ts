/** 子のプロセス（inproc-host）に読ませる、GPU を使ったことにする偽のライブラリ。 */
export async function load(): Promise<unknown> {
  return {
    getLlama: async () => ({
      gpu: 'cuda',
      getGpuDeviceNames: async () => ['NVIDIA GeForce RTX 4060'],
      getVramState: async () => ({ total: 8 * 1024 ** 3, used: 0, free: 8 * 1024 ** 3 }),
      loadModel: async () => ({
        gpuLayers: 37,
        fileInsights: { totalLayers: 37 },
        createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
      }),
    }),
    LlamaChatSession: class {
      setChatHistory() {}
      async prompt(_text: string, o: { onTextChunk?: (t: string) => void } = {}) {
        for (const part of [...'GPU から']) o.onTextChunk?.(part);
        return 'GPU から';
      }
    },
  };
}

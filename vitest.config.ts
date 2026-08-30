import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const abs = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@aas/shared': abs('./packages/shared/src/index.ts'),
      '@aas/core': abs('./packages/core/src/index.ts'),
      '@aas/provider-contract': abs('./packages/providers/contract/src/index.ts'),
      '@aas/provider-openai-compatible': abs('./packages/providers/openai-compatible/src/index.ts'),
      '@aas/application': abs('./packages/application/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});

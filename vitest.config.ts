import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      electron: resolve(__dirname, 'tests/mocks/electron.ts'),
    },
  },
  test: {
    environment: 'node',
  },
});


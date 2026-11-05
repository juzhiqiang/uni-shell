import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/** 与 `vite.config.ts` renderer 段同源：构建期把 package.json 版本注入为 `__APP_VERSION__`。 */
const appVersion = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string }).version;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      electron: resolve(__dirname, 'tests/mocks/electron.ts'),
    },
  },
  test: {
    environment: 'node',
  },
});


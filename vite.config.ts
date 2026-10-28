import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const root = process.cwd();

export default defineConfig({
  main: {
    build: {
      outDir: resolve(root, 'dist/main'),
      rollupOptions: {
        input: resolve(root, 'src/main.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  // 本地配置窗口的最小 preload：只暴露五个具名 IPC 方法（rules/security.md）。
  // 沙箱 preload 必须是 CJS；产物路径与主进程 `preloadPath()` 约定一致。
  preload: {
    build: {
      outDir: resolve(root, 'dist/preload'),
      rollupOptions: {
        input: resolve(root, 'src/preload/config-preload.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer/config'),
    publicDir: resolve(root, 'src/renderer/offline'),
    plugins: [react()],
    build: {
      outDir: resolve(root, 'dist/renderer/config'),
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(root, 'src/renderer/config/index.html'),
      },
    },
  },
});

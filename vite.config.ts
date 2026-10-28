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
  renderer: {
    root: resolve(root, 'src/renderer/config'),
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

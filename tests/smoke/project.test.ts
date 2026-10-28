import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe('cross-platform project scaffold', () => {
  it('defines the required development, quality, and release scripts', () => {
    const requiredScripts = [
      'dev',
      'typecheck',
      'test',
      'lint',
      'build:dir',
      'build:win',
      'build:mac',
      'build:linux',
      'verify:release',
    ];

    for (const script of requiredScripts) {
      expect(packageJson.scripts[script], `missing package script: ${script}`).toBeTruthy();
    }
  });

  it('provides build configuration and local Electron and renderer entry points', () => {
    for (const file of [
      'vite.config.ts',
      'electron.vite.config.ts',
      'src/main.ts',
      'src/renderer/config/index.html',
      'src/renderer/config/main.tsx',
    ]) {
      expect(existsSync(resolve(root, file)), `missing project entry: ${file}`).toBe(true);
    }
  });

  it('pins Electron to an exact version', () => {
    expect(packageJson.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

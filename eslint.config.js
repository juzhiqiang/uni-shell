import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: tsPlugin.configs.recommended.rules,
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/main/**',
                '../main/**',
                '../../main/**',
                '**/preload/**',
                '../preload/**',
                '../../preload/**',
                'src/main/**',
                'src/preload/**',
              ],
              message: 'src/renderer/** 不得导入 src/main/** 或 src/preload/**（统一走 src/shared/）',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/main/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/preload/**',
                '../preload/**',
                '../../preload/**',
                'src/preload/**',
              ],
              message: 'src/main/**（除 src/main.ts 外）不得导入 src/preload/**，契约统一走 src/shared/',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/main/platform/**/*.ts',
      'src/main/startup/**/*.ts',
      'src/main/tray/**/*.ts',
      'src/main/config/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/preload/**',
                '../preload/**',
                '../../preload/**',
                'src/preload/**',
              ],
              message: 'src/main/**（除 src/main.ts 外）不得导入 src/preload/**，契约统一走 src/shared/',
            },
            {
              group: [
                '**/app-controller',
                '../app-controller',
                '../../app-controller',
                '*app-controller*',
              ],
              message: 'src/main/platform/**、startup/**、tray/**、config/** 不得导入 app-controller',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'src/shared/ 不得导入 electron' },
            { name: 'fs', message: 'src/shared/ 不得导入 node 模块' },
            { name: 'path', message: 'src/shared/ 不得导入 node 模块' },
            { name: 'os', message: 'src/shared/ 不得导入 node 模块' },
            { name: 'events', message: 'src/shared/ 不得导入 node 模块' },
          ],
          patterns: [
            {
              group: ['node:*', 'node:*/**'],
              message: 'src/shared/ 不得导入 node:*',
            },
          ],
        },
      ],
    },
  },
];

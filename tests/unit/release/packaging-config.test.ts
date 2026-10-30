import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const PLATFORM_CONFIGS = ['windows.yml', 'mac.yml', 'linux.yml'];

/**
 * 抽取 YAML 的顶层 `key: value`（行首无缩进、非列表项）。
 * nsis/win/linux 等子段里可能出现同名键，只有顶层 `publish` 才是全局发布策略。
 */
function topLevelEntries(yaml: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of yaml.split(/\r?\n/)) {
    // 去掉行尾注释后判断缩进：整行注释与子段条目都不是顶层键。
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(' ') || line.startsWith('-')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return entries;
}

describe('electron-builder 发布策略', () => {
  // 回归防护：2026-10-30 CI 打包失败即因三份配置都没写 publish，electron-builder 26
  // 在 CI 上隐式启用发布，并按 git 远程地址推断 GitHub 为发布提供方，缺 GH_TOKEN 时
  // 在 block map 之后直接抛 InvalidConfigurationError。详见 rules/testing-release.md。
  it.each(PLATFORM_CONFIGS)('%s 显式关闭发布', (config) => {
    const yaml = readFileSync(resolve(root, 'electron-builder', config), 'utf8');
    expect(topLevelEntries(yaml).get('publish'), `${config} 需要顶层 publish: null`).toBe('null');
  });

  it('构建脚本显式声明不发布', () => {
    for (const script of ['build:dir', 'build:win', 'build:mac', 'build:linux']) {
      expect(packageJson.scripts[script], `${script} 需要 --publish never`).toContain('--publish never');
    }
  });

  it('发布策略为 null 时 electron-builder 不会生成自动更新元数据', () => {
    // publish: null 会让 getPublishConfigs 直接返回 null，从而跳过 latest.yml 生成，
    // 产物目录里只应出现安装包本身（本基地不含自动更新基础设施）。
    for (const config of PLATFORM_CONFIGS) {
      const yaml = readFileSync(resolve(root, 'electron-builder', config), 'utf8');
      expect(topLevelEntries(yaml).get('publish')).not.toMatch(/github|generic|s3|spaces/);
    }
  });
});

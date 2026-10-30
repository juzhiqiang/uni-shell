import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyRelease } from '../../../scripts/verify-release';

const temporaryDirectories: string[] = [];

async function createReleaseFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'uni-shell-release-'));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, 'config.example.json'), '{"schemaVersion":1}\n');

  for (const [platform, filenames] of [
    ['windows', ['UniShell-1.0.0-x64.exe', 'UniShell-1.0.0-x64.zip']],
    ['mac', ['UniShell-1.0.0-arm64.dmg', 'UniShell-1.0.0-x64.dmg']],
    ['linux', ['UniShell-1.0.0-x64.deb', 'UniShell-1.0.0-x64.AppImage']],
  ] as const) {
    const platformDirectory = join(directory, platform);
    await mkdir(platformDirectory, { recursive: true });
    await mkdir(join(platformDirectory, 'unpacked', 'resources'), { recursive: true });
    await writeFile(join(platformDirectory, 'unpacked', 'resources', 'config.example.json'), '{"schemaVersion":1}\n');
    for (const filename of filenames) await writeFile(join(platformDirectory, filename), filename);
  }

  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('verifyRelease', () => {
  it('creates a manifest with target architectures and SHA-256 for each artifact', async () => {
    const releaseDir = await createReleaseFixture();
    const result = await verifyRelease({
      releaseDir,
      templatePath: join(releaseDir, 'config.example.json'),
      platforms: ['windows', 'mac', 'linux'],
      version: '1.0.0',
      signingStatus: { mac: { signed: true, notarized: true } },
      now: new Date('2026-10-28T00:00:00.000Z'),
    });

    expect(result.manifest.artifacts).toHaveLength(6);
    expect(result.manifest.artifacts.map(({ platform, architectures }) => [platform, architectures])).toEqual([
      ['windows', ['x64']],
      ['windows', ['x64']],
      ['mac', ['arm64']],
      ['mac', ['x64']],
      ['linux', ['x64']],
      ['linux', ['x64']],
    ]);
    expect(result.manifest.artifacts[0].sha256).toBe(
      createHash('sha256').update('UniShell-1.0.0-x64.exe').digest('hex'),
    );
    expect(result.manifest.configuration).toEqual({
      template: 'config.example.json',
      activeConfigOverwrite: false,
      upgradePolicy: 'preserve-existing',
    });
    expect(JSON.parse(await readFile(result.manifestPath, 'utf8'))).toEqual(result.manifest);
  });

  it('rejects a platform when a required artifact or its packaged config template is missing', async () => {
    const releaseDir = await createReleaseFixture();
    await rm(join(releaseDir, 'linux', 'UniShell-1.0.0-x64.AppImage'));

    await expect(
      verifyRelease({
        releaseDir,
        templatePath: join(releaseDir, 'config.example.json'),
        platforms: ['linux'],
        version: '1.0.0',
        env: {},
      }),
    ).rejects.toThrow(/AppImage/);
  });

  it('rejects artifacts whose filename version differs from the release version', async () => {
    const releaseDir = await createReleaseFixture();

    await expect(
      verifyRelease({
        releaseDir,
        templatePath: join(releaseDir, 'config.example.json'),
        platforms: ['windows'],
        version: '2.0.0',
      }),
    ).rejects.toThrow(/version 2\.0\.0/);
  });

  it('rejects artifacts when the config template was not embedded in the unpacked application', async () => {
    const releaseDir = await createReleaseFixture();
    await rm(join(releaseDir, 'windows', 'unpacked', 'resources', 'config.example.json'));

    await expect(
      verifyRelease({
        releaseDir,
        templatePath: join(releaseDir, 'config.example.json'),
        platforms: ['windows'],
        version: '1.0.0',
      }),
    ).rejects.toThrow(/packaged config.example.json/);
  });

  it('requires signing and notarization inputs before accepting macOS artifacts', async () => {
    const releaseDir = await createReleaseFixture();

    await expect(
      verifyRelease({
        releaseDir,
        templatePath: join(releaseDir, 'config.example.json'),
        platforms: ['mac'],
        version: '1.0.0',
      }),
    ).rejects.toThrow(/Developer ID signing and notarization/);
  });

  it('accepts unsigned macOS artifacts when allowUnsignedMac is enabled', async () => {
    const releaseDir = await createReleaseFixture();

    const result = await verifyRelease({
      releaseDir,
      templatePath: join(releaseDir, 'config.example.json'),
      platforms: ['mac'],
      version: '1.0.0',
      allowUnsignedMac: true,
      signingStatus: { mac: { signed: false, notarized: false } },
    });

    expect(result.manifest.artifacts).toHaveLength(2);
    expect(result.manifest.artifacts[0].signing).toEqual({
      codeSigned: false,
      notarized: false,
    });
  });

  it('rejects a missing or malformed configuration template', async () => {
    const releaseDir = await createReleaseFixture();
    const templatePath = join(releaseDir, 'config.example.json');
    await writeFile(templatePath, '{broken json');

    await expect(
      verifyRelease({
        releaseDir,
        templatePath,
        platforms: ['linux'],
        version: '1.0.0',
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('does not alter a supplied active config while generating the release manifest', async () => {
    const releaseDir = await createReleaseFixture();
    const activeConfigPath = join(releaseDir, 'config.json');
    const activeConfig = '{"targetUrl":"https://customer.example"}\n';
    await writeFile(activeConfigPath, activeConfig);

    await verifyRelease({
      releaseDir,
      templatePath: join(releaseDir, 'config.example.json'),
      platforms: ['linux'],
      version: '1.0.0',
    });

    expect(await readFile(activeConfigPath, 'utf8')).toBe(activeConfig);
  });
});

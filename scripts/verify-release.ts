import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, readdirSync } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

export const RELEASE_PLATFORMS = ['windows', 'mac', 'linux'] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

const TARGETS: Record<ReleasePlatform, { architectures: string[]; extensions: string[]; label: string }> = {
  windows: { architectures: ['x64'], extensions: ['.exe', '.zip'], label: 'Windows NSIS/ZIP' },
  mac: { architectures: ['universal'], extensions: ['.dmg', '.zip'], label: 'macOS Universal DMG/ZIP' },
  linux: { architectures: ['x64'], extensions: ['.deb', '.appimage'], label: 'Linux DEB/AppImage' },
};

const ARCHITECTURE_ALIASES: Record<string, string[]> = {
  x64: ['x64', 'x86_64', 'amd64'],
  universal: ['universal'],
};

export interface SigningStatus {
  windows?: { signed: boolean };
  mac?: { signed: boolean; notarized: boolean };
  linux?: { signed: boolean };
}

export interface ReleaseArtifact {
  filename: string;
  platform: ReleasePlatform;
  architectures: string[];
  sizeBytes: number;
  sha256: string;
  signing: { codeSigned: boolean; notarized: boolean };
}

export interface ReleaseManifest {
  product: string;
  version: string;
  generatedAt: string;
  platforms: ReleasePlatform[];
  configuration: {
    template: 'config.example.json';
    activeConfigOverwrite: false;
    upgradePolicy: 'preserve-existing';
  };
  artifacts: ReleaseArtifact[];
}

export interface VerifyReleaseOptions {
  releaseDir: string;
  templatePath?: string;
  platforms?: readonly ReleasePlatform[];
  version: string;
  now?: Date;
  signingStatus?: SigningStatus;
}

export interface VerifyReleaseResult {
  manifestPath: string;
  manifest: ReleaseManifest;
}

async function sha256(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function artifactsFor(platformDirectory: string, platform: ReleasePlatform): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(platformDirectory, { withFileTypes: true });
  } catch {
    throw new Error(TARGETS[platform].label + ' output directory is missing: ' + platformDirectory);
  }
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const matches = names.filter((name) => TARGETS[platform].extensions.includes(extname(name).toLowerCase()));
  for (const extension of TARGETS[platform].extensions) {
    const name = matches.find((candidate) => extname(candidate).toLowerCase() === extension);
    if (!name) throw new Error(TARGETS[platform].label + ' is missing a ' + extension + ' artifact');
    const architecture = TARGETS[platform].architectures[0];
    if (!ARCHITECTURE_ALIASES[architecture].some((alias) => name.toLowerCase().includes(alias))) {
      throw new Error(name + ' does not declare ' + architecture + ' architecture');
    }
  }
  return matches.sort((left, right) => left.localeCompare(right));
}

async function validateConfigTemplate(templatePath: string): Promise<void> {
  try {
    await access(templatePath);
  } catch {
    throw new Error('Config template is missing: ' + templatePath);
  }
  let template: unknown;
  try {
    template = JSON.parse(await readFile(templatePath, 'utf8'));
  } catch {
    throw new Error('Config template is not valid JSON: ' + templatePath);
  }
  if (!template || typeof template !== 'object' || (template as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new Error('Config template must contain schemaVersion 1: ' + templatePath);
  }
}

async function hasPackagedConfigTemplate(directory: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  if (
    entries.some((entry) => entry.isFile() && entry.name === 'config.example.json') &&
    directory.toLowerCase().endsWith('resources')
  ) {
    return true;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && (await hasPackagedConfigTemplate(join(directory, entry.name)))) return true;
  }
  return false;
}

export async function verifyRelease(options: VerifyReleaseOptions): Promise<VerifyReleaseResult> {
  const releaseDir = resolve(options.releaseDir);
  const platforms = [...new Set(options.platforms ?? RELEASE_PLATFORMS)];
  if (platforms.length === 0) throw new Error('Select at least one platform to verify');
  if (platforms.some((platform) => !RELEASE_PLATFORMS.includes(platform))) {
    throw new Error('Unsupported platform in release verification request');
  }

  await validateConfigTemplate(resolve(options.templatePath ?? 'resources/config.example.json'));
  const artifacts: ReleaseArtifact[] = [];
  for (const platform of platforms) {
    const platformDirectory = join(releaseDir, platform);
    const names = await artifactsFor(platformDirectory, platform);
    if (!(await hasPackagedConfigTemplate(platformDirectory))) {
      throw new Error(TARGETS[platform].label + ' is missing packaged config.example.json under app resources');
    }
    if (platform === 'mac' && (!options.signingStatus?.mac?.signed || !options.signingStatus.mac.notarized)) {
      throw new Error('macOS artifacts require verified Developer ID signing and notarization');
    }
    for (const filename of names) {
      const filePath = join(platformDirectory, filename);
      const fileStat = await stat(filePath);
      artifacts.push({
        filename: join(platform, filename).replaceAll(String.fromCharCode(92), '/'),
        platform,
        architectures: [...TARGETS[platform].architectures],
        sizeBytes: fileStat.size,
        sha256: await sha256(filePath),
        signing: {
          codeSigned:
            platform === 'mac'
              ? options.signingStatus?.mac?.signed === true
              : platform === 'windows' && extname(filename).toLowerCase() === '.exe'
                ? options.signingStatus?.windows?.signed === true
                : platform === 'linux' && options.signingStatus?.linux?.signed === true,
          notarized: platform === 'mac' && options.signingStatus?.mac?.notarized === true,
        },
      });
    }
  }

  const manifest: ReleaseManifest = {
    product: 'UniShell',
    version: options.version,
    generatedAt: (options.now ?? new Date()).toISOString(),
    platforms,
    configuration: {
      template: 'config.example.json',
      activeConfigOverwrite: false,
      upgradePolicy: 'preserve-existing',
    },
    artifacts,
  };
  const manifestPath = join(releaseDir, 'release-manifest.json');
  const temporaryPath = manifestPath + '.tmp-' + process.pid;
  await writeFile(temporaryPath, JSON.stringify(manifest, null, 2) + String.fromCharCode(10), 'utf8');
  await rename(temporaryPath, manifestPath);
  return { manifestPath, manifest };
}

function hasNotarizationCredentials(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
      (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) ||
      (env.APPLE_KEYCHAIN && env.APPLE_KEYCHAIN_PROFILE),
  );
}

function assertMacBuildCredentials(env: NodeJS.ProcessEnv): void {
  if (process.platform !== 'darwin') throw new Error('macOS packaging and signing must run on a macOS host');
  if (!env.CSC_LINK && !env.CSC_NAME) {
    throw new Error('macOS release requires a Developer ID signing certificate via CSC_LINK or CSC_NAME');
  }
  if (!hasNotarizationCredentials(env)) {
    throw new Error('macOS release requires Apple notarization credentials');
  }
}

function assertLinuxBuildMetadata(env: NodeJS.ProcessEnv): void {
  if (!env.UNI_SHELL_LINUX_MAINTAINER?.includes('@')) {
    throw new Error('Linux DEB builds require UNI_SHELL_LINUX_MAINTAINER in "Name <email>" format');
  }
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: 'pipe' });
}

async function verifyMacSigning(releaseDir: string): Promise<SigningStatus['mac']> {
  if (process.platform !== 'darwin') throw new Error('macOS signature verification must run on macOS');
  const macDir = join(releaseDir, 'mac');
  const names = await readdir(macDir);
  const zip = names.find((name) => extname(name).toLowerCase() === '.zip');
  const dmg = names.find((name) => extname(name).toLowerCase() === '.dmg');
  if (!zip || !dmg) throw new Error('macOS signing verification requires ZIP and DMG artifacts');

  const extractionDirectory = await mkdtemp(join(tmpdir(), 'uni-shell-mac-verify-'));
  try {
    run('ditto', ['-x', '-k', join(macDir, zip), extractionDirectory]);
    const findApp = async (directory: string): Promise<string | undefined> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory() && entry.name.endsWith('.app')) return entryPath;
        if (entry.isDirectory()) {
          const nested = await findApp(entryPath);
          if (nested) return nested;
        }
      }
      return undefined;
    };
    const appPath = await findApp(extractionDirectory);
    if (!appPath) throw new Error('macOS ZIP does not contain an .app bundle');
    run('codesign', ['--verify', '--deep', '--strict', appPath]);
    run('xcrun', ['stapler', 'validate', appPath]);
    run('xcrun', ['stapler', 'validate', join(macDir, dmg)]);
    return { signed: true, notarized: true };
  } catch (error) {
    throw new Error('macOS signature or notarization verification failed: ' + String(error));
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }
}

function verifyWindowsAuthenticode(releaseDir: string): SigningStatus['windows'] {
  if (process.platform !== 'win32') return { signed: false };
  const directory = join(releaseDir, 'windows');
  const executable = readdirSync(directory).find((name) => extname(name).toLowerCase() === '.exe');
  if (!executable) throw new Error('Missing Windows NSIS installer');
  const fullPath = join(directory, executable);
  const psPath = "'" + fullPath.replaceAll("'", "''") + "'";
  const command =
    '$signature = Get-AuthenticodeSignature -LiteralPath ' +
    psPath +
    '; if ($signature.Status -eq \'Valid\') { exit 0 } else { exit 1 }';
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'pipe' });
    return { signed: true };
  } catch {
    return { signed: false };
  }
}

function parseArguments(args: string[]): {
  preflight?: ReleasePlatform;
  releaseDir: string;
  platforms?: ReleasePlatform[];
} {
  const result: { preflight?: ReleasePlatform; releaseDir: string; platforms?: ReleasePlatform[] } = {
    releaseDir: resolve('release'),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--preflight' || argument.startsWith('--preflight=')) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[++index];
      if (!value || !RELEASE_PLATFORMS.includes(value as ReleasePlatform)) {
        throw new Error('Usage: --preflight ' + RELEASE_PLATFORMS.join('|'));
      }
      result.preflight = value as ReleasePlatform;
    } else if (argument === '--platform' || argument.startsWith('--platform=')) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[++index];
      if (!value || !RELEASE_PLATFORMS.includes(value as ReleasePlatform)) {
        throw new Error('Usage: --platform ' + RELEASE_PLATFORMS.join('|'));
      }
      (result.platforms ??= []).push(value as ReleasePlatform);
    } else if (argument.startsWith('--release-dir=')) {
      result.releaseDir = resolve(argument.slice('--release-dir='.length));
    } else {
      throw new Error('Unknown argument: ' + argument);
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.preflight) {
    if (args.preflight === 'mac') {
      assertMacBuildCredentials(process.env);
      process.stdout.write('macOS host and signing/notarization credentials are available.' + String.fromCharCode(10));
    } else if (args.preflight === 'linux') {
      assertLinuxBuildMetadata(process.env);
      process.stdout.write('Linux package maintainer metadata is available.' + String.fromCharCode(10));
    } else {
      process.stdout.write('Windows package signing is optional and no preflight is required.' + String.fromCharCode(10));
    }
    return;
  }

  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
  const signingStatus: SigningStatus = {};
  if (args.platforms?.includes('mac') || !args.platforms) {
    signingStatus.mac = await verifyMacSigning(args.releaseDir);
  }
  if (args.platforms?.includes('windows') || !args.platforms) {
    signingStatus.windows = verifyWindowsAuthenticode(args.releaseDir);
  }
  const result = await verifyRelease({
    releaseDir: args.releaseDir,
    version: packageJson.version,
    platforms: args.platforms,
    signingStatus,
  });
  process.stdout.write(
    'Verified ' +
      result.manifest.artifacts.length +
      ' artifacts; manifest: ' +
      result.manifestPath +
      String.fromCharCode(10),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/verify-release.ts')) {
  main().catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + String.fromCharCode(10));
    process.exitCode = 1;
  });
}

import { access, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { nativeImage } from 'electron';
import type { Logger } from '../logging/logger';
import type { ResolvedConfigPaths } from '../platform/config-paths';
import {
  loadAppIcon,
  type IconFileSystem,
  type IconImageFactory,
  type ResolvedAppIcon,
} from './icon-manager';

export const electronIconFs: IconFileSystem = {
  readFile: (path) => readFile(path) as Promise<Uint8Array>,
  writeFile: (path, data) => writeFile(path, data),
  readdir: (path) => readdir(path),
  unlink: (path) => unlink(path),
  access: (path) => access(path),
};

export const electronIconImages: IconImageFactory = {
  fromBuffer: (data) => nativeImage.createFromBuffer(Buffer.from(data)),
  fromDataURL: (dataUrl) => nativeImage.createFromDataURL(dataUrl),
};

export interface ResolveApplicationIconDeps {
  fs?: IconFileSystem;
  images?: IconImageFactory;
}

/**
 * 解析应用图标（规格 §5.4）：用户图标缺失、损坏或超限时回退内置默认图标。
 * 结果在启动前一次解析，供窗口工厂、托盘与 Dock 共用；图标变化需重启生效。
 */
export async function resolveApplicationIcon(
  paths: ResolvedConfigPaths,
  configuredIcon: string | null | undefined,
  logger: Logger,
  deps: ResolveApplicationIconDeps = {},
): Promise<ResolvedAppIcon> {
  const icon = await loadAppIcon({
    icon: configuredIcon ?? null,
    configDirectory: paths.writeDirectory,
    fs: deps.fs ?? electronIconFs,
    images: deps.images ?? electronIconImages,
  });

  if (icon.source === 'configured') {
    logger.info('icon-resolved', { source: 'configured', fileName: icon.fileName });
  } else if (icon.fallbackReason !== undefined) {
    logger.warn('icon-fallback', { reason: icon.fallbackReason });
  }

  return icon;
}

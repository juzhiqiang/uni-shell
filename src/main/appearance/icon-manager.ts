/**
 * 应用图标资源管理（规格 v2.1.1 §5.4）。
 *
 * 职责：解析配置目录中的用户图标、加载与回退（缺失/损坏/超限回退内置默认图标）、
 * 安装配置界面选择的图标、清理未被引用的残留图标文件。
 *
 * 设计约束（`rules/architecture.md`）：
 * - 本模块不导入 Electron：文件系统与镜像工厂由主进程注入，可在纯 Node 环境完整测试；
 * - 内置默认图标以 data URL 形式内嵌（`./default-icon.ts`）——打包产物只包含 dist/，
 *   resources/ 不随包分发，内嵌保证开发与打包环境行为一致；
 * - 配置只记录裸文件名，路径解析拒绝穿越，杜绝把任意文件当图标加载。
 */

import { posix, win32 } from 'node:path';

function joinPath(directory: string, fileName: string): string {
  const pathApi = directory.startsWith('/') ? posix : win32;
  return pathApi.join(directory, fileName);
}

import { isIconFileName } from '../config/config-schema';
import { DEFAULT_ICON_DATA_URL_256, DEFAULT_ICON_DATA_URL_32 } from './default-icon';

/** 配置目录中用户图标的固定基名；扩展名随用户选择的格式变化。 */
export const ICON_FILE_BASE_NAME = 'app-icon';

/** 支持的图标扩展名（小写、不带点）。 */
export const ICON_FILE_EXTENSIONS = ['png', 'ico', 'icns'] as const;

export type IconFileExtension = (typeof ICON_FILE_EXTENSIONS)[number];

/** 图标文件大小上限；超出按损坏处理，避免异常文件拖慢启动。 */
export const MAX_ICON_FILE_BYTES = 8 * 1024 * 1024;

/** 配置界面预览图的最大边长。 */
export const PREVIEW_ICON_SIZE = 64;

/** 托盘图标尺寸：Windows 通知区域 16px；macOS 菜单栏与 Linux StatusNotifierItem 由桌面缩放。 */
export const TRAY_ICON_SIZE = { width: 16, height: 16 };

/** 镜像最小读取面；真实实现由主进程用 Electron `nativeImage` 注入。 */
export interface IconImageLike {
  isEmpty(): boolean;
  resize(size: { width: number; height: number }): IconImageLike;
  toDataURL(): string;
}

/** 镜像工厂；真实实现由主进程注入。 */
export interface IconImageFactory {
  fromBuffer(data: Uint8Array): IconImageLike;
  fromDataURL(dataUrl: string): IconImageLike;
}

/** 图标操作需要的文件系统能力。 */
export interface IconFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readdir(directory: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  access(path: string): Promise<void>;
}

export type IconSource = 'configured' | 'default';

/** 图标解析结果：窗口/Dock 与托盘各持一份，调用方无需再处理缩放。 */
export interface ResolvedAppIcon {
  /** 窗口（Windows 任务栏、Linux 窗口）与 macOS Dock 用图标。 */
  image: IconImageLike;
  /** 托盘用图标（已调整为托盘尺寸）。 */
  trayImage: IconImageLike;
  source: IconSource;
  /** 自定义图标文件名（`source === 'configured'` 时存在）。 */
  fileName?: string;
  /** 回退到内置默认图标的原因；未回退时不存在。 */
  fallbackReason?: string;
  /** Windows 任务栏专属 .ico 图标路径（如果存在）。 */
  windowsIcoPath?: string;
}

export interface LoadAppIconDeps {
  /** 配置中的图标文件名；空串、null 或缺失表示使用内置默认图标。 */
  icon: string | null | undefined;
  /** 配置写入目录（用户图标所在目录）。 */
  configDirectory: string;
  fs: IconFileSystem;
  images: IconImageFactory;
}

export interface InstallPickedIconDeps {
  /** 用户在文件对话框中选择的图标路径。 */
  pickedPath: string;
  configDirectory: string;
  fs: IconFileSystem;
  images: IconImageFactory;
}

export interface IconInstallResult {
  ok: boolean;
  /** 安装后的配置目录文件名（成功时存在）。 */
  fileName?: string;
  /** 供配置界面展示的预览 data URL（成功时存在）。 */
  previewDataUrl?: string;
  /** 失败时的可操作错误信息。 */
  message?: string;
}

export interface RemoveUnreferencedIconFilesDeps {
  configDirectory: string;
  /** 当前配置引用的图标文件名；空串表示使用内置默认图标。 */
  configuredIcon: string;
  fs: IconFileSystem;
}

/** 取图标文件的扩展名（小写、不带点）；不支持时返回 null。 */
export function normalizeIconExtension(fileName: string): IconFileExtension | null {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return null;
  const extension = fileName.slice(dot + 1).toLowerCase();
  return (ICON_FILE_EXTENSIONS as readonly string[]).includes(extension) ? (extension as IconFileExtension) : null;
}

/** 按扩展名生成配置目录中的固定图标文件名。 */
export function iconFileNameForExtension(extension: string): string {
  const normalized = extension.toLowerCase().replace(/^\./, '');
  if (!(ICON_FILE_EXTENSIONS as readonly string[]).includes(normalized)) {
    throw new Error(`不支持的图标扩展名：${extension}`);
  }
  return `${ICON_FILE_BASE_NAME}.${normalized}`;
}

/** 解析配置目录中的图标路径；文件名不合法（穿越、错误扩展名等）时返回 null。 */
export function resolveIconPath(configDirectory: string, fileName: string): string | null {
  if (!isIconFileName(fileName)) return null;
  return joinPath(configDirectory, fileName);
}

/**
 * 从原始配置对象中读取图标文件名。
 * 供启动前预读（与 `readLoggingPreferences` 同一模式）：文件缺失、损坏或字段异常时
 * 返回 null，由内置默认图标兜底；损坏文件的隔离由正式加载流程负责。
 */
export function readConfiguredIconFileName(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const appearance = (parsed as { appearance?: unknown }).appearance;
  if (typeof appearance !== 'object' || appearance === null) return null;
  const icon = (appearance as { icon?: unknown }).icon;
  if (typeof icon !== 'string' || icon === '') return null;
  return isIconFileName(icon) ? icon : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 内置默认图标：窗口/Dock 用 256，托盘用 32（按托盘尺寸预生成，避免缩放发虚）。 */
export function createDefaultAppIcon(images: IconImageFactory): ResolvedAppIcon {
  return {
    image: images.fromDataURL(DEFAULT_ICON_DATA_URL_256),
    trayImage: images.fromDataURL(DEFAULT_ICON_DATA_URL_32),
    source: 'default',
  };
}

function fallbackIcon(images: IconImageFactory, reason: string): ResolvedAppIcon {
  return { ...createDefaultAppIcon(images), fallbackReason: reason };
}

/**
 * 把 PNG 字节序列封装为合法的 ICO 格式（Windows 任务栏 setAppDetails 与快捷方式专属）。
 * Windows Vista 起官方支持在 ICO 中直接内嵌 PNG 图像，无需二次转码。
 * 结构：
 * - ICONDIR (6 bytes): idReserved(0), idType(1), idCount(1)
 * - ICONDIRENTRY (16 bytes): bWidth, bHeight, bColorCount(0), bReserved(0), wPlanes(1), wBitCount(32), dwBytesInRes, dwImageOffset(22)
 * - PNG 原始图像数据 (紧随 22 字节头之后)
 */
export function wrapPngToIco(pngBytes: Uint8Array): Uint8Array {
  let width = 0;
  let height = 0;
  if (
    pngBytes.length >= 24 &&
    pngBytes[0] === 0x89 &&
    pngBytes[1] === 0x50 &&
    pngBytes[2] === 0x4e &&
    pngBytes[3] === 0x47
  ) {
    const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
    const w = view.getUint32(16, false);
    const h = view.getUint32(20, false);
    width = w >= 256 ? 0 : w;
    height = h >= 256 ? 0 : h;
  }
  const icoSize = 22 + pngBytes.byteLength;
  const ico = new Uint8Array(icoSize);
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);

  // ICONDIR
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);

  // ICONDIRENTRY
  view.setUint8(6, width);
  view.setUint8(7, height);
  view.setUint8(8, 0);
  view.setUint8(9, 0);
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, pngBytes.byteLength, true);
  view.setUint32(18, 22, true);

  ico.set(pngBytes, 22);
  return ico;
}

/**
 * 按配置解析应用图标。
 *
 * 任何异常（文件名不合法、文件缺失、读取失败、为空、超限、无法解析）都不抛出：
 * 回退内置默认图标并带上原因，由调用方记录日志——图标问题不得阻断启动（规格 §5.4）。
 */
export async function loadAppIcon(deps: LoadAppIconDeps): Promise<ResolvedAppIcon> {
  const { fs, images } = deps;
  const fileName = deps.icon?.trim() ?? '';

  if (fileName === '') return createDefaultAppIcon(images);

  const path = resolveIconPath(deps.configDirectory, fileName);
  if (path === null) {
    return fallbackIcon(images, `配置的图标文件名不合法：${fileName}`);
  }

  let bytes: Uint8Array;
  try {
    await fs.access(path);
  } catch {
    return fallbackIcon(images, `图标文件不存在：${path}`);
  }
  try {
    bytes = await fs.readFile(path);
  } catch (error) {
    return fallbackIcon(images, `图标文件读取失败（${path}）：${describeError(error)}`);
  }

  if (bytes.byteLength === 0) {
    return fallbackIcon(images, `图标文件为空：${path}`);
  }
  if (bytes.byteLength > MAX_ICON_FILE_BYTES) {
    return fallbackIcon(images, `图标文件超过 ${MAX_ICON_FILE_BYTES / 1024 / 1024} MB 上限：${path}`);
  }

  const image = images.fromBuffer(bytes);
  if (image.isEmpty()) {
    return fallbackIcon(images, `图标文件无法解析（可能已损坏或格式不受支持）：${path}`);
  }

  let windowsIcoPath: string | undefined;
  if (fileName.toLowerCase().endsWith('.ico')) {
    windowsIcoPath = path;
  } else if (fileName.toLowerCase().endsWith('.png')) {
    const icoPath = joinPath(deps.configDirectory, `${ICON_FILE_BASE_NAME}.ico`);
    try {
      const icoBytes = wrapPngToIco(bytes);
      await fs.writeFile(icoPath, icoBytes);
      windowsIcoPath = icoPath;
    } catch {
      // 写入辅助 .ico 失败不影响常规图标加载
    }
  }

  return {
    image,
    trayImage: image.resize(TRAY_ICON_SIZE),
    source: 'configured',
    fileName,
    windowsIcoPath,
  };
}

/**
 * 安装配置界面选择的图标：读取并校验 → 写入配置目录固定文件名 → 清理其他扩展名的残留。
 * 先写后清理：写入失败时保留原图标，不会让用户的图标配置落空。
 */
export async function installPickedIcon(deps: InstallPickedIconDeps): Promise<IconInstallResult> {
  const { fs, images } = deps;
  const pickedName = deps.pickedPath.split(/[\\/]/).pop() ?? '';
  const extension = normalizeIconExtension(pickedName);
  if (extension === null) {
    return { ok: false, message: '请选择 PNG、ICO 或 ICNS 格式的图标文件' };
  }

  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(deps.pickedPath);
  } catch (error) {
    return { ok: false, message: `无法读取所选文件：${describeError(error)}` };
  }

  if (bytes.byteLength === 0) {
    return { ok: false, message: '所选文件为空' };
  }
  if (bytes.byteLength > MAX_ICON_FILE_BYTES) {
    return { ok: false, message: `所选文件超过 ${MAX_ICON_FILE_BYTES / 1024 / 1024} MB 上限` };
  }

  const image = images.fromBuffer(bytes);
  if (image.isEmpty()) {
    return { ok: false, message: '所选文件无法解析为图标（可能已损坏或格式不受支持）' };
  }

  const fileName = iconFileNameForExtension(extension);
  const target = joinPath(deps.configDirectory, fileName);

  try {
    await fs.writeFile(target, bytes);
    if (extension === 'png') {
      const icoTarget = joinPath(deps.configDirectory, `${ICON_FILE_BASE_NAME}.ico`);
      try {
        await fs.writeFile(icoTarget, wrapPngToIco(bytes));
      } catch {
        // 辅助 .ico 写入失败不影响安装结果
      }
    }
  } catch (error) {
    return { ok: false, message: `图标写入配置目录失败：${describeError(error)}` };
  }

  // 清理其他扩展名的残留（用户从 PNG 换成 ICO 等场景）；失败不影响本次安装结果。
  await removeUnreferencedIconFiles({ configDirectory: deps.configDirectory, configuredIcon: fileName, fs });

  return {
    ok: true,
    fileName,
    previewDataUrl: image.resize({ width: PREVIEW_ICON_SIZE, height: PREVIEW_ICON_SIZE }).toDataURL(),
  };
}

/** 匹配配置目录中由本模块管理的图标文件（固定基名 + 受支持扩展名）。 */
function isManagedIconFileName(name: string): boolean {
  const prefix = `${ICON_FILE_BASE_NAME}.`;
  if (!name.toLowerCase().startsWith(prefix)) return false;
  return normalizeIconExtension(name) !== null;
}

/**
 * 清理未被配置引用的 `app-icon.*` 文件；返回被清理的文件名。
 * 目录不可读等异常不抛出——清理失败不影响启动，最多留下一个小文件。
 */
export async function removeUnreferencedIconFiles(
  deps: RemoveUnreferencedIconFilesDeps,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await deps.fs.readdir(deps.configDirectory);
  } catch {
    return [];
  }

  const companionIco = deps.configuredIcon === `${ICON_FILE_BASE_NAME}.png` ? `${ICON_FILE_BASE_NAME}.ico` : undefined;

  const removed: string[] = [];
  for (const entry of entries) {
    if (!isManagedIconFileName(entry)) continue;
    if (entry === deps.configuredIcon) continue;
    if (companionIco !== undefined && entry === companionIco) continue;
    try {
      await deps.fs.unlink(joinPath(deps.configDirectory, entry));
      removed.push(entry);
    } catch {
      // 单个文件清理失败继续处理其余文件。
    }
  }
  return removed;
}

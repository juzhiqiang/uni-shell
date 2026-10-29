import { describe, expect, it, vi } from 'vitest';

import {
  ICON_FILE_BASE_NAME,
  iconFileNameForExtension,
  installPickedIcon,
  loadAppIcon,
  normalizeIconExtension,
  readConfiguredIconFileName,
  removeUnreferencedIconFiles,
  resolveIconPath,
  type IconFileSystem,
  type IconImageFactory,
  type IconImageLike,
} from '../../../src/main/appearance/icon-manager';
import { DEFAULT_ICON_DATA_URL_256, DEFAULT_ICON_DATA_URL_32 } from '../../../src/main/appearance/default-icon';

/**
 * 应用图标资源管理（规格 §5.4）。
 * 只注入文件系统与镜像工厂，不触碰 Electron，可在纯 Node 环境完整测试。
 */

describe('内置默认图标', () => {
  it.each([
    ['256', DEFAULT_ICON_DATA_URL_256, 256],
    ['32', DEFAULT_ICON_DATA_URL_32, 32],
  ])('%s data URL 是尺寸正确的合法 PNG（防止托盘/窗口再次空白）', (_name, dataUrl, expectedSize) => {
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);

    const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    // PNG 签名 + IHDR（宽高为大端 uint32，位于第 16 字节起）。
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(bytes.readUInt32BE(16)).toBe(expectedSize);
    expect(bytes.readUInt32BE(20)).toBe(expectedSize);
    expect(bytes[24]).toBe(8); // bit depth
    expect(bytes[25]).toBe(6); // color type: RGBA
    expect(bytes.length).toBeGreaterThan(100);
  });
});

const CONFIG_DIRECTORY = '/home/tester/.config/uni-shell';
const ICON_PATH = `${CONFIG_DIRECTORY}/app-icon.png`;

function makeImage(data: Uint8Array): IconImageLike {
  const text = new TextDecoder().decode(data);
  const image = {
    data,
    isEmpty: () => text === 'corrupt' || data.byteLength === 0,
    resize: (size: { width: number; height: number }) =>
      makeImage(new TextEncoder().encode(`resized:${size.width}x${size.height}:${text}`)),
    toDataURL: () => `data:image/png;base64,${Buffer.from(data).toString('base64')}`,
  };
  return image as IconImageLike & { data: Uint8Array };
}

function imageText(image: IconImageLike): string {
  return new TextDecoder().decode((image as unknown as { data: Uint8Array }).data);
}

function createFs(files: Record<string, Uint8Array> = {}) {
  const store = new Map<string, Uint8Array>(Object.entries(files));
  return {
    store,
    readFile: vi.fn(async (path: string) => {
      const data = store.get(path);
      if (data === undefined) throw new Error(`ENOENT: ${path}`);
      return data;
    }),
    writeFile: vi.fn(async (path: string, data: Uint8Array) => {
      store.set(path, data);
    }),
    readdir: vi.fn(async (directory: string) => {
      const prefix = `${directory}/`;
      return [...store.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
    }),
    unlink: vi.fn(async (path: string) => {
      store.delete(path);
    }),
    access: vi.fn(async (path: string) => {
      if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
    }),
  };
}

function createImages() {
  return {
    fromBuffer: vi.fn((data: Uint8Array) => makeImage(data)),
    fromDataURL: vi.fn((dataUrl: string) => makeImage(new TextEncoder().encode(dataUrl))),
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('图标文件名工具', () => {
  it('归一化扩展名并生成固定文件名', () => {
    expect(normalizeIconExtension('logo.PNG')).toBe('png');
    expect(normalizeIconExtension('logo.ico')).toBe('ico');
    expect(normalizeIconExtension('logo.icns')).toBe('icns');
    expect(normalizeIconExtension('logo.jpg')).toBeNull();
    expect(normalizeIconExtension('logo')).toBeNull();

    expect(iconFileNameForExtension('png')).toBe('app-icon.png');
    expect(iconFileNameForExtension('ico')).toBe('app-icon.ico');
    expect(iconFileNameForExtension('icns')).toBe('app-icon.icns');
    expect(ICON_FILE_BASE_NAME).toBe('app-icon');
  });

  it('解析配置目录中的图标路径，拒绝穿越与非法名', () => {
    expect(resolveIconPath(CONFIG_DIRECTORY, 'app-icon.png')).toBe(ICON_PATH);
    expect(resolveIconPath(CONFIG_DIRECTORY, 'my-logo.png')).toBe(`${CONFIG_DIRECTORY}/my-logo.png`);
    expect(resolveIconPath(CONFIG_DIRECTORY, '../app-icon.png')).toBeNull();
    expect(resolveIconPath(CONFIG_DIRECTORY, 'app-icon.jpg')).toBeNull();
    expect(resolveIconPath(CONFIG_DIRECTORY, '')).toBeNull();
  });
});

describe('readConfiguredIconFileName', () => {
  it('从原始配置中读取合法的图标文件名', () => {
    expect(readConfiguredIconFileName({ appearance: { icon: 'app-icon.png' } })).toBe('app-icon.png');
  });

  it('缺失、为空、非法或结构异常时返回 null', () => {
    expect(readConfiguredIconFileName({})).toBeNull();
    expect(readConfiguredIconFileName({ appearance: {} })).toBeNull();
    expect(readConfiguredIconFileName({ appearance: { icon: '' } })).toBeNull();
    expect(readConfiguredIconFileName({ appearance: { icon: '../x.png' } })).toBeNull();
    expect(readConfiguredIconFileName({ appearance: 'app-icon.png' })).toBeNull();
    expect(readConfiguredIconFileName(null)).toBeNull();
    expect(readConfiguredIconFileName('config')).toBeNull();
  });
});

describe('loadAppIcon', () => {
  it('未配置图标时使用内置默认图标（窗口 256、托盘 32）', async () => {
    const fs = createFs();
    const images = createImages();

    const resolved = await loadAppIcon({ icon: '', configDirectory: CONFIG_DIRECTORY, fs, images });

    expect(resolved.source).toBe('default');
    expect(resolved.fileName).toBeUndefined();
    expect(resolved.fallbackReason).toBeUndefined();
    expect(images.fromDataURL).toHaveBeenCalledWith(DEFAULT_ICON_DATA_URL_256);
    expect(images.fromDataURL).toHaveBeenCalledWith(DEFAULT_ICON_DATA_URL_32);
    expect(imageText(resolved.image)).toBe(DEFAULT_ICON_DATA_URL_256);
    expect(imageText(resolved.trayImage)).toBe(DEFAULT_ICON_DATA_URL_32);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('配置的图标存在且可解析时使用自定义图标，托盘缩放到 16', async () => {
    const fs = createFs({ [ICON_PATH]: bytes('icon-bytes') });
    const images = createImages();

    const resolved = await loadAppIcon({ icon: 'app-icon.png', configDirectory: CONFIG_DIRECTORY, fs, images });

    expect(resolved.source).toBe('configured');
    expect(resolved.fileName).toBe('app-icon.png');
    expect(resolved.fallbackReason).toBeUndefined();
    expect(imageText(resolved.image)).toBe('icon-bytes');
    expect(imageText(resolved.trayImage)).toBe('resized:16x16:icon-bytes');
  });

  it('图标文件缺失时回退默认图标并说明原因', async () => {
    const fs = createFs();
    const images = createImages();

    const resolved = await loadAppIcon({ icon: 'app-icon.png', configDirectory: CONFIG_DIRECTORY, fs, images });

    expect(resolved.source).toBe('default');
    expect(resolved.fallbackReason).toContain('不存在');
  });

  it('图标文件名不合法时回退默认图标', async () => {
    const fs = createFs();
    const images = createImages();

    const resolved = await loadAppIcon({ icon: '../app-icon.png', configDirectory: CONFIG_DIRECTORY, fs, images });

    expect(resolved.source).toBe('default');
    expect(resolved.fallbackReason).toContain('不合法');
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('图标文件为空、超限或无法解析时回退默认图标', async () => {
    for (const [name, content] of [
      ['空文件', new Uint8Array()],
      ['损坏文件', bytes('corrupt')],
      ['超大文件', new Uint8Array(8 * 1024 * 1024 + 1)],
    ] as const) {
      const fs = createFs({ [ICON_PATH]: content });
      const images = createImages();

      const resolved = await loadAppIcon({ icon: 'app-icon.png', configDirectory: CONFIG_DIRECTORY, fs, images });

      expect(resolved.source, name).toBe('default');
      expect(resolved.fallbackReason, name).toBeTruthy();
    }
  });
});

describe('installPickedIcon', () => {
  it('把所选图标复制到配置目录并返回预览', async () => {
    const fs = createFs({
      '/home/tester/Downloads/logo.png': bytes('picked-icon'),
      [`${CONFIG_DIRECTORY}/app-icon.ico`]: bytes('old-icon'),
    });
    const images = createImages();

    const result = await installPickedIcon({
      pickedPath: '/home/tester/Downloads/logo.png',
      configDirectory: CONFIG_DIRECTORY,
      fs,
      images,
    });

    expect(result.ok).toBe(true);
    expect(result.fileName).toBe('app-icon.png');
    expect(result.previewDataUrl).toBe(
      `data:image/png;base64,${Buffer.from('resized:64x64:picked-icon').toString('base64')}`,
    );
    expect(fs.store.get(ICON_PATH)).toBeDefined();
    // 旧扩展名的残留图标被清理，避免配置目录堆积。
    expect(fs.store.has(`${CONFIG_DIRECTORY}/app-icon.ico`)).toBe(false);
  });

  it('相同扩展名重复选择时覆盖安装', async () => {
    const fs = createFs({
      '/home/tester/Downloads/logo.png': bytes('new-icon'),
      [ICON_PATH]: bytes('old-icon'),
    });
    const images = createImages();

    const result = await installPickedIcon({
      pickedPath: '/home/tester/Downloads/logo.png',
      configDirectory: CONFIG_DIRECTORY,
      fs,
      images,
    });

    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(fs.store.get(ICON_PATH))).toBe('new-icon');
  });

  it('不支持的扩展名、读取失败、无法解析和超大文件都被拒绝', async () => {
    const cases = [
      { name: '不支持的扩展名', pickedPath: '/home/tester/Downloads/logo.jpg', files: {} as Record<string, Uint8Array> },
      { name: '读取失败', pickedPath: '/home/tester/Downloads/logo.png', files: {} as Record<string, Uint8Array> },
      { name: '无法解析', pickedPath: '/home/tester/Downloads/logo.png', files: { '/home/tester/Downloads/logo.png': bytes('corrupt') } },
      {
        name: '超大文件',
        pickedPath: '/home/tester/Downloads/logo.png',
        files: { '/home/tester/Downloads/logo.png': new Uint8Array(8 * 1024 * 1024 + 1) },
      },
    ];

    for (const testCase of cases) {
      const fs = createFs(testCase.files);
      const images = createImages();

      const result = await installPickedIcon({
        pickedPath: testCase.pickedPath,
        configDirectory: CONFIG_DIRECTORY,
        fs,
        images,
      });

      expect(result.ok, testCase.name).toBe(false);
      expect(result.message, testCase.name).toBeTruthy();
      expect(fs.writeFile, testCase.name).not.toHaveBeenCalled();
    }
  });
});

describe('removeUnreferencedIconFiles', () => {
  it('清理未被配置引用的 app-icon.*，保留其他文件', async () => {
    const fs = createFs({
      [ICON_PATH]: bytes('current'),
      [`${CONFIG_DIRECTORY}/app-icon.ico`]: bytes('stale'),
      [`${CONFIG_DIRECTORY}/app-icon.icns`]: bytes('stale'),
      [`${CONFIG_DIRECTORY}/config.json`]: bytes('{}'),
    });

    const removed = await removeUnreferencedIconFiles({
      configDirectory: CONFIG_DIRECTORY,
      configuredIcon: 'app-icon.png',
      fs,
    });

    expect(removed.sort()).toEqual(['app-icon.icns', 'app-icon.ico']);
    expect(fs.store.has(ICON_PATH)).toBe(true);
    expect(fs.store.has(`${CONFIG_DIRECTORY}/config.json`)).toBe(true);
  });

  it('未配置自定义图标时清理全部 app-icon.*', async () => {
    const fs = createFs({
      [ICON_PATH]: bytes('stale'),
      [`${CONFIG_DIRECTORY}/app-icon.ico`]: bytes('stale'),
    });

    const removed = await removeUnreferencedIconFiles({ configDirectory: CONFIG_DIRECTORY, configuredIcon: '', fs });

    expect(removed.sort()).toEqual(['app-icon.ico', 'app-icon.png']);
    expect(fs.store.size).toBe(0);
  });

  it('配置目录不可读时不抛出', async () => {
    const fs = createFs();
    fs.readdir.mockRejectedValueOnce(new Error('EACCES'));

    await expect(
      removeUnreferencedIconFiles({ configDirectory: CONFIG_DIRECTORY, configuredIcon: '', fs }),
    ).resolves.toEqual([]);
  });
});

describe('依赖注入形状', () => {
  it('IconFileSystem 与 IconImageFactory 可由调用方提供内存实现', () => {
    const fs = createFs();
    const images = createImages();
    expect(typeof (fs as IconFileSystem).readFile).toBe('function');
    expect(typeof (images as IconImageFactory).fromBuffer).toBe('function');
  });
});

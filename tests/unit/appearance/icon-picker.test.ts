import type { BrowserWindow, OpenDialogReturnValue } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { createIconPickPort, type ShowOpenDialogFn } from '../../../src/main/appearance/icon-picker';
import type { IconFileSystem, IconImageFactory, IconImageLike } from '../../../src/main/appearance/icon-manager';

describe('icon-picker', () => {
  const dummyFs: IconFileSystem = {
    readFile: vi.fn(async () => new Uint8Array()),
    writeFile: vi.fn(async () => {}),
    readdir: vi.fn(async () => []),
    unlink: vi.fn(async () => {}),
    access: vi.fn(async () => {}),
  };

  const dummyImage: IconImageLike = {
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    toPNG: () => Buffer.from([]),
    resize: () => dummyImage,
    toDataURL: () => '',
  };

  const dummyImages: IconImageFactory = {
    fromBuffer: vi.fn(() => dummyImage),
    fromDataURL: vi.fn(() => dummyImage),
  };

  it('未解析配置目录时返回错误', async () => {
    const pickPort = createIconPickPort({
      getConfigWindow: () => null,
      getWriteDirectory: () => undefined,
      fs: dummyFs,
      images: dummyImages,
    });

    const result = await pickPort();
    expect(result).toEqual({ ok: false, message: '配置路径尚未解析，无法选择图标' });
  });

  it('用户取消选择对话框时返回取消状态', async () => {
    const showOpenDialog = vi.fn<ShowOpenDialogFn>(async () => ({
      canceled: true,
      filePaths: [],
    }));

    const pickPort = createIconPickPort({
      getConfigWindow: () => null,
      getWriteDirectory: () => '/config/dir',
      fs: dummyFs,
      images: dummyImages,
      showOpenDialog,
    });

    const result = await pickPort();
    expect(result).toEqual({ ok: false, canceled: true, message: '已取消选择' });
    expect(showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '选择应用图标',
        filters: [{ name: '图标文件', extensions: ['png', 'ico', 'icns'] }],
      }),
    );
  });

  it('用户选择图标时调用 installPickedIcon 安装', async () => {
    const showOpenDialog = vi.fn<ShowOpenDialogFn>(async (): Promise<OpenDialogReturnValue> => ({
      canceled: false,
      filePaths: ['/tmp/logo.png'],
    }));

    const mockFs: IconFileSystem = {
      readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
      writeFile: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
      unlink: vi.fn(async () => {}),
      access: vi.fn(async () => {}),
    };

    const mockImage: IconImageLike = {
      isEmpty: () => false,
      getSize: () => ({ width: 64, height: 64 }),
      toPNG: () => Buffer.from([1, 2]),
      resize: () => ({
        ...mockImage,
        toDataURL: () => 'data:image/png;base64,AQI=',
      }),
      toDataURL: () => 'data:image/png;base64,AQI=',
    };

    const mockImages: IconImageFactory = {
      fromBuffer: vi.fn(() => mockImage),
      fromDataURL: vi.fn(() => mockImage),
    };

    const parentWindow = {} as BrowserWindow;
    const pickPort = createIconPickPort({
      getConfigWindow: () => parentWindow,
      getWriteDirectory: () => '/config/dir',
      fs: mockFs,
      images: mockImages,
      showOpenDialog,
    });

    const result = await pickPort();
    expect(showOpenDialog).toHaveBeenCalledWith(parentWindow, expect.any(Object));
    expect(result.ok).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  electronIconFs,
  electronIconImages,
  resolveApplicationIcon,
} from '../../../src/main/appearance/electron-icon-adapter';
import type { IconImageFactory, IconImageLike } from '../../../src/main/appearance/icon-manager';
import type { Logger } from '../../../src/main/logging/logger';
import type { ResolvedConfigPaths } from '../../../src/main/platform/config-paths';

describe('electron-icon-adapter', () => {
  it('electronIconFs 与 electronIconImages 导出有效能力对象', () => {
    expect(typeof electronIconFs.readFile).toBe('function');
    expect(typeof electronIconFs.writeFile).toBe('function');
    expect(typeof electronIconImages.fromBuffer).toBe('function');
    expect(typeof electronIconImages.fromDataURL).toBe('function');
  });

  it('未配置图标时返回默认图标且不产生告警日志', async () => {
    const logger: Logger = {
      level: 'info',
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };

    const mockImage: IconImageLike = {
      isEmpty: () => false,
      getSize: () => ({ width: 32, height: 32 }),
      toPNG: () => Buffer.from([]),
      resize: () => mockImage,
      toDataURL: () => 'data:image/png;base64,',
    };

    const mockImages: IconImageFactory = {
      fromBuffer: vi.fn(() => mockImage),
      fromDataURL: vi.fn(() => mockImage),
    };

    const paths = {
      writeDirectory: '/tmp/test-config',
    } as ResolvedConfigPaths;

    const icon = await resolveApplicationIcon(paths, null, logger, { images: mockImages });
    expect(icon).toBeDefined();
    expect(icon.source).toBe('default');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('配置图标文件不存在时回退默认图标并记录 icon-fallback 告警', async () => {
    const logger: Logger = {
      level: 'info',
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };

    const mockImage: IconImageLike = {
      isEmpty: () => false,
      getSize: () => ({ width: 32, height: 32 }),
      toPNG: () => Buffer.from([]),
      resize: () => mockImage,
      toDataURL: () => 'data:image/png;base64,',
    };

    const mockImages: IconImageFactory = {
      fromBuffer: vi.fn(() => mockImage),
      fromDataURL: vi.fn(() => mockImage),
    };

    const paths = {
      writeDirectory: '/tmp/test-config',
    } as ResolvedConfigPaths;

    const icon = await resolveApplicationIcon(paths, 'missing.png', logger, { images: mockImages });
    expect(icon.source).toBe('default');
    expect(logger.warn).toHaveBeenCalledWith('icon-fallback', expect.objectContaining({
      reason: expect.stringContaining('图标文件不存在'),
    }));
  });
});

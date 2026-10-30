import type { NativeImage } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  createElectronTrayPort,
  type ElectronMenuItemTemplate,
  type ElectronTrayInstance,
} from '../../../src/main/tray/electron-tray-port';
import type { TrayActions } from '../../../src/main/tray/tray-manager';

describe('electron-tray-port', () => {
  function createMockTray(): ElectronTrayInstance & {
    toolTip: string;
    contextMenu: unknown;
    clickListeners: Array<() => void>;
    destroyed: boolean;
  } {
    return {
      toolTip: '',
      contextMenu: null,
      clickListeners: [],
      destroyed: false,
      setToolTip(tip: string) {
        this.toolTip = tip;
      },
      setContextMenu(menu: unknown) {
        this.contextMenu = menu;
      },
      on(event: 'click', listener: () => void) {
        if (event === 'click') this.clickListeners.push(listener);
      },
      destroy() {
        this.destroyed = true;
      },
    };
  }

  const dummyIcon = {} as NativeImage;

  it('成功创建托盘并设置菜单与点击事件', async () => {
    let builtTemplate: ElectronMenuItemTemplate[] = [];
    const mockTray = createMockTray();

    const mockMenuFactory = {
      buildFromTemplate: vi.fn((template: ElectronMenuItemTemplate[]) => {
        builtTemplate = template;
        return { template };
      }),
    };

    const port = createElectronTrayPort({
      getTrayIcon: () => dummyIcon,
      createTray: () => mockTray,
      menuFactory: mockMenuFactory,
    });

    const actions: TrayActions = {
      openConfig: vi.fn(),
      reload: vi.fn(),
      showWindow: vi.fn(),
      quit: vi.fn(),
    };

    const result = port.create(actions);
    expect(result).toEqual({ ok: true });
    expect(mockTray.toolTip).toBe('UniShell');
    expect(mockTray.contextMenu).toEqual({ template: builtTemplate });

    // 检查 4 个固定菜单项与分隔线
    expect(builtTemplate).toHaveLength(5);
    expect(builtTemplate[0].label).toBe('打开配置界面');
    expect(builtTemplate[1].label).toBe('重新加载网页');
    expect(builtTemplate[2].label).toBe('立即显示窗口');
    expect(builtTemplate[3].type).toBe('separator');
    expect(builtTemplate[4].label).toBe('退出程序');

    // 触发菜单动作
    builtTemplate[0].click?.();
    expect(actions.openConfig).toHaveBeenCalled();

    builtTemplate[1].click?.();
    expect(actions.reload).toHaveBeenCalled();

    builtTemplate[2].click?.();
    expect(actions.showWindow).toHaveBeenCalled();

    builtTemplate[4].click?.();
    expect(actions.quit).toHaveBeenCalled();

    // 托盘单击事件表现为「立即显示窗口」
    expect(mockTray.clickListeners).toHaveLength(1);
    mockTray.clickListeners[0]();
    expect(actions.showWindow).toHaveBeenCalledTimes(2);

    // 销毁托盘
    port.destroy();
    expect(mockTray.destroyed).toBe(true);
  });

  it('支持自定义 onQuit 回调', () => {
    let builtTemplate: ElectronMenuItemTemplate[] = [];
    const mockTray = createMockTray();
    const customQuit = vi.fn();

    const port = createElectronTrayPort({
      getTrayIcon: () => dummyIcon,
      createTray: () => mockTray,
      menuFactory: {
        buildFromTemplate: (template) => {
          builtTemplate = template;
          return template;
        },
      },
      onQuit: customQuit,
    });

    const actions: TrayActions = {
      openConfig: vi.fn(),
      reload: vi.fn(),
      showWindow: vi.fn(),
      quit: vi.fn(),
    };

    port.create(actions);
    builtTemplate[4].click?.();
    expect(customQuit).toHaveBeenCalled();
    expect(actions.quit).not.toHaveBeenCalled();
  });

  it('托盘构造异常时捕获并返回降级原因', () => {
    const port = createElectronTrayPort({
      getTrayIcon: () => dummyIcon,
      createTray: () => {
        throw new Error('Tray not supported');
      },
      menuFactory: { buildFromTemplate: vi.fn() },
    });

    const actions: TrayActions = {
      openConfig: vi.fn(),
      reload: vi.fn(),
      showWindow: vi.fn(),
      quit: vi.fn(),
    };

    const result = port.create(actions);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('托盘创建失败：Tray not supported');
  });
});

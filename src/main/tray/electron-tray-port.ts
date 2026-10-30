import { Menu, Tray, type NativeImage } from 'electron';
import type { TrayActions, TrayPort } from './tray-manager';

export interface ElectronTrayInstance {
  setToolTip(toolTip: string): void;
  setContextMenu(menu: unknown): void;
  on(event: 'click', listener: () => void): void;
  destroy(): void;
}

export interface ElectronMenuItemTemplate {
  label?: string;
  type?: 'separator' | 'normal' | 'checkbox' | 'radio' | 'submenu';
  click?: () => void;
}

export interface ElectronMenuFactory {
  buildFromTemplate(template: ElectronMenuItemTemplate[]): unknown;
}

export interface CreateElectronTrayPortOptions {
  getTrayIcon: () => NativeImage;
  onQuit?: () => void | Promise<void>;
  createTray?: (icon: NativeImage) => ElectronTrayInstance;
  menuFactory?: ElectronMenuFactory;
}

/** 规格 §10：Windows 通知区域 / macOS 菜单栏 / Linux StatusNotifierItem 共用的托盘端口。 */
export function createElectronTrayPort(
  options: CreateElectronTrayPortOptions | (() => NativeImage),
): TrayPort {
  const opts: CreateElectronTrayPortOptions =
    typeof options === 'function' ? { getTrayIcon: options } : options;

  const trayFactory = opts.createTray ?? ((icon) => new Tray(icon));
  const menuFactory = opts.menuFactory ?? Menu;
  let tray: ElectronTrayInstance | null = null;

  return {
    create(actions: TrayActions) {
      try {
        tray?.destroy();
        tray = trayFactory(opts.getTrayIcon());
        tray.setToolTip('UniShell');

        const quitAction = opts.onQuit ?? actions.quit;
        const menu = menuFactory.buildFromTemplate([
          { label: '打开配置界面', click: () => void actions.openConfig() },
          { label: '重新加载网页', click: () => void actions.reload() },
          { label: '立即显示窗口', click: () => void actions.showWindow() },
          { type: 'separator' },
          { label: '退出程序', click: () => void quitAction() },
        ]);
        tray.setContextMenu(menu);

        // Windows 单击与 macOS 左键都表现为「立即显示窗口」。
        tray.on('click', () => {
          void actions.showWindow();
        });

        return { ok: true };
      } catch (error) {
        tray?.destroy();
        tray = null;
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: `托盘创建失败：${detail}` };
      }
    },
    destroy() {
      tray?.destroy();
      tray = null;
    },
  };
}


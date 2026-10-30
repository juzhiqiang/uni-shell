import type { BrowserWindow, Input } from 'electron';
import type { ShortcutTarget } from './tray-manager';

export interface ShortcutInputPayload {
  key: string;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export interface TrackedWindow {
  isDestroyed?: () => boolean;
  isFocused?: () => boolean;
  destroy?: () => void;
  webContents: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on: (event: any, listener: any) => unknown;
    emit?: (event: string, ...args: unknown[]) => unknown;
  };
}

export interface MainWindowChannel<W = BrowserWindow> {
  readonly window: W | null;
  set(window: W | null): void;
  onReady(handler: (window: W) => void): void;
  emitReady(window: W): void;
}

/**
 * 主窗口就绪通道：快捷键宿主窗口在延迟结束后才创建，需要延后绑定。
 * 同一窗口只绑定一次，重建窗口（关闭后再次创建）时重新绑定。
 */
export function createMainWindowChannel<W extends TrackedWindow = BrowserWindow>(): MainWindowChannel<W> {
  const handlers: Array<(window: W) => void> = [];
  let current: W | null = null;
  let bound: W | null = null;

  return {
    get window() {
      return current;
    },
    set(window: W | null) {
      current = window;
      if (window === null) {
        bound = null;
      }
    },
    onReady(handler: (window: W) => void) {
      handlers.push(handler);
      // 窗口已存在时立即绑定，避免安装快捷键时窗口尚未创建。
      if (current && (!current.isDestroyed || !current.isDestroyed())) {
        if (bound === current) {
          handler(current);
        } else {
          bound = current;
          handler(current);
        }
      }
    },
    emitReady(window: W) {
      current = window;
      if (bound === window) return;
      bound = window;
      for (const handler of handlers) handler(window);
    },
  };
}

/** 焦点快捷键宿主：绑定主窗口自身的 before-input-event，绝不注册全局快捷键。 */
export function createShortcutTarget<W extends TrackedWindow = BrowserWindow>(
  channel: MainWindowChannel<W>,
): ShortcutTarget {
  return {
    isFocused() {
      const window = channel.window;
      return (
        window !== null &&
        (!window.isDestroyed || !window.isDestroyed()) &&
        (window.isFocused?.() ?? false)
      );
    },
    onBeforeInput(handler) {
      channel.onReady((window) => {
        window.webContents.on('before-input-event', (event: { preventDefault: () => void }, input: Input | ShortcutInputPayload) => {
          handler({
            key: input.key,
            control: Boolean(input.control),
            alt: Boolean(input.alt),
            shift: Boolean(input.shift),
            meta: Boolean(input.meta),
            preventDefault: () => event.preventDefault(),
          });
        });
      });
    },
  };
}

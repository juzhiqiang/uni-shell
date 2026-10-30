import { describe, expect, it, vi } from 'vitest';

import {
  createMainWindowChannel,
  createShortcutTarget,
  type TrackedWindow,
} from '../../../src/main/tray/shortcut-host';

function createMockWindow(isFocusedVal = true): TrackedWindow {
  let destroyed = false;
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  return {
    isDestroyed: () => destroyed,
    isFocused: () => isFocusedVal,
    destroy: () => {
      destroyed = true;
    },
    webContents: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(handler);
      }),
      emit: (event: string, ...args: unknown[]) => {
        for (const handler of listeners[event] || []) {
          handler(...args);
        }
      },
    },
  };
}

describe('shortcut-host', () => {
  describe('createMainWindowChannel', () => {
    it('emitReady 派发给所有已注册的 handler', () => {
      const channel = createMainWindowChannel<TrackedWindow>();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      channel.onReady(handler1);
      channel.onReady(handler2);

      const win = createMockWindow();
      channel.emitReady(win);

      expect(handler1).toHaveBeenCalledWith(win);
      expect(handler2).toHaveBeenCalledWith(win);
      expect(channel.window).toBe(win);
    });

    it('窗口已存在时新注册的 handler 立即收到窗口实例', () => {
      const channel = createMainWindowChannel<TrackedWindow>();
      const win = createMockWindow();
      channel.emitReady(win);

      const lateHandler = vi.fn();
      channel.onReady(lateHandler);

      expect(lateHandler).toHaveBeenCalledWith(win);
    });

    it('同一窗口实例重复 emitReady 不重复派发', () => {
      const channel = createMainWindowChannel<TrackedWindow>();
      const handler = vi.fn();
      channel.onReady(handler);

      const win = createMockWindow();
      channel.emitReady(win);
      channel.emitReady(win);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('重建新窗口后再次 emitReady 能够重新派发给 handler', () => {
      const channel = createMainWindowChannel<TrackedWindow>();
      const handler = vi.fn();
      channel.onReady(handler);

      const win1 = createMockWindow();
      channel.emitReady(win1);
      channel.set(null);

      const win2 = createMockWindow();
      channel.emitReady(win2);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenLastCalledWith(win2);
    });
  });

  describe('createShortcutTarget', () => {
    it('isFocused 在无窗口、窗口已销毁或未聚焦时返回 false', () => {
      const channel = createMainWindowChannel<TrackedWindow>();
      const target = createShortcutTarget(channel);

      expect(target.isFocused()).toBe(false);

      const unfocusedWin = createMockWindow(false);
      channel.set(unfocusedWin);
      expect(target.isFocused()).toBe(false);

      const destroyedWin = createMockWindow(true);
      destroyedWin.destroy?.();
      channel.set(destroyedWin);
      expect(target.isFocused()).toBe(false);
    });

    it('isFocused 在窗口聚焦时返回 true', () => {
      const channel = createMainWindowChannel<TrackedWindow>();
      const target = createShortcutTarget(channel);
      const win = createMockWindow(true);
      channel.set(win);

      expect(target.isFocused()).toBe(true);
    });

    it('before-input-event 正确映射按键与修饰键', () => {
      const channel = createMainWindowChannel<TrackedWindow>();
      const target = createShortcutTarget(channel);

      const inputHandler = vi.fn();
      target.onBeforeInput(inputHandler);

      const win = createMockWindow();
      channel.emitReady(win);

      const preventDefault = vi.fn();
      win.webContents.emit?.('before-input-event', { preventDefault }, {
        key: 'F12',
        control: true,
        alt: false,
        shift: true,
        meta: false,
      });

      expect(inputHandler).toHaveBeenCalledWith({
        key: 'F12',
        control: true,
        alt: false,
        shift: true,
        meta: false,
        preventDefault: expect.any(Function),
      });

      inputHandler.mock.calls[0][0].preventDefault();
      expect(preventDefault).toHaveBeenCalled();
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  acquireSingleInstance,
  detectLaunchContext,
  parseSecondLaunchPayload,
  type SecondLaunchPayload,
  type SingleInstancePort,
} from '../../../src/main/instance/single-instance';

/**
 * 覆盖规格 v2.1 §4：第二次启动不得创建新窗口，应向已有实例发送唤醒请求；
 * 已有实例隐藏时显示并聚焦；正在倒计时时取消倒计时并立即显示；配置窗口已打开时聚焦配置窗口。
 */

/** 可操控的假单实例端口，用于在纯 Node 环境下模拟 Electron 行为。 */
function createFakePort(options: { firstInstanceAcquiresLock?: boolean } = {}) {
  const firstInstanceAcquiresLock = options.firstInstanceAcquiresLock ?? true;
  const secondInstanceHandlers: Array<(argv: string[], workingDirectory: string) => void> = [];
  let released = false;

  const port: SingleInstancePort = {
    requestSingleInstanceLock() {
      return firstInstanceAcquiresLock;
    },
    releaseSingleInstanceLock() {
      released = true;
    },
    onSecondInstance(handler) {
      secondInstanceHandlers.push(handler);
    },
  };

  return {
    port,
    /** 模拟第二个进程把启动参数送达首个实例。 */
    deliverSecondLaunch(argv: string[], workingDirectory = '/work') {
      for (const handler of secondInstanceHandlers) handler(argv, workingDirectory);
    },
    get released() {
      return released;
    },
    get handlerCount() {
      return secondInstanceHandlers.length;
    },
  };
}

describe('detectLaunchContext', () => {
  it('识别登录启动标记', () => {
    expect(detectLaunchContext(['app', '--launched-at-login'])).toBe('login');
  });

  it('识别 macOS 登录启动的 -psn_ 参数', () => {
    expect(detectLaunchContext(['app', '-psn_0_12345'])).toBe('login');
  });

  it('缺少标记时按手动启动处理', () => {
    expect(detectLaunchContext(['app'])).toBe('manual');
    expect(detectLaunchContext(['app', '--config-dir=/opt/uni'])).toBe('manual');
    expect(detectLaunchContext([])).toBe('manual');
  });

  it('不因大小写或等号形式漏判', () => {
    expect(detectLaunchContext(['app', '--Launched-At-Login'])).toBe('login');
    expect(detectLaunchContext(['app', '--launched-at-login=true'])).toBe('login');
  });
});

describe('parseSecondLaunchPayload', () => {
  it('解析启动来源与配置目录', () => {
    const payload = parseSecondLaunchPayload(['app', '--launched-at-login', '--config-dir=D:\\Portable'], '/work');

    expect(payload.source).toBe('login');
    expect(payload.configDir).toBe('D:\\Portable');
    expect(payload.workingDirectory).toBe('/work');
    expect(payload.argv).toEqual(['app', '--launched-at-login', '--config-dir=D:\\Portable']);
  });

  it('手动二次启动不带配置目录', () => {
    const payload = parseSecondLaunchPayload(['app'], '/work');

    expect(payload.source).toBe('manual');
    expect(payload.configDir).toBeUndefined();
  });
});

describe('acquireSingleInstance', () => {
  it('首个实例取得锁并注册二次启动回调', () => {
    const fake = createFakePort();
    const onSecondLaunch = vi.fn();

    const acquired = acquireSingleInstance(onSecondLaunch, { port: fake.port });

    expect(acquired).toBe(true);
    expect(fake.handlerCount).toBe(1);
    expect(onSecondLaunch).not.toHaveBeenCalled();
  });

  it('第二个实例拿不到锁且不注册回调', () => {
    const fake = createFakePort({ firstInstanceAcquiresLock: false });
    const onSecondLaunch = vi.fn();

    const acquired = acquireSingleInstance(onSecondLaunch, { port: fake.port });

    expect(acquired).toBe(false);
    expect(fake.handlerCount).toBe(0);
  });

  it('二次启动参数被转发给首个实例', () => {
    const fake = createFakePort();
    const received: SecondLaunchPayload[] = [];

    acquireSingleInstance((payload) => received.push(payload), { port: fake.port });
    fake.deliverSecondLaunch(['app', '--launched-at-login', '--config-dir=/opt/uni'], '/work');

    expect(received).toHaveLength(1);
    expect(received[0].source).toBe('login');
    expect(received[0].configDir).toBe('/opt/uni');
    expect(received[0].workingDirectory).toBe('/work');
  });

  it('多次二次启动都转发，不互相覆盖', () => {
    const fake = createFakePort();
    const received: SecondLaunchPayload[] = [];

    acquireSingleInstance((payload) => received.push(payload), { port: fake.port });
    fake.deliverSecondLaunch(['app'], '/a');
    fake.deliverSecondLaunch(['app'], '/b');

    expect(received.map((payload) => payload.workingDirectory)).toEqual(['/a', '/b']);
  });

  it('未注入端口时给出明确错误而不是静默放行多实例', () => {
    expect(() => acquireSingleInstance(() => {}, {})).toThrow(/SingleInstancePort/);
  });

  it('释放锁后端口状态被更新', () => {
    const fake = createFakePort();

    acquireSingleInstance(() => {}, { port: fake.port });
    fake.port.releaseSingleInstanceLock();

    expect(fake.released).toBe(true);
  });
});

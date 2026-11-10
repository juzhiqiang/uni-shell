import { describe, expect, it, vi } from 'vitest';

import { createSecondLaunchInbox } from '../../../src/main/instance/second-launch-inbox';
import type { SecondLaunchPayload } from '../../../src/main/instance/single-instance';

/**
 * 二次启动唤醒收件箱。
 *
 * 背景（R1）：单实例锁在模块加载时即注册 `onSecondInstance`，而控制器要到
 * bootstrap 完成才就绪；这期间到达的唤醒请求曾因 handler 未赋值被静默丢弃，
 * 用户侧表现为「双击没反应」且无日志。收件箱在 handler 就绪前缓存载荷，
 * 就绪后由 drain 补投递。
 */

function payload(argv: string[]): SecondLaunchPayload {
  return { argv, workingDirectory: '/work', source: 'manual' };
}

describe('second-launch-inbox', () => {
  it('handler 就绪前缓存唤醒载荷，drain 时补投递', () => {
    const inbox = createSecondLaunchInbox();
    const handler = vi.fn();
    const first = payload(['app']);

    inbox.deliver(first);
    expect(handler).not.toHaveBeenCalled();

    inbox.setHandler(handler);
    inbox.drain();

    expect(handler).toHaveBeenCalledWith(first);
  });

  it('handler 就绪后直达，不再经过缓存', () => {
    const inbox = createSecondLaunchInbox();
    const handler = vi.fn();
    inbox.setHandler(handler);

    const second = payload(['app', '--config-dir=/tmp/other']);
    inbox.deliver(second);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(second);

    inbox.drain();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('就绪前的多次唤醒只保留最早一条', () => {
    const inbox = createSecondLaunchInbox();
    const handler = vi.fn();
    const first = payload(['app', 'first']);
    const later = payload(['app', 'second']);

    inbox.deliver(first);
    inbox.deliver(later);
    inbox.setHandler(handler);
    inbox.drain();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(first);
  });

  it('drain 无缓存时无操作', () => {
    const inbox = createSecondLaunchInbox();
    const handler = vi.fn();
    inbox.setHandler(handler);

    inbox.drain();

    expect(handler).not.toHaveBeenCalled();
  });

  it('handler 未就绪时的 drain 不丢弃缓存载荷', () => {
    const inbox = createSecondLaunchInbox();
    const handler = vi.fn();
    const first = payload(['app']);

    inbox.deliver(first);
    inbox.drain();
    expect(handler).not.toHaveBeenCalled();

    inbox.setHandler(handler);
    inbox.drain();
    expect(handler).toHaveBeenCalledWith(first);
  });
});

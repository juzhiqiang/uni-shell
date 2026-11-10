/**
 * 二次启动唤醒收件箱。
 *
 * 背景（R1）：单实例锁在模块加载时就注册了 `onSecondInstance`，而控制器要到
 * bootstrap 完成才就绪。这期间到达的唤醒请求曾因 `secondLaunchHandler` 还是
 * undefined 被 `?.` 静默丢弃——用户侧表现为「双击没反应」，且连 second-launch
 * 日志都不会留下。收件箱在 handler 就绪前缓存载荷（仅保留最早一条：唤醒的
 * 语义是「显示已有实例」，重复唤醒冗余），就绪后由 `drain` 补投递。
 *
 * 纯逻辑模块：不导入 Electron，可在无 Electron 环境完整测试。
 */

import type { SecondLaunchPayload } from './single-instance';

export interface SecondLaunchInbox {
  /** 单实例事件入口：handler 就绪即转交，否则缓存（仅保留最早一条）。 */
  deliver(payload: SecondLaunchPayload): void;
  /** 设置唤醒处理器；重复设置以最后一次为准。 */
  setHandler(handler: (payload: SecondLaunchPayload) => void): void;
  /** 投递缓存载荷（若有）并清空；handler 未就绪时保持缓存不丢弃。 */
  drain(): void;
}

export function createSecondLaunchInbox(): SecondLaunchInbox {
  let handler: ((payload: SecondLaunchPayload) => void) | undefined;
  let pending: SecondLaunchPayload | undefined;

  return {
    deliver(payload) {
      if (handler !== undefined) {
        handler(payload);
        return;
      }
      pending ??= payload;
    },
    setHandler(next) {
      handler = next;
    },
    drain() {
      if (handler === undefined) return;
      const payload = pending;
      pending = undefined;
      if (payload !== undefined) {
        handler(payload);
      }
    },
  };
}

/**
 * 单实例锁与二次启动唤醒。
 *
 * 规则来源：规格 v2.1 §4（总体运行流程）——第二次启动不得创建新窗口，
 * 应向已有实例发送唤醒请求。
 *
 * Electron API 通过 `SingleInstancePort` 注入（`rules/testing-release.md`：
 * Electron API 使用依赖注入或 adapter mock），因此本模块是纯 TypeScript，
 * 可在无 Electron 的环境下完整测试。真实端口由 `src/main.ts` 构造后注入。
 */

/** 登录启动标记。自启注册时由各平台自启实现写入该参数（Task 7 负责注册）。 */
export const LOGIN_LAUNCH_FLAG = '--launched-at-login';

export type LaunchSource = 'manual' | 'login';

export interface SecondLaunchPayload {
  argv: string[];
  workingDirectory: string;
  source: LaunchSource;
  /** 二次启动显式指定的配置目录，若未指定则为 undefined。 */
  configDir?: string;
}

/** Electron `app` 的单实例相关能力，按需裁剪以避免直接依赖 Electron 类型。 */
export interface SingleInstancePort {
  requestSingleInstanceLock(): boolean;
  releaseSingleInstanceLock(): void;
  onSecondInstance(handler: (argv: string[], workingDirectory: string) => void): void;
}

export interface AcquireSingleInstanceOptions {
  /** 必须注入；未注入时抛错，避免静默失去多实例保护。 */
  port?: SingleInstancePort;
}

/**
 * 识别启动来源。
 *
 * 约定：登录启动时 argv 带有 `--launched-at-login`（自启注册时写入），
 * 或 macOS 通过 LaunchServices 登录启动时附带的 `-psn_*` 参数。
 * 无法判定时按手动启动处理——手动启动不延迟，是更安全的默认。
 */
export function detectLaunchContext(argv: readonly string[]): LaunchSource {
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    if (arg.toLowerCase() === LOGIN_LAUNCH_FLAG || arg.toLowerCase().startsWith(`${LOGIN_LAUNCH_FLAG}=`)) {
      return 'login';
    }
    // macOS Process Serial Number，登录启动时由系统附加。
    if (/^-psn_/i.test(arg)) return 'login';
  }
  return 'manual';
}

/** 从 argv 中提取 `--config-dir`，复用配置路径模块的解析规则。 */
function extractConfigDir(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== 'string') continue;

    if (arg === '--config-dir') {
      const next = argv[index + 1];
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) return next;
      continue;
    }

    const prefix = '--config-dir=';
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

/** 把二次启动的原始参数解析成结构化载荷。 */
export function parseSecondLaunchPayload(
  argv: readonly string[],
  workingDirectory: string,
): SecondLaunchPayload {
  const configDir = extractConfigDir(argv);
  return {
    argv: [...argv],
    workingDirectory,
    source: detectLaunchContext(argv),
    ...(configDir ? { configDir } : {}),
  };
}

/**
 * 尝试取得单实例锁。
 *
 * 返回 true 表示当前是首个实例，已注册二次启动回调；
 * 返回 false 表示已有实例在运行，调用方应尽快退出（Electron 会自动把参数送给首个实例）。
 */
export function acquireSingleInstance(
  onSecondLaunch: (payload: SecondLaunchPayload) => void,
  options: AcquireSingleInstanceOptions = {},
): boolean {
  const port = options.port;
  if (!port) {
    throw new Error(
      'acquireSingleInstance 需要注入 SingleInstancePort；缺少端口时将无法保证单实例，已中止启动',
    );
  }

  const acquired = port.requestSingleInstanceLock();
  if (!acquired) return false;

  port.onSecondInstance((argv, workingDirectory) => {
    onSecondLaunch(parseSecondLaunchPayload(argv, workingDirectory));
  });

  return true;
}

import { join } from 'node:path';
import {
  app,
  dialog,
  ipcMain,
  net,
  screen,
  shell,
} from 'electron';

import { AppController } from './main/app-controller';
import { removeUnreferencedIconFiles } from './main/appearance/icon-manager';
import {
  electronIconFs,
  electronIconImages,
  resolveApplicationIcon,
} from './main/appearance/electron-icon-adapter';
import { createIconPickPort } from './main/appearance/icon-picker';
import { registerConfigIpc, testTargetConnection } from './main/config/config-ipc';
import { createConfigService } from './main/config/config-service';
import { createLogger, resolveLogDirectory } from './main/logging/logger';
import { readRecentLogs } from './main/logging/log-reader';
import {
  detectMacPortableExecutablePath,
  resolveConfigPaths,
  type NodePlatform,
} from './main/platform/config-paths';
import { detectPlatformCapabilities } from './main/platform/capability-detector';
import {
  createElectronCertificatePolicyPort,
  createElectronPowerMonitorPort,
  createElectronProxyPort,
  createElectronSingleInstancePort,
} from './main/platform/electron-ports';
import {
  acquireSingleInstance,
} from './main/instance/single-instance';
import { createSecondLaunchInbox } from './main/instance/second-launch-inbox';
import { createElectronLoginItemPort } from './main/startup/electron-login-item';
import { createElectronTrayPort } from './main/tray/electron-tray-port';
import { createMainWindowChannel, createShortcutTarget } from './main/tray/shortcut-host';
import { WindowManager } from './main/window/window-manager';
import {
  attachMainWindowDiagnostics,
  loadConfigWindow,
} from './main/window/page-loader';
import {
  createBrowserWindowFactory,
  createWindowPortAdapter,
} from './main/window/window-port';

/**
 * Windows 任务栏归属标识（AppUserModelID）。
 * 必须与 electron-builder 三个平台配置的 appId 保持一致。
 */
const APP_USER_MODEL_ID = 'com.unishell.desktop';

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// 二次启动唤醒收件箱：单实例锁在模块加载时即注册回调，而控制器要到 bootstrap
// 完成才就绪；这期间的唤醒请求先入收件箱，handler 就绪后补投递，不静默丢弃。
const secondLaunchInbox = createSecondLaunchInbox();

const isFirstInstance = acquireSingleInstance(
  (payload) => secondLaunchInbox.deliver(payload),
  { port: createElectronSingleInstancePort() },
);

if (!isFirstInstance) {
  app.quit();
} else {
  void bootstrap();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

async function bootstrap(): Promise<void> {
  await app.whenReady();
  const readyAt = performance.now();

  const capabilities = await detectPlatformCapabilities({
    displays: { count: screen.getAllDisplays().length },
  });

  const paths = resolveConfigPaths({
    platform: process.platform as NodePlatform,
    argv: process.argv,
    env: process.env as Record<string, string | undefined>,
    executablePath: process.execPath,
    macAppBundlePath: detectMacPortableExecutablePath({
      platform: process.platform as NodePlatform,
      executablePath: app.getPath('exe'),
    }),
  });

  const configService = createConfigService({ paths });
  const initialLoad = await configService.load();
  const initialConfig = initialLoad.config;

  const logDirectory = resolveLogDirectory({
    platform: process.platform as NodePlatform,
    env: process.env as Record<string, string | undefined>,
  });

  const logger = createLogger({
    platform: process.platform as NodePlatform,
    env: process.env as Record<string, string | undefined>,
    directory: logDirectory,
    level: initialConfig?.logging.level,
    retentionDays: initialConfig?.logging.retentionDays,
    context: {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '',
      arch: process.arch,
      desktopEnvironment: capabilities.desktopEnvironment,
      sessionType: capabilities.sessionType,
    },
    onError: (error, event) => {
      console.error(`[uni-shell] 日志写入失败（${event}）`, error);
    },
  });

  const reportStartupTiming = (stage: 'ready' | 'configLoaded' | 'proxyApplied' | 'windowCreated' | 'firstLoad') => {
    logger.info('startup-timing', {
      stage,
      elapsedMs: stage === 'ready' ? 0 : Math.round(performance.now() - readyAt),
    });
  };
  reportStartupTiming('ready');

  const appIcon = await resolveApplicationIcon(paths, initialConfig?.appearance.icon, logger);
  const windowIcon = appIcon.image as unknown as Electron.NativeImage;
  const trayIcon = appIcon.trayImage as unknown as Electron.NativeImage;

  const effectiveAppId =
    appIcon.source === 'configured'
      ? `${APP_USER_MODEL_ID}.custom.${appIcon.fileName ?? 'icon'}`
      : APP_USER_MODEL_ID;

  if (process.platform === 'win32') {
    app.setAppUserModelId(effectiveAppId);
  }

  if (app.dock && !appIcon.image.isEmpty()) {
    app.dock.setIcon(windowIcon);
  }

  let iconCleanupScheduled = false;
  let firstLoadRecorded = false;
  const mainWindowChannel = createMainWindowChannel();

  const reportFirstLoad = () => {
    if (firstLoadRecorded) return;
    firstLoadRecorded = true;
    reportStartupTiming('firstLoad');
  };

  const quitApplication = async (): Promise<void> => {
    try {
      await controller.shutdown();
    } finally {
      app.exit();
    }
  };

  const windowManager = new WindowManager({
    createWindow: createBrowserWindowFactory(
      () => windowIcon,
      () => ({ appId: effectiveAppId, appIconPath: appIcon.windowsIcoPath }),
    ),
    capabilities,
    screen,
    preloadPath: join(app.getAppPath(), 'dist/preload/index.cjs'),
    loadConfigWindow: (window) =>
      loadConfigWindow(window, { configPath: paths.writePath ?? paths.configPath }),
    openExternal: (url) => shell.openExternal(url),
    quitApp: () => {
      void quitApplication();
    },
    onEvent: (event) => {
      controller.reportWindowEvent(event);
      if (event.type === 'main-window-created') {
        reportStartupTiming('windowCreated');
        if (!iconCleanupScheduled) {
          iconCleanupScheduled = true;
          setImmediate(() => {
            void removeUnreferencedIconFiles({
              configDirectory: paths.writeDirectory,
              configuredIcon: appIcon.fileName ?? '',
              fs: electronIconFs,
            }).then((removed) => {
              if (removed.length > 0) logger.info('icon-files-cleaned', { removed });
            }).catch((error: unknown) => {
              logger.warn('icon-cleanup-failed', { message: error instanceof Error ? error.message : String(error) });
            });
          });
        }
        const main = windowManager.getMainWindow();
        if (main !== null) {
          mainWindowChannel.emitReady(main);
          main.on('closed', () => mainWindowChannel.set(null));
          attachMainWindowDiagnostics(main, controller, reportFirstLoad);
        }
      }
    },
  });

  const windowPort = createWindowPortAdapter({ windowManager, configService, capabilities });

  let wasOnline = net.isOnline();
  // R11：只认 false→true 上升沿——掉线不产生事件，由页面的 did-fail-load
  // 驱动重试；恢复在线才唤醒可能处于退避等待的重试。非 running 或没有重试
  // 周期时 reportNetworkOnline 是 no-op（控制器内部门控）。
  const onlinePollTimer = setInterval(() => {
    const online = net.isOnline();
    if (!wasOnline && online) {
      controller.reportNetworkOnline();
    }
    wasOnline = online;
  }, 2_000);
  onlinePollTimer.unref();
  app.once('will-quit', () => clearInterval(onlinePollTimer));

  const controller: AppController = new AppController({
    configService,
    capabilities,
    window: windowPort,
    tray: createElectronTrayPort({
      getTrayIcon: () => trayIcon,
      onQuit: () => {
        void quitApplication();
      },
    }),
    loginItem: createElectronLoginItemPort(),
    shortcutTarget: createShortcutTarget(mainWindowChannel),
    proxy: createElectronProxyPort(),
    // 规格 v2.1.7 §7、§12：仅远程会话生效；放行记录只含主机名与校验结果，
    // 由 logger 统一脱敏（不含完整网址与查询参数）。
    certificatePolicy: createElectronCertificatePolicyPort({
      onBypass: (record) => {
        logger.warn('certificate-error-accepted', record);
      },
    }),
    confirmProxyFailure: async (mode) => {
      const result = await dialog.showMessageBox({
        type: 'warning',
        title: '代理应用失败',
        message: `无法应用当前代理策略（${mode}）。`,
        detail: '继续启动将创建远程业务窗口，但接口请求可能无法按预期使用代理。',
        buttons: ['仍然继续', '打开配置界面'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      return result.response === 0;
    },
    powerMonitor: createElectronPowerMonitorPort(),
    startupTiming: reportStartupTiming,
    log: logger,
  });

  secondLaunchInbox.setHandler((payload) => {
    void controller.handleSecondLaunch(payload);
  });
  // bootstrap 期间到达的唤醒请求在此补投递（R1：不得静默丢弃）。
  secondLaunchInbox.drain();

  registerConfigIpc({
    host: ipcMain,
    service: configService,
    logger,
    onSaved: async (config, previous) => {
      if (previous !== undefined && config.startup.openAtLogin !== previous.startup.openAtLogin) {
        await controller.applyOpenAtLogin(config.startup.openAtLogin);
      }
    },
    closeStaleWindows: () => {
      windowPort.closeStaleWindows();
    },
    restart: () => {
      void (async () => {
        try {
          await controller.shutdown();
        } finally {
          app.relaunch();
          app.exit();
        }
      })();
    },
    reload: (config) => controller.applySavedConfig(config, true),
    applyHot: (config) => controller.applySavedConfig(config, false),
    testConnection: (url, network) => testTargetConnection(url, network),
    getLogs: (options) => readRecentLogs({ directory: logDirectory, ...options }),
    openLogDirectory: async () => {
      try {
        const error = await shell.openPath(logDirectory);
        return error === '';
      } catch {
        return false;
      }
    },
    pickIcon: createIconPickPort({
      getConfigWindow: () => windowManager.getConfigWindow(),
      getWriteDirectory: () => paths.writeDirectory,
      fs: electronIconFs,
      images: electronIconImages,
    }),
  });

  await controller.start({
    argv: process.argv,
    workingDirectory: process.cwd(),
    env: process.env as Record<string, string | undefined>,
  });

  app.on('before-quit', () => {
    windowManager.beginShutdown();
    void controller.shutdown();
  });

  app.on('child-process-gone', (_event, details) => {
    const payload = {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
    };
    if (details.reason === 'clean-exit') {
      logger.info('child-process-gone', payload);
    } else {
      logger.warn('child-process-gone', payload);
    }
  });
}

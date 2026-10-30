import { dialog, type BrowserWindow } from 'electron';
import type { IconPickResult } from '../../shared/ipc-contract';
import {
  installPickedIcon,
  type IconFileSystem,
  type IconImageFactory,
} from './icon-manager';

export type ShowOpenDialogFn = {
  (browserWindow: BrowserWindow, options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue>;
  (options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue>;
};

export interface CreateIconPickPortOptions {
  getConfigWindow: () => BrowserWindow | null;
  getWriteDirectory: () => string | undefined;
  fs: IconFileSystem;
  images: IconImageFactory;
  showOpenDialog?: ShowOpenDialogFn;
}

const defaultShowOpenDialog: ShowOpenDialogFn = ((
  targetOrOpts: BrowserWindow | Electron.OpenDialogOptions,
  maybeOpts?: Electron.OpenDialogOptions,
) => {
  if (typeof dialog?.showOpenDialog === 'function') {
    if (maybeOpts !== undefined) {
      return dialog.showOpenDialog(targetOrOpts as BrowserWindow, maybeOpts);
    }
    return dialog.showOpenDialog(targetOrOpts as Electron.OpenDialogOptions);
  }
  return Promise.resolve({ canceled: true, filePaths: [] });
}) as ShowOpenDialogFn;

/**
 * 规格 §5.4：图标选择出口（配置界面「选择图标」按钮）。
 * 打开文件对话框 → 校验并复制到配置目录 → 回传文件名与预览；
 * 只回传结果，不向渲染进程暴露任意文件路径读写能力。
 */
export function createIconPickPort(
  options: CreateIconPickPortOptions,
): () => Promise<IconPickResult> {
  const {
    getConfigWindow,
    getWriteDirectory,
    fs,
    images,
    showOpenDialog = defaultShowOpenDialog,
  } = options;

  return async (): Promise<IconPickResult> => {
    const writeDirectory = getWriteDirectory();
    if (writeDirectory === undefined) {
      return { ok: false, message: '配置路径尚未解析，无法选择图标' };
    }

    const dialogOptions: Electron.OpenDialogOptions = {
      title: '选择应用图标',
      properties: ['openFile'],
      filters: [{ name: '图标文件', extensions: ['png', 'ico', 'icns'] }],
    };
    const parent = getConfigWindow();
    const selection =
      parent !== null
        ? await showOpenDialog(parent, dialogOptions)
        : await showOpenDialog(dialogOptions);

    if (selection.canceled || selection.filePaths.length === 0) {
      return { ok: false, canceled: true, message: '已取消选择' };
    }

    return installPickedIcon({
      pickedPath: selection.filePaths[0],
      configDirectory: writeDirectory,
      fs,
      images,
    });
  };
}

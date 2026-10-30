export const app = {
  getPath: () => '',
  isPackaged: false,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setLoginItemSettings: () => {},
  quit: () => {},
  exit: () => {},
  requestSingleInstanceLock: () => true,
  releaseSingleInstanceLock: () => {},
  on: () => app,
  whenReady: async () => {},
};

export class BrowserWindow {
  webContents = {
    forcefullyCrashRenderer: () => {},
  };
  isVisible() {
    return true;
  }
  hide() {}
  loadURL() {
    return Promise.resolve();
  }
  loadFile() {
    return Promise.resolve();
  }
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
};

export const Menu = {
  buildFromTemplate: (template: unknown) => template,
};

export const nativeImage = {
  createFromBuffer: (buf: Buffer) => ({
    isEmpty: () => false,
    getSize: () => ({ width: 32, height: 32 }),
    toPNG: () => buf,
    resize: function () {
      return this;
    },
    toDataURL: () => '',
  }),
  createFromDataURL: (url: string) => ({
    isEmpty: () => false,
    getSize: () => ({ width: 32, height: 32 }),
    toPNG: () => Buffer.from([]),
    resize: function () {
      return this;
    },
    toDataURL: () => url,
  }),
  createEmpty: () => ({
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    toPNG: () => Buffer.from([]),
    resize: function () {
      return this;
    },
    toDataURL: () => '',
  }),
};

export const net = {
  fetch: async () => ({ status: 200 }),
};

export const powerMonitor = {
  on: () => powerMonitor,
};

export const session = {
  fromPartition: () => ({
    preconnect: () => {},
    fetch: async () => ({ status: 200 }),
  }),
  defaultSession: {
    preconnect: () => {},
    fetch: async () => ({ status: 200 }),
  },
};

export class Tray {
  setToolTip() {}
  setContextMenu() {}
  on() {}
  destroy() {}
}

export const contextBridge = {
  exposeInMainWorld: () => {},
};

export const ipcRenderer = {
  invoke: async () => {},
  on: () => {},
  removeListener: () => {},
};

export const ipcMain = {
  handle: () => {},
  on: () => {},
  removeHandler: () => {},
};

export const shell = {
  openExternal: async () => {},
};

export default 'electron';


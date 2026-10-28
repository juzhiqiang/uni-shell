import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

function isLocalDevelopmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function openConfigurationWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl && isLocalDevelopmentUrl(developmentUrl)) {
    await window.loadURL(developmentUrl);
    return;
  }

  await window.loadFile(join(app.getAppPath(), 'dist/renderer/config/index.html'));
}

app.whenReady().then(openConfigurationWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

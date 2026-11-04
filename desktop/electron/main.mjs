import { app, BrowserWindow, dialog, session, shell, safeStorage } from 'electron';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronUpdater from 'electron-updater';
import { DesktopUpdates, UpdateSettings } from './updates.mjs';
import { DesktopMenu, DESKTOP_ID } from './menu-install.mjs';

let child;
let window;
let stopping = false;
let stopped = false;
let updates;
let desktopMenu;
let menuError;
let hostOperation = false;
if (process.platform === 'linux') app.setDesktopName(`${DESKTOP_ID}.desktop`);
const ownsInstance = app.requestSingleInstanceLock();
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});
function canClose() {
  if (!hostOperation && !desktopMenu?.busy()) return true;
  dialog.showMessageBoxSync(window, { type: 'info', title: 'Installation in progress',
    message: 'Wait for the installation to finish before closing AKM Desktop.' });
  return false;
}

async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send('shutdown');
    else child.kill('SIGTERM');
  });
}

app.on('before-quit', event => {
  if (stopped) return;
  event.preventDefault();
  if (!canClose()) return;
  if (window && !window.isDestroyed()) { window.close(); return; }
  if (stopping) return;
  stopping = true;
  updates?.stop();
  void stopServer().finally(() => {
    stopped = true;
    // The server is gone before electron-updater replaces the running image.
    try { if (!updates?.installOnQuit()) app.quit(); }
    catch { app.quit(); }
  });
});
app.on('window-all-closed', () => app.quit());

// Do not top-level-await ready: Electron must finish loading the ESM entry
// module before it can complete application readiness.
if (!ownsInstance) app.quit();
else void app.whenReady().then(async () => {
try {
  const updateSettings = new UpdateSettings(app.getPath('userData'), safeStorage);
  await updateSettings.load();
  desktopMenu = new DesktopMenu({
    platform: process.platform, packaged: app.isPackaged, appImage: process.env.APPIMAGE,
    home: app.getPath('home'), dataHome: process.env.XDG_DATA_HOME,
    icon: fileURLToPath(new URL('../resources/512x512.png', import.meta.url))
  });
  updates = new DesktopUpdates({
    version: app.getVersion(), store: updateSettings,
    supported: app.isPackaged && process.platform === 'linux' && Boolean(process.env.APPIMAGE),
    createUpdater: () => new electronUpdater.AppImageUpdater()
  });
  child = fork(fileURLToPath(new URL('./server.mjs', import.meta.url)), [], {
    execPath: process.execPath,
    execArgv: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AKM_DESKTOP_NATIVE_UPDATES: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.stdout.resume();
  child.on('message', async message => {
    if (message?.type === 'desktop-host-operation') { hostOperation = message.busy === true; return; }
    if (message?.type !== 'desktop-update-request' || typeof message.id !== 'string') return;
    try {
      if (!['status', 'check', 'settings', 'menu-install'].includes(message.action)) throw new Error('Unknown software action.');
      if (message.action !== 'status' && desktopMenu.busy()) throw new Error('Wait for menu installation to finish.');
      if (message.action === 'menu-install') {
        if (['checking', 'downloading', 'ready', 'installing'].includes(updates.snapshot().phase))
          throw new Error('Finish the desktop update and reopen the app before installing a menu copy.');
        menuError = undefined;
        updates.stop();
        // Return immediately; polling shows progress while native consent stays open.
        // Avoid a timed-out HTTP request that later performs an unexpected write.
        void desktopMenu.install(async () => {
          const result = await dialog.showMessageBox(window, {
            type: 'question', title: 'Replace application menu copy',
            message: `Replace the menu copy with AKM Desktop ${app.getVersion()}?`,
            detail: `This replaces ${desktopMenu.paths.appImage} with this running download. The installed copy may be newer. Cancel and open AKM Desktop from the application menu to keep it. Your knowledge and settings are unchanged.`,
            buttons: ['Cancel', 'Replace menu copy'], defaultId: 0, cancelId: 0
          });
          return result.response === 1;
        }).catch(error => { menuError = error.message; }).finally(() => updates.start());
      }
      if (message.action === 'settings') await updates.save(message.value);
      if (message.action === 'check') void updates.check();
      if (child.connected) child.send({ type: 'desktop-update-response', id: message.id,
        data: { ...updates.snapshot(), menu: { ...await desktopMenu.status(), error: menuError } } });
    } catch (error) {
      if (child.connected) child.send({ type: 'desktop-update-response', id: message.id, error: error.message });
    }
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local server startup timed out.')), 30000);
    const failed = error => { clearTimeout(timer); reject(error); };
    child.once('error', failed);
    child.once('exit', code => failed(new Error(`Local server stopped (${code}).`)));
    child.on('message', message => {
      if (message?.type === 'ready' && typeof message.url === 'string') {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
  const origin = ready.origin;
  const appSession = session.fromPartition(`akm-desktop-${process.pid}-${Date.now()}`);
  appSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  appSession.setPermissionCheckHandler(() => false);
  appSession.on('will-download', event => event.preventDefault());
  window = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 620,
    title: 'AKM Desktop', show: false,
    icon: fileURLToPath(new URL('../resources/512x512.png', import.meta.url)),
    webPreferences: { session: appSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  });
  window.on('close', event => { if (!canClose()) event.preventDefault(); });
  const openExternal = destination => {
    try {
      const url = new URL(destination);
      if (url.origin !== origin && ['http:', 'https:'].includes(url.protocol)) void shell.openExternal(url.href);
    } catch { /* Never hand invalid or custom-scheme URLs to the operating system. */ }
  };
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, destination) => {
    if (new URL(destination).origin !== origin) { event.preventDefault(); openExternal(destination); }
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question', title: 'Unsaved changes', message: 'Quit with unsaved changes?',
      detail: 'Return to your document to save it before closing.',
      buttons: ['Keep editing', 'Quit without saving'], defaultId: 0, cancelId: 0
    });
    if (choice === 1) event.preventDefault();
  });
  child.on('exit', () => { if (!stopping) app.quit(); });
  await window.loadURL(ready.url);
  window.show();
  updates.start();
} catch (error) {
  dialog.showErrorBox('AKM Desktop could not start', error instanceof Error ? error.message : String(error));
  app.quit();
}
});

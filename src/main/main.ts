import { app, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeepLinkUrl, type DeepLinkTarget, type GpuInfo } from '../shared/codecs.js';
import type { CaptureSourceItem } from '../shared/ipc.js';
import { AppAudioCapturer } from './audio.js';
import { detectSystemGpu } from './gpu.js';
import { extractHwndFromSourceId, resolveWindowsMetadata } from './windows-pid.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow: BrowserWindow | null = null;
let cachedGpuInfo: GpuInfo | null = null;
let selectedSourceId = '';
let pendingLaunchTarget: DeepLinkTarget | null = null;
const cachedWindowPids = new Map<string, number>();
const audioCapturer = new AppAudioCapturer();

function extractDeepLink(argv: readonly string[]): DeepLinkTarget | null {
  for (const arg of argv) {
    if (arg.startsWith('eerycast://')) {
      const parsed = parseDeepLinkUrl(arg);
      if (parsed) return parsed;
    }
  }
  return null;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 660,
    minWidth: 760,
    minHeight: 540,
    show: false,
    backgroundColor: '#313338',
    autoHideMenuBar: true,
    title: 'Eery',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.loadFile(path.resolve(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => {
    audioCapturer.stop();
    mainWindow = null;
  });
}

function registerHandlers(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const chosen = sources.find((s) => s.id === selectedSourceId) ?? sources[0];
      if (!chosen) {
        callback({});
        return;
      }
      callback({ video: chosen });
    } catch {
      callback({});
    }
  });

  ipcMain.handle('eery:gpu-info', async () => {
    if (!cachedGpuInfo) {
      cachedGpuInfo = await detectSystemGpu();
    }
    return cachedGpuInfo;
  });

  ipcMain.handle('eery:list-sources', async (): Promise<CaptureSourceItem[]> => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });

    const filtered = sources.filter((s) => s.name && s.name !== 'Eery');
    const hwnds: number[] = [];
    for (const src of filtered) {
      if (src.id.startsWith('window:')) {
        const hwnd = extractHwndFromSourceId(src.id);
        if (hwnd) hwnds.push(hwnd);
      }
    }

    const metaByHwnd = await resolveWindowsMetadata(hwnds);
    cachedWindowPids.clear();

    return filtered.map((s) => {
      const hwnd = extractHwndFromSourceId(s.id);
      const meta = hwnd ? metaByHwnd.get(hwnd) : undefined;
      if (meta?.pid) cachedWindowPids.set(s.id, meta.pid);

      return {
        id: s.id,
        name: s.name,
        appName: meta?.appName || null,
        pid: meta?.pid ?? null,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnailDataUrl: s.thumbnail.toDataURL(),
        appIconDataUrl: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      };
    });
  });

  ipcMain.handle('eery:select-source', (_event, sourceId: string) => {
    selectedSourceId = typeof sourceId === 'string' ? sourceId : '';
  });

  ipcMain.handle('eery:audio-start', async (_event, sourceId: string) => {
    const targetId = typeof sourceId === 'string' ? sourceId : '';
    const cachedPid = cachedWindowPids.get(targetId);
    return audioCapturer.start(
      targetId,
      (pcm) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('eery:audio-pcm', pcm);
        }
      },
      cachedPid,
    );
  });

  ipcMain.handle('eery:audio-stop', () => {
    audioCapturer.stop();
  });

  ipcMain.handle('eery:launch-target', () => pendingLaunchTarget);
}

const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
} else {
  pendingLaunchTarget = extractDeepLink(process.argv);

  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('eerycast', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('eerycast');
  }

  app.on('second-instance', (_event, argv) => {
    const target = extractDeepLink(argv);
    if (target) {
      pendingLaunchTarget = target;
      mainWindow?.webContents.send('eery:deep-link', target);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerHandlers();
    createWindow();
  });

  app.on('window-all-closed', () => {
    audioCapturer.stop();
    if (process.platform !== 'darwin') app.quit();
  });
}

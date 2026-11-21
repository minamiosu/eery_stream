import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, session } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeepLinkUrl, type DeepLinkTarget, type GpuInfo } from '../shared/codecs.js';
import type {
  CaptureSourceItem,
  PreparedCapture,
  SourceKind,
  SystemCapabilities,
} from '../shared/ipc.js';
import { AppAudioCapturer } from './audio.js';
import { detectSystemGpu } from './gpu.js';
import {
  getWindowsBuildNumber,
  shouldUseDxgiWindowCrop,
  supportsProcessLoopbackAudio,
} from './win-version.js';
import { WindowBoundsTracker } from './window-tracker.js';
import { extractHwndFromSourceId, resolveWindowsMetadata } from './windows-pid.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.commandLine.appendSwitch(
  'disable-features',
  'WebRtcAllowWgcUsingTexture,ZeroCopyDesktopCapture',
);

let mainWindow: BrowserWindow | null = null;
let cachedGpuInfo: GpuInfo | null = null;
let selectedCaptureSourceId = '';
let pendingLaunchTarget: DeepLinkTarget | null = null;
const cachedWindowPids = new Map<string, number>();
const audioCapturer = new AppAudioCapturer();
const windowTracker = new WindowBoundsTracker();

function extractDeepLink(argv: readonly string[]): DeepLinkTarget | null {
  for (const arg of argv) {
    if (arg.startsWith('eerycast://')) {
      const parsed = parseDeepLinkUrl(arg);
      if (parsed) return parsed;
    }
  }
  return null;
}

function registerProtocolClient(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('eerycast', process.execPath, [path.resolve(process.argv[1])]);
    return;
  }
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portableExe) {
    app.setAsDefaultProtocolClient('eerycast', portableExe);
    return;
  }
  const execResolved = path.resolve(process.execPath).toLowerCase();
  const tmpResolved = path.resolve(os.tmpdir()).toLowerCase();
  const inTemp =
    execResolved === tmpResolved || execResolved.startsWith(`${tmpResolved}${path.sep}`);
  if (!inTemp) {
    app.setAsDefaultProtocolClient('eerycast');
  }
}

function stopAllCaptures(): void {
  windowTracker.stop();
  audioCapturer.stop();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 660,
    minWidth: 760,
    minHeight: 540,
    show: false,
    backgroundColor: '#313338',
    title: 'Eery',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.loadFile(path.resolve(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => {
    stopAllCaptures();
    mainWindow = null;
  });
}

function registerHandlers(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const requestType: SourceKind = selectedCaptureSourceId.startsWith('window:')
        ? 'window'
        : 'screen';
      const sources = await desktopCapturer.getSources({
        types: [requestType],
        thumbnailSize: { width: 0, height: 0 },
      });
      const chosen = sources.find((s) => s.id === selectedCaptureSourceId) ?? sources[0];
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

  ipcMain.handle('eery:capabilities', (): SystemCapabilities => {
    return {
      windowsBuild: getWindowsBuildNumber(),
      supportsAppAudio: supportsProcessLoopbackAudio(),
      dxgiWindowCrop: shouldUseDxgiWindowCrop(),
    };
  });

  ipcMain.handle(
    'eery:list-sources',
    async (_event, kind?: SourceKind): Promise<CaptureSourceItem[]> => {
      const types: SourceKind[] =
        kind === 'screen' || kind === 'window' ? [kind] : ['screen', 'window'];
      const includeWindows = types.includes('window');

      const sources = await desktopCapturer.getSources({
        types,
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: includeWindows,
      });

      const filtered = sources.filter((s) => s.name && s.name !== 'Eery');
      const hwnds: number[] = [];
      if (includeWindows) {
        for (const src of filtered) {
          if (src.id.startsWith('window:')) {
            const hwnd = extractHwndFromSourceId(src.id);
            if (hwnd) hwnds.push(hwnd);
          }
        }
      }

      const metaByHwnd =
        hwnds.length > 0 ? await resolveWindowsMetadata(hwnds) : new Map();

      if (includeWindows) {
        cachedWindowPids.clear();
      }

      return filtered.map((s) => {
        const hwnd = s.id.startsWith('window:') ? extractHwndFromSourceId(s.id) : null;
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
    },
  );

  ipcMain.handle(
    'eery:prepare-capture',
    async (_event, sourceId: string): Promise<PreparedCapture> => {
      const targetId = typeof sourceId === 'string' ? sourceId : '';
      windowTracker.stop();

      if (targetId.startsWith('window:') && shouldUseDxgiWindowCrop()) {
        const hwnd = extractHwndFromSourceId(targetId);
        if (!hwnd) {
          throw new Error('Janela selecionada inválida');
        }

        const initialBounds = await windowTracker.start(hwnd, (bounds) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('eery:window-bounds', bounds);
          }
        });

        if (initialBounds.closed) {
          windowTracker.stop();
          throw new Error('A janela selecionada foi fechada');
        }

        selectedCaptureSourceId = initialBounds.screenSourceId;
        return {
          captureMode: 'dxgi-window',
          captureSourceId: initialBounds.screenSourceId,
          initialBounds,
        };
      }

      selectedCaptureSourceId = targetId;
      return {
        captureMode: 'direct',
        captureSourceId: targetId,
        initialBounds: null,
      };
    },
  );

  ipcMain.handle('eery:switch-screen-source', (_event, screenSourceId: string) => {
    selectedCaptureSourceId = typeof screenSourceId === 'string' ? screenSourceId : '';
  });

  ipcMain.handle('eery:stop-capture', () => {
    stopAllCaptures();
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
  registerProtocolClient();

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
    Menu.setApplicationMenu(null);
    registerHandlers();
    createWindow();
  });

  app.on('before-quit', () => {
    stopAllCaptures();
  });

  app.on('window-all-closed', () => {
    stopAllCaptures();
    if (process.platform !== 'darwin') app.quit();
  });
}

import { desktopCapturer, screen, type DesktopCapturerSource } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import type { WindowCropBounds } from '../shared/ipc.js';

interface RawBoundsMessage {
  closed?: boolean;
  minimized?: boolean;
  l?: number;
  t?: number;
  r?: number;
  b?: number;
  ml?: number;
  mt?: number;
  mr?: number;
  mb?: number;
}

const INITIAL_BOUNDS_TIMEOUT_MS = 4000;

function buildTrackerScript(hwnd: number): string {
  const csharp = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class EeryBounds {',
    '  [StructLayout(LayoutKind.Sequential)]',
    '  public struct RECT { public int Left, Top, Right, Bottom; }',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  public struct MONITORINFOEX {',
    '    public int cbSize;',
    '    public RECT rcMonitor;',
    '    public RECT rcWork;',
    '    public uint dwFlags;',
    '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]',
    '    public string szDevice;',
    '  }',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);',
    '  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);',
    '  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);',
    '  public static void InitDpi() {',
    '    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }',
    '    catch { try { SetProcessDPIAware(); } catch {} }',
    '  }',
    '  public static string Poll(long rawHwnd) {',
    '    IntPtr h = new IntPtr(rawHwnd);',
    '    if (!IsWindow(h)) return "{\\"closed\\":true}";',
    '    IntPtr hm = MonitorFromWindow(h, 2);',
    '    MONITORINFOEX mi = new MONITORINFOEX();',
    '    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));',
    '    if (!GetMonitorInfo(hm, ref mi)) return "{\\"closed\\":false,\\"minimized\\":true,\\"ml\\":0,\\"mt\\":0,\\"mr\\":0,\\"mb\\":0}";',
    '    if (IsIconic(h)) {',
    '      return "{\\"closed\\":false,\\"minimized\\":true,\\"ml\\":" + mi.rcMonitor.Left + ",\\"mt\\":" + mi.rcMonitor.Top + ",\\"mr\\":" + mi.rcMonitor.Right + ",\\"mb\\":" + mi.rcMonitor.Bottom + "}";',
    '    }',
    '    RECT wr;',
    '    if (DwmGetWindowAttribute(h, 9, out wr, Marshal.SizeOf(typeof(RECT))) != 0) {',
    '      if (!GetWindowRect(h, out wr)) {',
    '        return "{\\"closed\\":false,\\"minimized\\":true,\\"ml\\":" + mi.rcMonitor.Left + ",\\"mt\\":" + mi.rcMonitor.Top + ",\\"mr\\":" + mi.rcMonitor.Right + ",\\"mb\\":" + mi.rcMonitor.Bottom + "}";',
    '      }',
    '    }',
    '    return "{\\"closed\\":false,\\"minimized\\":false,\\"l\\":" + wr.Left + ",\\"t\\":" + wr.Top + ",\\"r\\":" + wr.Right + ",\\"b\\":" + wr.Bottom + ",\\"ml\\":" + mi.rcMonitor.Left + ",\\"mt\\":" + mi.rcMonitor.Top + ",\\"mr\\":" + mi.rcMonitor.Right + ",\\"mb\\":" + mi.rcMonitor.Bottom + "}";',
    '  }',
    '}',
  ].join(' ');

  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    `Add-Type -TypeDefinition '${csharp}';`,
    '[EeryBounds]::InitDpi();',
    `$hwnd = [Int64]${Math.trunc(hwnd)};`,
    '$last = "";',
    'while ($true) {',
    '  $line = [EeryBounds]::Poll($hwnd);',
    '  if ($line -ne $last) {',
    '    [Console]::WriteLine($line);',
    '    [Console]::Out.Flush();',
    '    $last = $line;',
    '  }',
    '  if ($line -eq \'{"closed":true}\') { break }',
    '  Start-Sleep -Milliseconds 100;',
    '}',
  ].join(' ');
}

export class WindowBoundsTracker {
  private child: ChildProcess | null = null;
  private sessionSeq = 0;
  private screenSources: DesktopCapturerSource[] = [];
  private lastDisplayId: number | null = null;
  private initTimer: ReturnType<typeof setTimeout> | null = null;

  public async start(
    hwnd: number,
    onUpdate: (bounds: WindowCropBounds) => void,
  ): Promise<WindowCropBounds> {
    this.stop();
    const mySeq = ++this.sessionSeq;

    this.screenSources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    if (mySeq !== this.sessionSeq) {
      return this.buildFallbackBounds(false);
    }

    const fallbackScreenId = this.screenSources[0]?.id ?? 'screen:0:0';

    return new Promise<WindowCropBounds>((resolve) => {
      let settled = false;
      let buffer = '';
      let queue: Promise<void> = Promise.resolve();

      const finishInit = (bounds: WindowCropBounds) => {
        if (settled) return;
        settled = true;
        if (this.initTimer) {
          clearTimeout(this.initTimer);
          this.initTimer = null;
        }
        resolve(bounds);
      };

      this.initTimer = setTimeout(() => {
        if (mySeq !== this.sessionSeq) return;
        finishInit({
          nx: 0,
          ny: 0,
          nw: 1,
          nh: 1,
          minimized: false,
          closed: false,
          screenSourceId: fallbackScreenId,
        });
      }, INITIAL_BOUNDS_TIMEOUT_MS);

      const proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', buildTrackerScript(hwnd)],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      this.child = proc;

      const handleLine = async (line: string) => {
        if (mySeq !== this.sessionSeq) return;
        let raw: RawBoundsMessage;
        try {
          raw = JSON.parse(line) as RawBoundsMessage;
        } catch {
          return;
        }

        const bounds = await this.computeBounds(raw, mySeq, fallbackScreenId);
        if (mySeq !== this.sessionSeq) return;

        if (!settled) {
          finishInit(bounds);
        } else {
          onUpdate(bounds);
        }

        if (bounds.closed) {
          this.stop();
        }
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        if (mySeq !== this.sessionSeq) return;
        buffer += chunk.toString('utf8');
        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            queue = queue.then(() => handleLine(line));
          }
          idx = buffer.indexOf('\n');
        }
      });

      const handleExit = () => {
        if (mySeq !== this.sessionSeq) return;
        if (this.child === proc) this.child = null;
        if (!settled) {
          finishInit(this.buildFallbackBounds(false, fallbackScreenId));
        }
      };

      proc.once('exit', handleExit);
      proc.once('error', handleExit);
    });
  }

  public stop(): void {
    this.sessionSeq += 1;
    this.lastDisplayId = null;
    if (this.initTimer) {
      clearTimeout(this.initTimer);
      this.initTimer = null;
    }
    const proc = this.child;
    this.child = null;
    if (proc && !proc.killed) {
      try {
        proc.kill();
      } catch {}
    }
  }

  private buildFallbackBounds(closed: boolean, screenSourceId?: string): WindowCropBounds {
    return {
      nx: 0,
      ny: 0,
      nw: 1,
      nh: 1,
      minimized: false,
      closed,
      screenSourceId: screenSourceId ?? this.screenSources[0]?.id ?? 'screen:0:0',
    };
  }

  private async resolveScreenSourceId(
    cx: number,
    cy: number,
    mySeq: number,
    fallbackScreenId: string,
  ): Promise<string> {
    const dipPoint = screen.screenToDipPoint({ x: cx, y: cy });
    const display = screen.getDisplayNearestPoint(dipPoint);

    if (this.lastDisplayId !== null && display.id !== this.lastDisplayId) {
      try {
        const refreshed = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (mySeq === this.sessionSeq && refreshed.length > 0) {
          this.screenSources = refreshed;
        }
      } catch {}
    }
    this.lastDisplayId = display.id;

    const exact = this.screenSources.find((s) => s.display_id && s.display_id === String(display.id));
    if (exact) return exact.id;
    if (this.screenSources.length === 1) return this.screenSources[0].id;

    const allDisplays = screen.getAllDisplays();
    const displayIndex = Math.max(
      0,
      allDisplays.findIndex((d) => d.id === display.id),
    );
    return this.screenSources[displayIndex]?.id ?? this.screenSources[0]?.id ?? fallbackScreenId;
  }

  private async computeBounds(
    raw: RawBoundsMessage,
    mySeq: number,
    fallbackScreenId: string,
  ): Promise<WindowCropBounds> {
    if (raw.closed) {
      return this.buildFallbackBounds(true, fallbackScreenId);
    }

    const ml = raw.ml ?? 0;
    const mt = raw.mt ?? 0;
    const mr = raw.mr ?? 0;
    const mb = raw.mb ?? 0;
    const mw = mr - ml;
    const mh = mb - mt;

    const hasRect =
      !raw.minimized &&
      typeof raw.l === 'number' &&
      typeof raw.t === 'number' &&
      typeof raw.r === 'number' &&
      typeof raw.b === 'number';

    const cx = hasRect ? Math.round((raw.l! + raw.r!) / 2) : Math.round((ml + mr) / 2);
    const cy = hasRect ? Math.round((raw.t! + raw.b!) / 2) : Math.round((mt + mb) / 2);
    const screenSourceId = await this.resolveScreenSourceId(cx, cy, mySeq, fallbackScreenId);

    if (!hasRect || mw <= 0 || mh <= 0) {
      return {
        nx: 0,
        ny: 0,
        nw: 1,
        nh: 1,
        minimized: true,
        closed: false,
        screenSourceId,
      };
    }

    const cl = Math.max(ml, Math.min(mr, raw.l!));
    const ct = Math.max(mt, Math.min(mb, raw.t!));
    const cr = Math.max(ml, Math.min(mr, raw.r!));
    const cb = Math.max(mt, Math.min(mb, raw.b!));
    const cw = cr - cl;
    const ch = cb - ct;

    if (cw < 2 || ch < 2) {
      return {
        nx: 0,
        ny: 0,
        nw: 1,
        nh: 1,
        minimized: true,
        closed: false,
        screenSourceId,
      };
    }

    return {
      nx: (cl - ml) / mw,
      ny: (ct - mt) / mh,
      nw: cw / mw,
      nh: ch / mh,
      minimized: false,
      closed: false,
      screenSourceId,
    };
  }
}

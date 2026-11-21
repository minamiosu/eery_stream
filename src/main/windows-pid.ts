import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const hwndCache = new Map<number, WindowProcessMeta>();

const DISCORD_PROCESS_NAMES = [
  'Discord',
  'DiscordPTB',
  'DiscordCanary',
  'Vesktop',
  'Equibop',
  'Legcord',
  'ArmCord',
];

const WIN_PROC_CSHARP = [
  'using System;',
  'using System.Collections.Generic;',
  'using System.Diagnostics;',
  'using System.Runtime.InteropServices;',
  'public static class EeryWin {',
  '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public struct PROCESSENTRY32 {',
  '    public uint dwSize;',
  '    public uint cntUsage;',
  '    public uint th32ProcessID;',
  '    public IntPtr th32DefaultHeapID;',
  '    public uint th32ModuleID;',
  '    public uint cntThreads;',
  '    public uint th32ParentProcessID;',
  '    public int pcPriClassBase;',
  '    public uint dwFlags;',
  '    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]',
  '    public string szExeFile;',
  '  }',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
  '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);',
  '  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);',
  '  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr hObject);',
  '  public static Dictionary<int, int> GetParentMap() {',
  '    var map = new Dictionary<int, int>();',
  '    IntPtr snap = CreateToolhelp32Snapshot(2, 0);',
  '    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return map;',
  '    try {',
  '      PROCESSENTRY32 pe = new PROCESSENTRY32();',
  '      pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));',
  '      if (Process32First(snap, ref pe)) {',
  '        do {',
  '          map[(int)pe.th32ProcessID] = (int)pe.th32ParentProcessID;',
  '        } while (Process32Next(snap, ref pe));',
  '      }',
  '    } finally {',
  '      CloseHandle(snap);',
  '    }',
  '    return map;',
  '  }',
  '  public static long GetStartTicks(Process p) {',
  '    try { return p.StartTime.Ticks; } catch { return long.MaxValue; }',
  '  }',
  '  public static string GetProcName(int pid, out long startTicks) {',
  '    startTicks = long.MaxValue;',
  '    try {',
  '      using (var p = Process.GetProcessById(pid)) {',
  '        startTicks = GetStartTicks(p);',
  '        return p.ProcessName ?? "";',
  '      }',
  '    } catch { return ""; }',
  '  }',
  '  public static int ResolveWindowRootPid(IntPtr hwnd, Dictionary<int, int> parentMap) {',
  '    uint wp = 0;',
  '    GetWindowThreadProcessId(hwnd, out wp);',
  '    if (wp == 0) return 0;',
  '    int pid = (int)wp;',
  '    long curTicks;',
  '    string curName = GetProcName(pid, out curTicks);',
  '    if (string.Equals(curName, "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) {',
  '      int childPid = 0;',
  '      EnumChildWindows(hwnd, (child, lp) => {',
  '        uint cp = 0;',
  '        GetWindowThreadProcessId(child, out cp);',
  '        if (cp > 0 && (int)cp != pid) { childPid = (int)cp; return false; }',
  '        return true;',
  '      }, IntPtr.Zero);',
  '      if (childPid > 0) {',
  '        pid = childPid;',
  '        curName = GetProcName(pid, out curTicks);',
  '      }',
  '    }',
  '    if (string.IsNullOrEmpty(curName)) return pid;',
  '    var visited = new HashSet<int>();',
  '    visited.Add(pid);',
  '    int ppid;',
  '    while (parentMap.TryGetValue(pid, out ppid) && ppid > 0 && !visited.Contains(ppid)) {',
  '      visited.Add(ppid);',
  '      long parentTicks;',
  '      string parentName = GetProcName(ppid, out parentTicks);',
  '      if (!string.Equals(parentName, curName, StringComparison.OrdinalIgnoreCase)) break;',
  '      if (parentTicks > curTicks) break;',
  '      pid = ppid;',
  '      curTicks = parentTicks;',
  '    }',
  '    return pid;',
  '  }',
  '  public static string GetDisplayName(int pid) {',
  '    try {',
  '      using (var p = Process.GetProcessById(pid)) {',
  '        try {',
  '          string desc = p.MainModule != null ? p.MainModule.FileVersionInfo.FileDescription : "";',
  '          if (!string.IsNullOrWhiteSpace(desc)) return desc.Trim();',
  '        } catch {}',
  '        return p.ProcessName ?? "";',
  '      }',
  '    } catch { return ""; }',
  '  }',
  '  public static int FindRootByNames(string[] names, Dictionary<int, int> parentMap) {',
  '    foreach (string name in names) {',
  '      Process[] list = Process.GetProcessesByName(name);',
  '      if (list.Length == 0) continue;',
  '      var byId = new Dictionary<int, Process>();',
  '      var startTicks = new Dictionary<int, long>();',
  '      var childCount = new Dictionary<int, int>();',
  '      foreach (Process p in list) {',
  '        byId[p.Id] = p;',
  '        startTicks[p.Id] = GetStartTicks(p);',
  '        childCount[p.Id] = 0;',
  '      }',
  '      foreach (Process p in list) {',
  '        int ppid;',
  '        if (parentMap.TryGetValue(p.Id, out ppid) && byId.ContainsKey(ppid) && ppid != p.Id && startTicks[ppid] <= startTicks[p.Id]) {',
  '          childCount[ppid] = childCount[ppid] + 1;',
  '        }',
  '      }',
  '      int bestPid = 0;',
  '      int bestChildren = -1;',
  '      long bestTicks = long.MaxValue;',
  '      foreach (Process p in list) {',
  '        int c = childCount[p.Id];',
  '        long t = startTicks[p.Id];',
  '        if (c > bestChildren || (c == bestChildren && t < bestTicks)) {',
  '          bestPid = p.Id;',
  '          bestChildren = c;',
  '          bestTicks = t;',
  '        }',
  '      }',
  '      foreach (Process p in list) { try { p.Dispose(); } catch {} }',
  '      if (bestPid > 0) return bestPid;',
  '    }',
  '    return 0;',
  '  }',
  '}',
].join(' ');

export interface WindowProcessMeta {
  pid: number;
  appName: string;
}

export function extractHwndFromSourceId(sourceId: string): number | null {
  const match = /^window:(\d+):/.exec(sourceId);
  if (!match) return null;
  const hwnd = Number(match[1]);
  return Number.isSafeInteger(hwnd) && hwnd > 0 ? hwnd : null;
}

function formatProcessName(raw: string): string {
  const clean = raw.replace(/\.exe$/i, '').trim();
  if (!clean) return '';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

export async function resolveWindowsMetadata(
  hwnds: readonly number[],
  pruneMissing = true,
): Promise<Map<number, WindowProcessMeta>> {
  const result = new Map<number, WindowProcessMeta>();
  const valid = hwnds.filter((h) => Number.isSafeInteger(h) && h > 0);
  if (valid.length === 0) {
    if (pruneMissing) hwndCache.clear();
    return result;
  }

  if (pruneMissing) {
    const validSet = new Set(valid);
    for (const cachedHwnd of hwndCache.keys()) {
      if (!validSet.has(cachedHwnd)) hwndCache.delete(cachedHwnd);
    }
  } else if (hwndCache.size > 256) {
    hwndCache.clear();
  }

  const uncached: number[] = [];
  for (const h of valid) {
    const hit = hwndCache.get(h);
    if (hit) result.set(h, hit);
    else uncached.push(h);
  }

  if (uncached.length === 0) return result;

  const listLiteral = uncached.join(',');
  const psScript = [
    `Add-Type -TypeDefinition '${WIN_PROC_CSHARP}';`,
    `$map = [EeryWin]::GetParentMap();`,
    `$names = @{};`,
    `$out = foreach ($h in @(${listLiteral})) {`,
    `  $winPid = [EeryWin]::ResolveWindowRootPid([IntPtr][Int64]$h, $map);`,
    `  if ($winPid -gt 0) {`,
    `    $k = [string]$winPid;`,
    `    if (-not $names.ContainsKey($k)) { $names[$k] = [EeryWin]::GetDisplayName($winPid) };`,
    `    [PSCustomObject]@{ hwnd = $h; pid = $winPid; appName = $names[$k] };`,
    `  }`,
    `};`,
    `@($out) | ConvertTo-Json -Compress`,
  ].join(' ');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: 8000, windowsHide: true },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return result;

    const parsed = JSON.parse(trimmed) as
      | { hwnd?: number; pid?: number; appName?: string }
      | { hwnd?: number; pid?: number; appName?: string }[];
    const rows = Array.isArray(parsed) ? parsed : [parsed];

    for (const row of rows) {
      if (
        typeof row?.hwnd === 'number' &&
        typeof row?.pid === 'number' &&
        row.pid > 0 &&
        row.pid <= 4294967295
      ) {
        const meta: WindowProcessMeta = {
          pid: row.pid,
          appName: formatProcessName(String(row.appName || '')),
        };
        hwndCache.set(row.hwnd, meta);
        result.set(row.hwnd, meta);
      }
    }
  } catch {
    return result;
  }

  return result;
}

export async function resolvePidFromSourceId(sourceId: string): Promise<number | null> {
  const hwnd = extractHwndFromSourceId(sourceId);
  if (!hwnd) return null;
  const metaMap = await resolveWindowsMetadata([hwnd], false);
  return metaMap.get(hwnd)?.pid ?? null;
}

export async function resolveDiscordRootPid(): Promise<number | null> {
  const namesLiteral = DISCORD_PROCESS_NAMES.map((n) => `'${n}'`).join(',');
  const psScript = [
    `Add-Type -TypeDefinition '${WIN_PROC_CSHARP}';`,
    `$map = [EeryWin]::GetParentMap();`,
    `[EeryWin]::FindRootByNames([string[]]@(${namesLiteral}), $map)`,
  ].join(' ');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: 5000, windowsHide: true },
    );
    const pid = Number(stdout.trim());
    return Number.isSafeInteger(pid) && pid > 0 && pid <= 4294967295 ? pid : null;
  } catch {
    return null;
  }
}

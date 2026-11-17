import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const hwndCache = new Map<number, WindowProcessMeta>();

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
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class EeryWin { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }';`,
    `$cache = @{};`,
    `$out = foreach ($h in @(${listLiteral})) {`,
    `  $wp = [uint32]0;`,
    `  [void][EeryWin]::GetWindowThreadProcessId([IntPtr][Int64]$h, [ref]$wp);`,
    `  if ($wp -gt 0) {`,
    `    $k = [string]$wp;`,
    `    if (-not $cache.ContainsKey($k)) {`,
    `      $name = '';`,
    `      try {`,
    `        $proc = [System.Diagnostics.Process]::GetProcessById([int]$wp);`,
    `        $desc = '';`,
    `        try { $desc = $proc.MainModule.FileVersionInfo.FileDescription } catch {}`,
    `        if ($desc -and $desc.Trim()) { $name = $desc.Trim() } else { $name = $proc.ProcessName }`,
    `      } catch {}`,
    `      $cache[$k] = $name;`,
    `    }`,
    `    [PSCustomObject]@{ hwnd = $h; pid = [int]$wp; appName = $cache[$k] };`,
    `  }`,
    `};`,
    `@($out) | ConvertTo-Json -Compress`,
  ].join(' ');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: 4000, windowsHide: true },
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

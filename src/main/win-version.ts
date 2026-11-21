import os from 'node:os';

let cachedBuildNumber: number | null = null;

export function getWindowsBuildNumber(): number {
  if (cachedBuildNumber !== null) return cachedBuildNumber;
  if (process.platform !== 'win32') {
    cachedBuildNumber = 0;
    return cachedBuildNumber;
  }
  const parts = os.release().split('.');
  const parsed = Number(parts[2] ?? 0);
  cachedBuildNumber = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  return cachedBuildNumber;
}

export function supportsProcessLoopbackAudio(): boolean {
  return process.platform !== 'win32' || getWindowsBuildNumber() >= 19041;
}

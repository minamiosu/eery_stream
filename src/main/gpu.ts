import { app } from 'electron';
import type { GpuInfo, GpuVendor } from '../shared/codecs.js';

interface RawGpuDevice {
  vendorId?: number;
  active?: boolean;
  deviceString?: string;
}

interface RawGpuData {
  gpuDevice?: RawGpuDevice[];
}

const VENDOR_BY_PCI: Record<number, GpuVendor> = {
  0x10de: 'nvidia',
  0x1002: 'amd',
  0x8086: 'intel',
};

const SOFTWARE_GPU: GpuInfo = {
  vendor: 'software',
  supportsHardwareAv1: false,
  supportsHardwareHevc: false,
};

function supportsAv1ByName(vendor: GpuVendor, rawName: string): boolean {
  const upper = rawName.toUpperCase();
  if (vendor === 'nvidia') return /\bRTX\s*(4\d{3}|5\d{3})\b/.test(upper);
  if (vendor === 'amd') return /\bRX\s*(7\d{3}|9\d{3})\b/.test(upper);
  if (vendor === 'intel') return /\bARC\b/.test(upper);
  return false;
}

export async function detectSystemGpu(): Promise<GpuInfo> {
  try {
    const info = (await app.getGPUInfo('complete')) as RawGpuData;
    const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice : [];

    const hardwareDevices = devices.filter(
      (d) => typeof d.vendorId === 'number' && d.vendorId !== 0x1414 && VENDOR_BY_PCI[d.vendorId],
    );

    if (hardwareDevices.length === 0) return SOFTWARE_GPU;

    const discrete = hardwareDevices.find(
      (d) => d.vendorId === 0x10de || d.vendorId === 0x1002,
    );
    const active = hardwareDevices.find((d) => d.active);
    const chosen = discrete ?? active ?? hardwareDevices[0];
    const vendor = VENDOR_BY_PCI[chosen.vendorId!];

    return {
      vendor,
      supportsHardwareAv1: supportsAv1ByName(vendor, chosen.deviceString ?? ''),
      supportsHardwareHevc: true,
    };
  } catch {
    return SOFTWARE_GPU;
  }
}

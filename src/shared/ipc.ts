import type { DeepLinkTarget, GpuInfo } from './codecs.js';

export type SourceKind = 'screen' | 'window';
export type CaptureMode = 'direct' | 'dxgi-window';

export interface CaptureSourceItem {
  id: string;
  name: string;
  appName: string | null;
  pid: number | null;
  kind: SourceKind;
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
}

export interface WindowCropBounds {
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  minimized: boolean;
  closed: boolean;
  screenSourceId: string;
}

export interface PreparedCapture {
  captureMode: CaptureMode;
  captureSourceId: string;
  initialBounds: WindowCropBounds | null;
}

export interface SystemCapabilities {
  windowsBuild: number;
  supportsAppAudio: boolean;
  dxgiWindowCrop: boolean;
}

export interface AudioCaptureInfo {
  mode: 'app' | 'system' | 'none';
  pid?: number;
  excludedPid?: number;
}

export interface EeryDesktopApi {
  getGpuInfo: () => Promise<GpuInfo>;
  getCapabilities: () => Promise<SystemCapabilities>;
  listSources: (kind?: SourceKind) => Promise<CaptureSourceItem[]>;
  prepareCapture: (sourceId: string) => Promise<PreparedCapture>;
  stopCapture: () => Promise<void>;
  switchScreenSource: (screenSourceId: string) => Promise<void>;
  onWindowBounds: (listener: (bounds: WindowCropBounds) => void) => () => void;
  startAudioCapture: (sourceId: string) => Promise<AudioCaptureInfo>;
  stopAudioCapture: () => Promise<void>;
  onAudioPcm: (listener: (pcm: Uint8Array) => void) => () => void;
  getLaunchTarget: () => Promise<DeepLinkTarget | null>;
  onLaunchTarget: (listener: (target: DeepLinkTarget) => void) => () => void;
}

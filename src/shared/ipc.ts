import type { DeepLinkTarget, GpuInfo } from './codecs.js';

export type SourceKind = 'screen' | 'window';

export interface CaptureSourceItem {
  id: string;
  name: string;
  appName: string | null;
  pid: number | null;
  kind: SourceKind;
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
}

export interface AudioCaptureInfo {
  mode: 'app' | 'system' | 'none';
  pid?: number;
}

export interface EeryDesktopApi {
  getGpuInfo: () => Promise<GpuInfo>;
  listSources: () => Promise<CaptureSourceItem[]>;
  selectSource: (sourceId: string) => Promise<void>;
  startAudioCapture: (sourceId: string) => Promise<AudioCaptureInfo>;
  stopAudioCapture: () => Promise<void>;
  onAudioPcm: (listener: (pcm: Uint8Array) => void) => () => void;
  getLaunchTarget: () => Promise<DeepLinkTarget | null>;
  onLaunchTarget: (listener: (target: DeepLinkTarget) => void) => () => void;
}

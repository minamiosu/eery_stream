export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'software';

export type CodecMode = 'auto' | 'compatible' | 'light';

export type CodecFamily = 'h264' | 'vp9' | 'hevc' | 'av1';

export type PresetId = 'fluid_720p60' | 'crisp_1080p30' | 'quality_1080p60' | 'uhd_4k60';

export interface GpuInfo {
  vendor: GpuVendor;
  supportsHardwareAv1: boolean;
  supportsHardwareHevc: boolean;
}

export interface StreamPreset {
  id: PresetId;
  label: string;
  sublabel: string;
  width: number;
  height: number;
  framerate: number;
  bitrate: number;
  keyframeInterval: number;
}

export interface CodecCandidate {
  id: string;
  family: CodecFamily;
  codecString: string;
  uhdCodecString: string;
  label: string;
  hardwareAcceleration: 'prefer-hardware' | 'no-preference';
  deltaTag: number;
  keyTag: number;
  avcFormat?: 'annexb';
}

export interface ProbedCodec {
  candidate: CodecCandidate;
  config: VideoEncoderConfig;
}

export interface DeepLinkTarget {
  wsUrl: string;
  streamKey: string;
}

export const AUDIO_WIRE_TAG = 0x02;

export const STREAM_PRESETS: readonly StreamPreset[] = [
  {
    id: 'fluid_720p60',
    label: '720p',
    sublabel: '60 FPS',
    width: 1280,
    height: 720,
    framerate: 60,
    bitrate: 3_000_000,
    keyframeInterval: 60,
  },
  {
    id: 'crisp_1080p30',
    label: '1080p',
    sublabel: '30 FPS',
    width: 1920,
    height: 1080,
    framerate: 30,
    bitrate: 3_000_000,
    keyframeInterval: 30,
  },
  {
    id: 'quality_1080p60',
    label: '1080p',
    sublabel: '60 FPS',
    width: 1920,
    height: 1080,
    framerate: 60,
    bitrate: 4_000_000,
    keyframeInterval: 60,
  },
  {
    id: 'uhd_4k60',
    label: '4K',
    sublabel: '60 FPS',
    width: 3840,
    height: 2160,
    framerate: 60,
    bitrate: 4_000_000,
    keyframeInterval: 60,
  },
];

const CANDIDATE_H264_HIGH: CodecCandidate = {
  id: 'h264_high',
  family: 'h264',
  codecString: 'avc1.64002a',
  uhdCodecString: 'avc1.640034',
  label: 'H.264 High',
  hardwareAcceleration: 'prefer-hardware',
  deltaTag: 0x10,
  keyTag: 0x11,
  avcFormat: 'annexb',
};

const CANDIDATE_H264_MAIN: CodecCandidate = {
  id: 'h264_main',
  family: 'h264',
  codecString: 'avc1.4d402a',
  uhdCodecString: 'avc1.4d4034',
  label: 'H.264 Main',
  hardwareAcceleration: 'prefer-hardware',
  deltaTag: 0x10,
  keyTag: 0x11,
  avcFormat: 'annexb',
};

const CANDIDATE_H264_BASE: CodecCandidate = {
  id: 'h264_base',
  family: 'h264',
  codecString: 'avc1.42e028',
  uhdCodecString: 'avc1.42e034',
  label: 'H.264 Baseline',
  hardwareAcceleration: 'prefer-hardware',
  deltaTag: 0x10,
  keyTag: 0x11,
  avcFormat: 'annexb',
};

const CANDIDATE_VP9_HW: CodecCandidate = {
  id: 'vp9_hw',
  family: 'vp9',
  codecString: 'vp09.00.10.08',
  uhdCodecString: 'vp09.00.51.08',
  label: 'VP9',
  hardwareAcceleration: 'prefer-hardware',
  deltaTag: 0x00,
  keyTag: 0x01,
};

const CANDIDATE_HEVC_HW: CodecCandidate = {
  id: 'hevc_hw',
  family: 'hevc',
  codecString: 'hev1.1.6.L120.90',
  uhdCodecString: 'hev1.1.6.L153.90',
  label: 'HEVC',
  hardwareAcceleration: 'prefer-hardware',
  deltaTag: 0x20,
  keyTag: 0x21,
};

const CANDIDATE_AV1_HW: CodecCandidate = {
  id: 'av1_hw',
  family: 'av1',
  codecString: 'av01.0.08M.08',
  uhdCodecString: 'av01.0.13M.08',
  label: 'AV1',
  hardwareAcceleration: 'prefer-hardware',
  deltaTag: 0x30,
  keyTag: 0x31,
};

const CANDIDATE_VP9_SW: CodecCandidate = {
  id: 'vp9_sw',
  family: 'vp9',
  codecString: 'vp09.00.10.08',
  uhdCodecString: 'vp09.00.51.08',
  label: 'VP9',
  hardwareAcceleration: 'no-preference',
  deltaTag: 0x00,
  keyTag: 0x01,
};

const CANDIDATE_H264_SW: CodecCandidate = {
  id: 'h264_sw',
  family: 'h264',
  codecString: 'avc1.42e01f',
  uhdCodecString: 'avc1.42e034',
  label: 'H.264',
  hardwareAcceleration: 'no-preference',
  deltaTag: 0x10,
  keyTag: 0x11,
  avcFormat: 'annexb',
};

const GPU_CODEC_PROFILES: Record<GpuVendor, readonly CodecCandidate[]> = {
  nvidia: [
    CANDIDATE_H264_HIGH,
    CANDIDATE_VP9_HW,
    CANDIDATE_AV1_HW,
    CANDIDATE_HEVC_HW,
    CANDIDATE_H264_BASE,
  ],
  amd: [
    CANDIDATE_H264_MAIN,
    CANDIDATE_H264_BASE,
    CANDIDATE_VP9_HW,
    CANDIDATE_HEVC_HW,
    CANDIDATE_AV1_HW,
  ],
  intel: [
    CANDIDATE_H264_HIGH,
    CANDIDATE_VP9_HW,
    CANDIDATE_AV1_HW,
    CANDIDATE_H264_BASE,
  ],
  software: [
    CANDIDATE_VP9_SW,
    CANDIDATE_H264_SW,
  ],
};

export function getPresetById(id: string): StreamPreset {
  return STREAM_PRESETS.find((p) => p.id === id) ?? STREAM_PRESETS[0];
}

export function buildCandidateList(gpu: GpuInfo, mode: CodecMode): CodecCandidate[] {
  if (mode === 'light') {
    return [...GPU_CODEC_PROFILES.software];
  }

  if (mode === 'compatible') {
    return [CANDIDATE_VP9_HW, CANDIDATE_VP9_SW, CANDIDATE_H264_SW];
  }

  const vendorList = GPU_CODEC_PROFILES[gpu.vendor] ?? GPU_CODEC_PROFILES.software;
  const filtered = vendorList.filter((item) => {
    if (item.family === 'av1' && !gpu.supportsHardwareAv1) return false;
    if (item.family === 'hevc' && !gpu.supportsHardwareHevc) return false;
    return true;
  });

  return [...filtered, ...GPU_CODEC_PROFILES.software];
}

export function buildEncoderConfig(candidate: CodecCandidate, preset: StreamPreset): VideoEncoderConfig {
  const codec = preset.width >= 3840 ? candidate.uhdCodecString : candidate.codecString;
  const base: VideoEncoderConfig = {
    codec,
    width: preset.width,
    height: preset.height,
    bitrate: preset.bitrate,
    framerate: preset.framerate,
    bitrateMode: 'constant',
    latencyMode: 'realtime',
    hardwareAcceleration: candidate.hardwareAcceleration,
  };

  if (candidate.avcFormat) {
    base.avc = { format: candidate.avcFormat };
  }

  return base;
}

export function parseDeepLinkUrl(raw: string): DeepLinkTarget | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'eerycast:') return null;
    const rawWs = parsed.searchParams.get('url')?.trim() ?? '';
    const streamKey = parsed.searchParams.get('key')?.trim() ?? '';
    if (!rawWs || !streamKey) return null;

    const wsParsed = new URL(rawWs);
    if (wsParsed.protocol !== 'ws:' && wsParsed.protocol !== 'wss:') return null;
    return {
      wsUrl: wsParsed.origin,
      streamKey: streamKey.slice(0, 120),
    };
  } catch {
    return null;
  }
}

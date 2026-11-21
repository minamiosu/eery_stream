import {
  AUDIO_WIRE_TAG,
  buildCandidateList,
  buildEncoderConfig,
  type CodecMode,
  type GpuInfo,
  type ProbedCodec,
  type StreamPreset,
} from '../shared/codecs.js';

export interface TelemetrySnapshot {
  fps: number;
  bitrateKbps: number;
}

export interface TransmitterOptions {
  wsUrl: string;
  streamKey: string;
  sourceId: string;
  captureAudio: boolean;
  stream: MediaStream;
  probed: ProbedCodec;
  preset: StreamPreset;
  onStats: (stats: TelemetrySnapshot) => void;
  onStatusChange: (status: 'connecting' | 'live' | 'error' | 'stopped', detail?: string) => void;
}

export async function probeBestCodec(
  gpu: GpuInfo,
  mode: CodecMode,
  preset: StreamPreset,
): Promise<ProbedCodec | null> {
  const candidates = buildCandidateList(gpu, mode);

  for (const candidate of candidates) {
    const config = buildEncoderConfig(candidate, preset);
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported && support.config) {
        return {
          candidate,
          config: support.config,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function normalizeWsUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProto = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`;
  try {
    const parsed = new URL(withProto);
    if (parsed.protocol === 'https:') {
      return `wss://${parsed.host}`;
    }
    if (parsed.protocol === 'http:') {
      return `ws://${parsed.host}`;
    }
    if (parsed.protocol === 'wss:' || parsed.protocol === 'ws:') {
      return `${parsed.protocol}//${parsed.host}`;
    }
    return null;
  } catch {
    return null;
  }
}

export class LiveTransmitter {
  private readonly options: TransmitterOptions;
  private ws: WebSocket | null = null;
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private videoReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private activeStream: MediaStream;
  private unsubAudioPcm: (() => void) | null = null;
  private statsTimer: number | null = null;
  private stopped = false;
  private forceNextKeyframe = true;
  private droppedVideoFrame = false;
  private frameCounter = 0;
  private windowFrames = 0;
  private windowBytes = 0;
  private audioTimestampUs = 0;
  private readonly codecInfoJson: string;
  private txScratch = new Uint8Array(new ArrayBuffer(256 * 1024));
  private audioScratch = new Uint8Array(new ArrayBuffer(16384));

  public constructor(options: TransmitterOptions) {
    this.options = options;
    this.activeStream = options.stream;
    this.codecInfoJson = JSON.stringify({
      type: 'codec_info',
      family: options.probed.candidate.family,
      codec: options.probed.candidate.codecString,
      width: options.preset.width,
      height: options.preset.height,
      framerate: options.preset.framerate,
    });
  }

  public async start(): Promise<void> {
    this.stopped = false;
    this.options.onStatusChange('connecting');

    const base = this.options.wsUrl.replace(/\/+$/, '');
    const targetUrl = `${base}/?streamKey=${encodeURIComponent(this.options.streamKey)}&role=tx`;

    const ws = new WebSocket(targetUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        ws.removeEventListener('open', onOpen);
        reject(new Error('Falha ao conectar ao servidor WebSocket'));
      };
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
    });

    if (this.stopped) {
      ws.close();
      return;
    }

    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      if (event.data.includes('request_keyframe')) {
        this.forceNextKeyframe = true;
      }
    });

    ws.addEventListener('close', () => {
      if (!this.stopped) {
        this.stop('error', 'Conexão encerrada pelo servidor');
      }
    });

    ws.addEventListener('error', () => {
      if (!this.stopped) {
        this.stop('error', 'Erro na conexão WebSocket');
      }
    });

    this.announceCodec();
    this.startVideoPipeline();
    if (this.options.captureAudio) {
      await this.startAudioPipeline();
    }
    this.startTelemetry();
    this.options.onStatusChange('live');
  }

  public stop(finalStatus: 'stopped' | 'error' = 'stopped', detail?: string): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    if (this.unsubAudioPcm) {
      this.unsubAudioPcm();
      this.unsubAudioPcm = null;
    }
    void window.eery.stopAudioCapture();

    if (this.videoReader) {
      this.videoReader.cancel().catch(() => undefined);
      this.videoReader = null;
    }

    if (this.videoEncoder && this.videoEncoder.state !== 'closed') {
      try {
        this.videoEncoder.close();
      } catch {}
    }
    this.videoEncoder = null;

    if (this.audioEncoder && this.audioEncoder.state !== 'closed') {
      try {
        this.audioEncoder.close();
      } catch {}
    }
    this.audioEncoder = null;

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    for (const track of this.activeStream.getTracks()) {
      track.stop();
    }
    void window.eery.stopCapture();

    this.options.onStatusChange(finalStatus, detail);
  }

  private announceCodec(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(this.codecInfoJson);
  }

  private ensureTxScratch(size: number): Uint8Array<ArrayBuffer> {
    if (this.txScratch.byteLength < size) {
      let nextSize = this.txScratch.byteLength;
      while (nextSize < size) nextSize *= 2;
      this.txScratch = new Uint8Array(new ArrayBuffer(nextSize));
    }
    return this.txScratch;
  }

  private ensureAudioScratch(size: number): Uint8Array<ArrayBuffer> {
    if (this.audioScratch.byteLength < size) {
      let nextSize = this.audioScratch.byteLength;
      while (nextSize < size) nextSize *= 2;
      this.audioScratch = new Uint8Array(new ArrayBuffer(nextSize));
    }
    return this.audioScratch;
  }

  private sendBinaryPacket(tag: number, chunk: EncodedVideoChunk | EncodedAudioChunk): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount > 2 * 1024 * 1024) return false;

    const totalBytes = 1 + chunk.byteLength;
    const packet = this.ensureTxScratch(totalBytes).subarray(0, totalBytes);
    packet[0] = tag;
    chunk.copyTo(packet.subarray(1));
    this.ws.send(packet);
    this.windowBytes += totalBytes;
    return true;
  }

  private startVideoPipeline(): void {
    const videoTrack = this.activeStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('Nenhuma trilha de vídeo ativa');

    const { probed, preset } = this.options;

    const encoder = new VideoEncoder({
      output: (chunk) => {
        const isKey = chunk.type === 'key';
        if (isKey) this.announceCodec();
        const tag = isKey ? probed.candidate.keyTag : probed.candidate.deltaTag;
        if (!this.sendBinaryPacket(tag, chunk)) {
          this.droppedVideoFrame = true;
          this.forceNextKeyframe = true;
          return;
        }
        this.windowFrames += 1;
      },
      error: () => {
        this.stop('error', 'Falha no encoder de vídeo');
      },
    });

    encoder.configure(probed.config);
    this.videoEncoder = encoder;

    const processor = new MediaStreamTrackProcessor<VideoFrame>({ track: videoTrack });
    const reader = processor.readable.getReader();
    this.videoReader = reader;

    const pump = async () => {
      while (!this.stopped) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) {
          if (!this.stopped) {
            this.stop('error', 'Captura de vídeo interrompida');
          }
          break;
        }

        try {
          const socketOpen = Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
          const socketBackedUp = Boolean(this.ws && this.ws.bufferedAmount > 1_048_576);
          if (
            socketOpen &&
            !socketBackedUp &&
            encoder.state === 'configured' &&
            encoder.encodeQueueSize < 3
          ) {
            const keyFrame =
              this.forceNextKeyframe ||
              this.droppedVideoFrame ||
              this.frameCounter % preset.keyframeInterval === 0;
            this.forceNextKeyframe = false;
            this.droppedVideoFrame = false;
            encoder.encode(frame, { keyFrame });
            this.frameCounter += 1;
          } else {
            this.droppedVideoFrame = true;
          }
        } finally {
          frame.close();
        }
      }
    };

    pump().catch(() => {
      if (!this.stopped) this.stop('error', 'Captura de vídeo interrompida');
    });
  }

  private async startAudioPipeline(): Promise<void> {
    const encoder = new AudioEncoder({
      output: (chunk) => {
        this.sendBinaryPacket(AUDIO_WIRE_TAG, chunk);
      },
      error: () => {},
    });

    encoder.configure({
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128_000,
    });
    this.audioEncoder = encoder;

    this.unsubAudioPcm = window.eery.onAudioPcm((raw) => {
      if (
        this.stopped ||
        !this.ws ||
        this.ws.readyState !== WebSocket.OPEN ||
        this.ws.bufferedAmount > 1_048_576 ||
        encoder.state !== 'configured' ||
        encoder.encodeQueueSize >= 8
      ) {
        return;
      }
      const alignedBytes = raw.byteLength - (raw.byteLength % 4);
      if (alignedBytes <= 0) return;

      const scratch = this.ensureAudioScratch(alignedBytes).subarray(0, alignedBytes);
      scratch.set(raw.subarray(0, alignedBytes));
      const numberOfFrames = alignedBytes / 4;
      const audioData = new AudioData({
        format: 's16',
        sampleRate: 48000,
        numberOfFrames,
        numberOfChannels: 2,
        timestamp: this.audioTimestampUs,
        data: scratch,
      });

      this.audioTimestampUs += Math.round((numberOfFrames / 48000) * 1_000_000);
      try {
        encoder.encode(audioData);
      } finally {
        audioData.close();
      }
    });

    const result = await window.eery.startAudioCapture(this.options.sourceId);
    if (this.stopped || result.mode === 'none') {
      if (this.unsubAudioPcm) {
        this.unsubAudioPcm();
        this.unsubAudioPcm = null;
      }
    }
  }

  private startTelemetry(): void {
    this.statsTimer = window.setInterval(() => {
      const fps = this.windowFrames;
      const bitrateKbps = Math.min(4000, Math.round((this.windowBytes * 8) / 1000));
      this.windowFrames = 0;
      this.windowBytes = 0;

      this.options.onStats({
        fps,
        bitrateKbps,
      });
    }, 1000);
  }
}

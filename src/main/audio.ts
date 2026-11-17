import { createRequire } from 'node:module';
import { resolvePidFromSourceId } from './windows-pid.js';

const require = createRequire(import.meta.url);

interface LoopbackInstance {
  start(processId: number, callback: (chunk: Buffer) => void): void;
  startSystemAudio(callback: (chunk: Buffer) => void, excludeProcessId?: number): void;
  stop(): void;
}

interface LoopbackModule {
  LoopbackCapture: new () => LoopbackInstance;
  default?: {
    LoopbackCapture: new () => LoopbackInstance;
  };
}

export interface AudioStartResult {
  mode: 'app' | 'system' | 'none';
  pid?: number;
}

const MIN_SETTLE_MS = 250;
let cachedLoopbackCtor: (new () => LoopbackInstance) | null = null;

function getLoopbackConstructor(): (new () => LoopbackInstance) | null {
  if (!cachedLoopbackCtor) {
    const mod = require('loopback-capture') as LoopbackModule;
    cachedLoopbackCtor = mod.LoopbackCapture ?? mod.default?.LoopbackCapture ?? null;
  }
  return cachedLoopbackCtor;
}

export class AppAudioCapturer {
  private instance: LoopbackInstance | null = null;
  private active = false;
  private startedAt = 0;
  private sessionSeq = 0;

  public start(
    sourceId: string,
    onChunk: (pcm: Uint8Array) => void,
    knownPid?: number,
  ): Promise<AudioStartResult> {
    this.stop();
    const mySeq = ++this.sessionSeq;
    return this.startInternal(mySeq, sourceId, onChunk, knownPid);
  }

  public stop(): void {
    this.sessionSeq += 1;
    this.active = false;
    const inst = this.instance;
    this.instance = null;
    if (!inst) return;

    const elapsed = Date.now() - this.startedAt;
    const delay = elapsed < MIN_SETTLE_MS ? MIN_SETTLE_MS - elapsed : 0;

    if (delay > 0) {
      setTimeout(() => {
        try {
          inst.stop();
        } catch {}
      }, delay);
      return;
    }

    try {
      inst.stop();
    } catch {}
  }

  private async startInternal(
    mySeq: number,
    sourceId: string,
    onChunk: (pcm: Uint8Array) => void,
    knownPid?: number,
  ): Promise<AudioStartResult> {
    const LoopbackCtor = getLoopbackConstructor();
    if (!LoopbackCtor) return { mode: 'none' };

    let resolvedPid: number | null = knownPid && knownPid > 0 ? knownPid : null;
    if (!resolvedPid && sourceId.startsWith('window:')) {
      resolvedPid = await resolvePidFromSourceId(sourceId);
      if (mySeq !== this.sessionSeq) return { mode: 'none' };
    }

    const capture = new LoopbackCtor();
    this.instance = capture;
    this.active = true;
    this.startedAt = Date.now();

    const emitChunk = (chunk: Buffer) => {
      if (!this.active || mySeq !== this.sessionSeq || chunk.byteLength === 0) return;
      onChunk(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    };

    if (resolvedPid) {
      try {
        capture.start(resolvedPid, emitChunk);
        return { mode: 'app', pid: resolvedPid };
      } catch {}
    }

    try {
      capture.startSystemAudio(emitChunk, process.pid);
      return { mode: 'system' };
    } catch {
      this.stop();
      return { mode: 'none' };
    }
  }
}

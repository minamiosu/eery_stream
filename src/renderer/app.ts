import {
  STREAM_PRESETS,
  getPresetById,
  type CodecMode,
  type DeepLinkTarget,
  type GpuInfo,
  type PresetId,
  type ProbedCodec,
  type StreamPreset,
} from '../shared/codecs.js';
import type {
  CaptureSourceItem,
  EeryDesktopApi,
  SourceKind,
  SystemCapabilities,
} from '../shared/ipc.js';
import { LiveTransmitter, normalizeWsUrl, probeBestCodec, type TelemetrySnapshot } from './encoder.js';

declare global {
  interface Window {
    eery: EeryDesktopApi;
  }
}

const STORAGE_WS_KEY = 'eery_ws_url';
const STORAGE_STREAM_KEY = 'eery_stream_key';
const STORAGE_PRESET_KEY = 'eery_preset_id';
const STORAGE_CODEC_KEY = 'eery_codec_mode';

const liveStatusPill = document.getElementById('liveStatusPill') as HTMLSpanElement;
const previewThumb = document.getElementById('previewThumb') as HTMLImageElement;
const previewVideo = document.getElementById('previewVideo') as HTMLVideoElement;
const previewEmpty = document.getElementById('previewEmpty') as HTMLDivElement;
const tabScreens = document.getElementById('tabScreens') as HTMLButtonElement;
const tabWindows = document.getElementById('tabWindows') as HTMLButtonElement;
const refreshSourcesBtn = document.getElementById('refreshSourcesBtn') as HTMLButtonElement;
const sourceGrid = document.getElementById('sourceGrid') as HTMLDivElement;
const presetGrid = document.getElementById('presetGrid') as HTMLDivElement;
const codecSelect = document.getElementById('codecSelect') as HTMLSelectElement;
const audioToggle = document.getElementById('audioToggle') as HTMLInputElement;
const audioToggleLabel = document.getElementById('audioToggleLabel') as HTMLSpanElement;
const wsUrlInput = document.getElementById('wsUrlInput') as HTMLInputElement;
const streamKeyInput = document.getElementById('streamKeyInput') as HTMLInputElement;
const telemetryBox = document.getElementById('telemetryBox') as HTMLDivElement;
const statFps = document.getElementById('statFps') as HTMLSpanElement;
const statBitrate = document.getElementById('statBitrate') as HTMLSpanElement;
const errorBanner = document.getElementById('errorBanner') as HTMLDivElement;
const streamBtn = document.getElementById('streamBtn') as HTMLButtonElement;

let gpuInfo: GpuInfo = {
  vendor: 'software',
  supportsHardwareAv1: false,
  supportsHardwareHevc: false,
};

let capabilities: SystemCapabilities = {
  windowsBuild: 0,
  supportsAppAudio: false,
};

const rawStoredMode = localStorage.getItem(STORAGE_CODEC_KEY);
let selectedCodecMode: CodecMode =
  rawStoredMode === 'auto' || rawStoredMode === 'compatible' || rawStoredMode === 'light'
    ? rawStoredMode
    : 'auto';

let activeKind: SourceKind = 'screen';
let allSources: CaptureSourceItem[] = [];
const loadedKinds = new Set<SourceKind>();
let selectedSource: CaptureSourceItem | null = null;
let selectedPresetId: PresetId =
  (localStorage.getItem(STORAGE_PRESET_KEY) as PresetId) || 'fluid_720p60';
let activeProbedCodec: ProbedCodec | null = null;
let activeStream: MediaStream | null = null;
let transmitter: LiveTransmitter | null = null;
let isLive = false;
let isStarting = false;
let liveStartedAt = 0;
let liveClockTimer: number | null = null;
let liveLabelEl: HTMLSpanElement | null = null;
const presetButtons = new Map<PresetId, HTMLButtonElement>();
const sourceCards = new Map<string, HTMLButtonElement>();

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function showError(message: string): void {
  if (!message) {
    errorBanner.textContent = '';
    errorBanner.classList.add('hidden');
    return;
  }
  errorBanner.textContent = message;
  errorBanner.classList.remove('hidden');
}

function updateLivePill(state: 'idle' | 'connecting' | 'live'): void {
  if (state === 'live') {
    if (!liveLabelEl || !liveStatusPill.contains(liveLabelEl)) {
      liveStatusPill.textContent = '';
      const dot = document.createElement('span');
      dot.className = 'live-dot';
      liveLabelEl = document.createElement('span');
      liveStatusPill.append(dot, liveLabelEl);
    }
    liveStatusPill.classList.remove('hidden');
    liveStatusPill.classList.add('live');
    liveLabelEl.textContent = `AO VIVO · ${formatElapsed(Date.now() - liveStartedAt)}`;
    return;
  }
  liveLabelEl = null;
  if (state === 'connecting') {
    liveStatusPill.classList.remove('hidden', 'live');
    liveStatusPill.textContent = 'Conectando...';
    return;
  }
  liveStatusPill.classList.remove('live');
  liveStatusPill.classList.add('hidden');
  liveStatusPill.textContent = '';
}

function updateAudioLabel(): void {
  if (selectedSource?.kind === 'window') {
    audioToggleLabel.textContent = capabilities.supportsAppAudio
      ? 'Áudio do aplicativo'
      : 'Áudio do sistema';
    return;
  }
  audioToggleLabel.textContent = 'Áudio da tela';
}

function syncPreviewDisplay(mode: 'empty' | 'thumb' | 'video'): void {
  previewEmpty.classList.toggle('hidden', mode !== 'empty');
  previewThumb.classList.toggle('hidden', mode !== 'thumb');
  previewVideo.classList.toggle('hidden', mode !== 'video');

  if (mode === 'thumb' && selectedSource) {
    previewThumb.src = selectedSource.thumbnailDataUrl;
    previewThumb.alt = selectedSource.appName || selectedSource.name;
  } else if (mode !== 'thumb') {
    previewThumb.removeAttribute('src');
  }
}

function syncPresetButtons(): void {
  const busy = isLive || isStarting;
  for (const [presetId, btn] of presetButtons) {
    btn.classList.toggle('active', presetId === selectedPresetId);
    btn.disabled = busy;
  }
}

function mountPresets(): void {
  presetGrid.innerHTML = '';
  presetButtons.clear();
  for (const preset of STREAM_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn';

    const main = document.createElement('span');
    main.className = 'preset-main';
    main.textContent = preset.label;

    const sub = document.createElement('span');
    sub.className = 'preset-sub';
    sub.textContent = preset.sublabel;

    btn.append(main, sub);
    btn.addEventListener('click', () => {
      if (isLive || isStarting || selectedPresetId === preset.id) return;
      selectedPresetId = preset.id;
      localStorage.setItem(STORAGE_PRESET_KEY, selectedPresetId);
      syncPresetButtons();
      void refreshCodecProbe();
    });
    presetButtons.set(preset.id, btn);
    presetGrid.appendChild(btn);
  }
  syncPresetButtons();
}

function syncSelectedSourceCard(): void {
  const busy = isLive || isStarting;
  for (const [id, card] of sourceCards) {
    card.classList.toggle('selected', selectedSource?.id === id);
    card.disabled = busy;
  }
}

function selectSourceCard(source: CaptureSourceItem): void {
  if (isLive || isStarting) return;
  showError('');
  selectedSource = source;
  updateAudioLabel();
  syncSelectedSourceCard();
  syncPreviewDisplay('thumb');
  syncButtonsState();
}

function renderSources(): void {
  const filtered = allSources.filter((s) => s.kind === activeKind);
  sourceGrid.innerHTML = '';
  sourceCards.clear();

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sources-empty';
    empty.textContent =
      activeKind === 'screen' ? 'Nenhuma tela disponível' : 'Nenhum aplicativo aberto';
    sourceGrid.appendChild(empty);
    return;
  }

  for (const src of filtered) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `source-card${selectedSource?.id === src.id ? ' selected' : ''}`;
    card.dataset.sourceId = src.id;
    card.disabled = isLive || isStarting;

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'source-thumb-wrap';

    const thumb = document.createElement('img');
    thumb.className = 'source-thumb';
    thumb.src = src.thumbnailDataUrl;
    thumb.alt = src.appName || src.name;
    thumbWrap.appendChild(thumb);

    const labelRow = document.createElement('div');
    labelRow.className = 'source-label-row';

    if (src.appIconDataUrl) {
      const icon = document.createElement('img');
      icon.className = 'source-icon';
      icon.src = src.appIconDataUrl;
      icon.alt = '';
      labelRow.appendChild(icon);
    }

    const textBox = document.createElement('div');
    textBox.className = 'source-text';

    const titleText = src.appName || src.name;
    const name = document.createElement('span');
    name.className = 'source-name';
    name.textContent = titleText;
    textBox.appendChild(name);

    if (src.appName && src.name && src.appName.toLowerCase() !== src.name.toLowerCase()) {
      const sub = document.createElement('span');
      sub.className = 'source-sub';
      sub.textContent = src.name;
      textBox.appendChild(sub);
    }

    labelRow.appendChild(textBox);
    card.append(thumbWrap, labelRow);
    card.addEventListener('click', () => {
      selectSourceCard(src);
    });
    sourceCards.set(src.id, card);
    sourceGrid.appendChild(card);
  }
}

async function refreshCodecProbe(): Promise<void> {
  const preset = getPresetById(selectedPresetId);
  activeProbedCodec = await probeBestCodec(gpuInfo, selectedCodecMode, preset);
  syncButtonsState();
}

function syncButtonsState(): void {
  const busy = isLive || isStarting;
  const canStart = Boolean(
    selectedSource &&
      activeProbedCodec &&
      wsUrlInput.value.trim() &&
      streamKeyInput.value.trim(),
  );

  streamBtn.disabled = isStarting ? true : isLive ? false : !canStart;
  streamBtn.textContent = isLive
    ? 'Parar transmissão'
    : isStarting
      ? 'Iniciando...'
      : 'Transmitir';
  streamBtn.classList.toggle('live', isLive);
  codecSelect.disabled = busy;
  audioToggle.disabled = busy;
  wsUrlInput.disabled = busy;
  streamKeyInput.disabled = busy;
  refreshSourcesBtn.disabled = busy;
  tabScreens.disabled = busy;
  tabWindows.disabled = busy;
  syncSelectedSourceCard();
  syncPresetButtons();
}

function updateStatsView(stats: TelemetrySnapshot): void {
  statFps.textContent = String(stats.fps);
  statBitrate.textContent = `${stats.bitrateKbps} kbps`;
}

function cleanupStreamResources(): void {
  if (activeStream) {
    for (const track of activeStream.getTracks()) {
      track.stop();
    }
    activeStream = null;
  }
  previewVideo.srcObject = null;
  void window.eery.stopCapture();
}

async function acquireDisplayStream(preset: StreamPreset): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: preset.width, max: preset.width },
      height: { ideal: preset.height, max: preset.height },
      frameRate: { ideal: preset.framerate, max: preset.framerate },
    },
    audio: false,
  });

  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.contentHint = preset.framerate >= 60 ? 'motion' : 'detail';
  }
  return stream;
}

function bindTrackEnded(stream: MediaStream): void {
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  track.addEventListener('ended', () => {
    if (activeStream !== stream) return;
    if (transmitter) {
      transmitter.stop('error', 'Captura de vídeo encerrada');
    } else {
      cleanupStreamResources();
      syncPreviewDisplay(selectedSource ? 'thumb' : 'empty');
      syncButtonsState();
    }
  });
}

async function startTransmission(): Promise<void> {
  if (!selectedSource || !activeProbedCodec || isLive || isStarting) return;

  const rawUrl = wsUrlInput.value.trim();
  const wsUrl = normalizeWsUrl(rawUrl);
  const streamKey = streamKeyInput.value.trim();
  if (!wsUrl || !streamKey) {
    showError('Servidor ou chave da sala inválidos');
    return;
  }

  wsUrlInput.value = wsUrl;
  localStorage.setItem(STORAGE_WS_KEY, wsUrl);
  localStorage.setItem(STORAGE_STREAM_KEY, streamKey);
  showError('');

  const preset = getPresetById(selectedPresetId);
  const targetSource = selectedSource;
  const probed = activeProbedCodec;

  isStarting = true;
  updateLivePill('connecting');
  syncButtonsState();

  try {
    await window.eery.prepareCapture(targetSource.id);
    const stream = await acquireDisplayStream(preset);

    if (!isStarting) {
      for (const track of stream.getTracks()) track.stop();
      void window.eery.stopCapture();
      return;
    }

    activeStream = stream;
    bindTrackEnded(stream);
    previewVideo.srcObject = stream;
    await previewVideo.play().catch(() => undefined);
    syncPreviewDisplay('video');

    isStarting = false;
    isLive = true;
    liveStartedAt = Date.now();
    syncButtonsState();

    liveClockTimer = window.setInterval(() => {
      if (isLive) updateLivePill('live');
    }, 1000);

    const tx = new LiveTransmitter({
      wsUrl,
      streamKey,
      sourceId: targetSource.id,
      captureAudio: audioToggle.checked,
      stream,
      probed,
      preset,
      onStats: updateStatsView,
      onStatusChange: (status, detail) => {
        if (status === 'connecting') {
          updateLivePill('connecting');
        } else if (status === 'live') {
          telemetryBox.classList.remove('hidden');
          updateLivePill('live');
        } else {
          isLive = false;
          isStarting = false;
          if (transmitter === tx) {
            transmitter = null;
          }
          if (liveClockTimer !== null) {
            window.clearInterval(liveClockTimer);
            liveClockTimer = null;
          }
          cleanupStreamResources();
          syncPreviewDisplay(selectedSource ? 'thumb' : 'empty');
          telemetryBox.classList.add('hidden');
          updateLivePill('idle');
          if (status === 'error' && detail) showError(detail);
          syncButtonsState();
        }
      },
    });

    transmitter = tx;
    await tx.start();
  } catch (err) {
    isStarting = false;
    isLive = false;
    if (liveClockTimer !== null) {
      window.clearInterval(liveClockTimer);
      liveClockTimer = null;
    }
    if (transmitter) {
      const activeTx = transmitter;
      transmitter = null;
      activeTx.stop('stopped');
    } else {
      cleanupStreamResources();
    }
    syncPreviewDisplay(selectedSource ? 'thumb' : 'empty');
    updateLivePill('idle');
    const msg = err instanceof Error ? err.message : 'Erro ao iniciar transmissão';
    showError(msg);
    syncButtonsState();
  }
}

function stopTransmission(): void {
  if (transmitter) {
    const activeTx = transmitter;
    transmitter = null;
    activeTx.stop('stopped');
    return;
  }
  if (isStarting) {
    isStarting = false;
    cleanupStreamResources();
    syncPreviewDisplay(selectedSource ? 'thumb' : 'empty');
    updateLivePill('idle');
    syncButtonsState();
  }
}

async function refreshSources(kind: SourceKind = activeKind): Promise<void> {
  const fetched = await window.eery.listSources(kind);
  loadedKinds.add(kind);
  allSources = [...allSources.filter((s) => s.kind !== kind), ...fetched];

  if (selectedSource && selectedSource.kind === kind) {
    const updated = fetched.find((s) => s.id === selectedSource?.id) ?? null;
    selectedSource = updated;
    if (!isLive && !isStarting) {
      syncPreviewDisplay(selectedSource ? 'thumb' : 'empty');
    }
  }

  renderSources();
  updateAudioLabel();
  syncButtonsState();
}

function applyDeepLink(target: DeepLinkTarget | null): void {
  if (!target) return;
  wsUrlInput.value = target.wsUrl;
  streamKeyInput.value = target.streamKey;
  localStorage.setItem(STORAGE_WS_KEY, target.wsUrl);
  localStorage.setItem(STORAGE_STREAM_KEY, target.streamKey);
  syncButtonsState();
}

async function init(): Promise<void> {
  wsUrlInput.value = localStorage.getItem(STORAGE_WS_KEY) || '';
  streamKeyInput.value = localStorage.getItem(STORAGE_STREAM_KEY) || '';
  codecSelect.value = selectedCodecMode;

  const [gpu, caps] = await Promise.all([
    window.eery.getGpuInfo(),
    window.eery.getCapabilities(),
  ]);
  gpuInfo = gpu;
  capabilities = caps;

  applyDeepLink(await window.eery.getLaunchTarget());
  window.eery.onLaunchTarget(applyDeepLink);

  tabScreens.addEventListener('click', () => {
    if (isLive || isStarting) return;
    activeKind = 'screen';
    tabScreens.classList.add('active');
    tabWindows.classList.remove('active');
    renderSources();
    if (!loadedKinds.has('screen')) {
      void refreshSources('screen');
    }
  });

  tabWindows.addEventListener('click', () => {
    if (isLive || isStarting) return;
    activeKind = 'window';
    tabWindows.classList.add('active');
    tabScreens.classList.remove('active');
    renderSources();
    if (!loadedKinds.has('window')) {
      void refreshSources('window');
    }
  });

  refreshSourcesBtn.addEventListener('click', () => {
    if (isLive || isStarting) return;
    void refreshSources(activeKind);
  });

  codecSelect.addEventListener('change', () => {
    selectedCodecMode = codecSelect.value as CodecMode;
    localStorage.setItem(STORAGE_CODEC_KEY, selectedCodecMode);
    void refreshCodecProbe();
  });

  const submitOnEnter = (ev: KeyboardEvent) => {
    if (ev.key === 'Enter' && !isLive && !isStarting && !streamBtn.disabled) {
      void startTransmission();
    }
  };

  wsUrlInput.addEventListener('input', syncButtonsState);
  streamKeyInput.addEventListener('input', syncButtonsState);
  wsUrlInput.addEventListener('keydown', submitOnEnter);
  streamKeyInput.addEventListener('keydown', submitOnEnter);

  streamBtn.addEventListener('click', () => {
    if (isLive || isStarting) stopTransmission();
    else void startTransmission();
  });

  window.addEventListener('beforeunload', () => {
    if (transmitter) {
      const activeTx = transmitter;
      transmitter = null;
      activeTx.stop('stopped');
    } else {
      cleanupStreamResources();
    }
  });

  syncPreviewDisplay('empty');
  updateAudioLabel();
  mountPresets();
  await Promise.all([refreshCodecProbe(), refreshSources('screen')]);
  syncButtonsState();
}

void init();

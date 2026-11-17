import {
  STREAM_PRESETS,
  getPresetById,
  type CodecMode,
  type DeepLinkTarget,
  type GpuInfo,
  type PresetId,
  type ProbedCodec,
} from '../shared/codecs.js';
import type { CaptureSourceItem, EeryDesktopApi, SourceKind } from '../shared/ipc.js';
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

const rawStoredMode = localStorage.getItem(STORAGE_CODEC_KEY);
let selectedCodecMode: CodecMode =
  rawStoredMode === 'auto' || rawStoredMode === 'compatible' || rawStoredMode === 'light'
    ? rawStoredMode
    : 'auto';

let activeKind: SourceKind = 'screen';
let allSources: CaptureSourceItem[] = [];
let selectedSource: CaptureSourceItem | null = null;
let selectedPresetId: PresetId = (localStorage.getItem(STORAGE_PRESET_KEY) as PresetId) || 'fluid_720p60';
let activeProbedCodec: ProbedCodec | null = null;
let previewStream: MediaStream | null = null;
let transmitter: LiveTransmitter | null = null;
let isLive = false;
let liveStartedAt = 0;
let liveClockTimer: number | null = null;
let previewSeq = 0;
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
  audioToggleLabel.textContent =
    selectedSource?.kind === 'window' ? 'Áudio do aplicativo' : 'Áudio da tela';
}

function syncPresetButtons(): void {
  for (const [presetId, btn] of presetButtons) {
    btn.classList.toggle('active', presetId === selectedPresetId);
    btn.disabled = isLive;
  }
}

async function applyPresetToActivePreview(): Promise<void> {
  if (!selectedSource) return;
  const videoTrack = previewStream?.getVideoTracks()[0];
  if (!videoTrack || videoTrack.readyState !== 'live') {
    await startPreviewForSource(selectedSource);
    return;
  }
  const preset = getPresetById(selectedPresetId);
  videoTrack.contentHint = preset.framerate >= 60 ? 'motion' : 'detail';
  try {
    await videoTrack.applyConstraints({
      width: { ideal: preset.width, max: preset.width },
      height: { ideal: preset.height, max: preset.height },
      frameRate: { ideal: preset.framerate, max: preset.framerate },
    });
  } catch {
    await startPreviewForSource(selectedSource);
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
      if (isLive || selectedPresetId === preset.id) return;
      selectedPresetId = preset.id;
      localStorage.setItem(STORAGE_PRESET_KEY, selectedPresetId);
      syncPresetButtons();
      void refreshCodecProbe().then(() => applyPresetToActivePreview());
    });
    presetButtons.set(preset.id, btn);
    presetGrid.appendChild(btn);
  }
  syncPresetButtons();
}

function syncSelectedSourceCard(): void {
  for (const [id, card] of sourceCards) {
    card.classList.toggle('selected', selectedSource?.id === id);
  }
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
      if (isLive) return;
      void startPreviewForSource(src);
    });
    sourceCards.set(src.id, card);
    sourceGrid.appendChild(card);
  }
}

function updatePreviewState(): void {
  previewEmpty.classList.toggle('hidden', Boolean(selectedSource && previewStream));
}

function stopPreviewStream(): void {
  if (previewStream) {
    for (const track of previewStream.getTracks()) {
      track.stop();
    }
    previewStream = null;
  }
  previewVideo.srcObject = null;
  updatePreviewState();
}

async function startPreviewForSource(source: CaptureSourceItem): Promise<void> {
  const seq = ++previewSeq;
  showError('');
  selectedSource = source;
  updateAudioLabel();
  syncSelectedSourceCard();
  stopPreviewStream();

  const preset = getPresetById(selectedPresetId);
  await window.eery.selectSource(source.id);
  if (seq !== previewSeq) return;

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width, max: preset.width },
        height: { ideal: preset.height, max: preset.height },
        frameRate: { ideal: preset.framerate, max: preset.framerate },
      },
      audio: false,
    });

    if (seq !== previewSeq) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    previewStream = stream;
    previewVideo.srcObject = stream;
    await previewVideo.play().catch(() => undefined);

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.contentHint = preset.framerate >= 60 ? 'motion' : 'detail';
      videoTrack.addEventListener('ended', () => {
        if (previewStream !== stream) return;
        if (isLive) stopTransmission();
        stopPreviewStream();
        selectedSource = null;
        updateAudioLabel();
        syncSelectedSourceCard();
        syncButtonsState();
      });
    }

    updatePreviewState();
    syncButtonsState();
  } catch (err) {
    if (seq !== previewSeq) return;
    const msg = err instanceof Error ? err.message : 'Falha ao capturar fonte selecionada';
    showError(msg);
    syncButtonsState();
  }
}

async function refreshCodecProbe(): Promise<void> {
  const preset = getPresetById(selectedPresetId);
  activeProbedCodec = await probeBestCodec(gpuInfo, selectedCodecMode, preset);
  syncButtonsState();
}

function syncButtonsState(): void {
  const canStart = Boolean(
    previewStream &&
      selectedSource &&
      activeProbedCodec &&
      wsUrlInput.value.trim() &&
      streamKeyInput.value.trim(),
  );

  streamBtn.disabled = isLive ? false : !canStart;
  streamBtn.textContent = isLive ? 'Parar transmissão' : 'Transmitir';
  streamBtn.classList.toggle('live', isLive);
  codecSelect.disabled = isLive;
  audioToggle.disabled = isLive;
  wsUrlInput.disabled = isLive;
  streamKeyInput.disabled = isLive;
  refreshSourcesBtn.disabled = isLive;
  syncPresetButtons();
}

function updateStatsView(stats: TelemetrySnapshot): void {
  statFps.textContent = String(stats.fps);
  statBitrate.textContent = `${stats.bitrateKbps} kbps`;
}

async function startTransmission(): Promise<void> {
  if (!previewStream || !selectedSource || !activeProbedCodec) return;

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
  isLive = true;
  liveStartedAt = Date.now();
  syncButtonsState();

  liveClockTimer = window.setInterval(() => {
    if (isLive) updateLivePill('live');
  }, 1000);

  transmitter = new LiveTransmitter({
    wsUrl,
    streamKey,
    sourceId: selectedSource.id,
    captureAudio: audioToggle.checked,
    stream: previewStream,
    probed: activeProbedCodec,
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
        if (liveClockTimer !== null) {
          window.clearInterval(liveClockTimer);
          liveClockTimer = null;
        }
        telemetryBox.classList.add('hidden');
        updateLivePill('idle');
        if (status === 'error' && detail) showError(detail);
        syncButtonsState();
      }
    },
  });

  try {
    await transmitter.start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro ao iniciar transmissão';
    transmitter.stop('error', msg);
  }
}

function stopTransmission(): void {
  if (transmitter) {
    transmitter.stop('stopped');
    transmitter = null;
  }
}

async function refreshSources(): Promise<void> {
  allSources = await window.eery.listSources();
  renderSources();
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

  gpuInfo = await window.eery.getGpuInfo();

  applyDeepLink(await window.eery.getLaunchTarget());
  window.eery.onLaunchTarget(applyDeepLink);

  tabScreens.addEventListener('click', () => {
    activeKind = 'screen';
    tabScreens.classList.add('active');
    tabWindows.classList.remove('active');
    renderSources();
  });

  tabWindows.addEventListener('click', () => {
    activeKind = 'window';
    tabWindows.classList.add('active');
    tabScreens.classList.remove('active');
    renderSources();
  });

  refreshSourcesBtn.addEventListener('click', () => {
    void refreshSources();
  });

  codecSelect.addEventListener('change', () => {
    selectedCodecMode = codecSelect.value as CodecMode;
    localStorage.setItem(STORAGE_CODEC_KEY, selectedCodecMode);
    void refreshCodecProbe();
  });

  const submitOnEnter = (ev: KeyboardEvent) => {
    if (ev.key === 'Enter' && !isLive && !streamBtn.disabled) {
      void startTransmission();
    }
  };

  wsUrlInput.addEventListener('input', syncButtonsState);
  streamKeyInput.addEventListener('input', syncButtonsState);
  wsUrlInput.addEventListener('keydown', submitOnEnter);
  streamKeyInput.addEventListener('keydown', submitOnEnter);

  streamBtn.addEventListener('click', () => {
    if (isLive) stopTransmission();
    else void startTransmission();
  });

  updateAudioLabel();
  mountPresets();
  await Promise.all([refreshCodecProbe(), refreshSources()]);
  syncButtonsState();
}

void init();

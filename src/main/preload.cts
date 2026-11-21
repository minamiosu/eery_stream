import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getGpuInfo: () => ipcRenderer.invoke('eery:gpu-info'),
  getCapabilities: () => ipcRenderer.invoke('eery:capabilities'),
  listSources: (kind?: 'screen' | 'window') => ipcRenderer.invoke('eery:list-sources', kind),
  prepareCapture: (sourceId: string) => ipcRenderer.invoke('eery:prepare-capture', sourceId),
  stopCapture: () => ipcRenderer.invoke('eery:stop-capture'),
  switchScreenSource: (screenSourceId: string) =>
    ipcRenderer.invoke('eery:switch-screen-source', screenSourceId),
  onWindowBounds: (listener: (bounds: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, bounds: unknown) => {
      listener(bounds);
    };
    ipcRenderer.on('eery:window-bounds', wrapped);
    return () => ipcRenderer.removeListener('eery:window-bounds', wrapped);
  },
  startAudioCapture: (sourceId: string) => ipcRenderer.invoke('eery:audio-start', sourceId),
  stopAudioCapture: () => ipcRenderer.invoke('eery:audio-stop'),
  onAudioPcm: (listener: (pcm: Uint8Array) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, pcm: Uint8Array) => {
      listener(pcm);
    };
    ipcRenderer.on('eery:audio-pcm', wrapped);
    return () => ipcRenderer.removeListener('eery:audio-pcm', wrapped);
  },
  getLaunchTarget: () => ipcRenderer.invoke('eery:launch-target'),
  onLaunchTarget: (listener: (target: { wsUrl: string; streamKey: string }) => void) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      payload: { wsUrl: string; streamKey: string },
    ) => {
      listener(payload);
    };
    ipcRenderer.on('eery:deep-link', wrapped);
    return () => ipcRenderer.removeListener('eery:deep-link', wrapped);
  },
};

contextBridge.exposeInMainWorld('eery', api);

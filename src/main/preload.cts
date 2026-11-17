import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getGpuInfo: () => ipcRenderer.invoke('eery:gpu-info'),
  listSources: () => ipcRenderer.invoke('eery:list-sources'),
  selectSource: (sourceId: string) => ipcRenderer.invoke('eery:select-source', sourceId),
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
    const wrapped = (_event: Electron.IpcRendererEvent, payload: { wsUrl: string; streamKey: string }) => {
      listener(payload);
    };
    ipcRenderer.on('eery:deep-link', wrapped);
    return () => ipcRenderer.removeListener('eery:deep-link', wrapped);
  },
};

contextBridge.exposeInMainWorld('eery', api);

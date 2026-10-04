'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  setFfmpeg: (p) => ipcRenderer.invoke('settings:setFfmpeg', p),
  pickFfmpeg: () => ipcRenderer.invoke('dialog:ffmpeg'),
  pickMedia: () => ipcRenderer.invoke('dialog:media'),
  pickAudio: () => ipcRenderer.invoke('dialog:audio'),
  pickOutDir: (cur) => ipcRenderer.invoke('dialog:outDir', cur),
  saveProject: (json, p) => ipcRenderer.invoke('project:save', json, p),
  openProject: (p) => ipcRenderer.invoke('project:open', p),
  probe: (p) => ipcRenderer.invoke('media:probe', p),
  frame: (p, t, maxW) => ipcRenderer.invoke('media:frame', p, t, maxW),
  describeExport: (project, mediaMap, out) => ipcRenderer.invoke('export:describe', project, mediaMap, out),
  startExport: (project, mediaMap, out) => ipcRenderer.invoke('export:start', project, mediaMap, out),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('export:progress', h);
    return () => ipcRenderer.removeListener('export:progress', h);
  },
  showInFolder: (p) => ipcRenderer.invoke('shell:show', p),
  bridgeStatus: () => ipcRenderer.invoke('bridge:status'),
  bridgeCastFile: (p, s) => ipcRenderer.invoke('bridge:castFile', p, s),
  bridgeCastImage: (buf, s) => ipcRenderer.invoke('bridge:castImage', buf, s),
  bridgeShow: (show) => ipcRenderer.invoke('bridge:show', show),
  pathForFile: (file) => webUtils.getPathForFile(file),
  // 実機リアルタイム表示
  lkgOpen: () => ipcRenderer.invoke('lkg:open'),
  lkgClose: () => ipcRenderer.invoke('lkg:close'),
  lkgSend: (m) => ipcRenderer.send('lkg:send', m),
  onLkgEvent: (cb) => ipcRenderer.on('lkg:event', (_e, m) => cb(m)),
  // lkg ウィンドウ側
  lkgReady: () => ipcRenderer.send('lkg:ready'),
  lkgReport: (info) => ipcRenderer.send('lkg:report', info),
  onLkgState: (cb) => ipcRenderer.on('lkg:state', (_e, m) => cb(m)),
});

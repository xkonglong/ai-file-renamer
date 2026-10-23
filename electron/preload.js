const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // File operations
  renameFile: (oldPath, newName) => ipcRenderer.invoke('rename-file', oldPath, newName),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  readFileInfo: (filePath) => ipcRenderer.invoke('read-file-info', filePath),
  readFileAsText: (filePath, maxBytes) => ipcRenderer.invoke('read-file-as-text', filePath, maxBytes),
  readFileAsBase64: (filePath) => ipcRenderer.invoke('read-file-as-base64', filePath),
  extractDocument: (filePath) => ipcRenderer.invoke('extract-document', filePath),

  // Utilities
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),

  // Get file system path from dropped/selected File object
  getPathForFile: (file) => webUtils.getPathForFile(file),
});

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

// ============ Settings Persistence ============

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

const defaultSettings = {
  api: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    chatModel: 'gpt-4o-mini',
    visionModel: 'gpt-4o',
  },
  rules: {
    prefix: '',
    suffix: '',
    customPrompt: '',
  },
  theme: 'dark',
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8');
      const saved = JSON.parse(data);
      return {
        ...defaultSettings,
        ...saved,
        api: { ...defaultSettings.api, ...(saved.api || {}) },
        rules: { ...defaultSettings.rules, ...(saved.rules || {}) },
      };
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
  return { ...defaultSettings };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to save settings:', err);
    return false;
  }
}

// ============ Window Creation ============

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: '\u5c0f\u6050\u9f99 AI \u667a\u80fd\u6587\u4ef6\u66f4\u540d',
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:3266');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ============ IPC Handlers ============

ipcMain.handle('get-settings', () => loadSettings());

ipcMain.handle('save-settings', (_event, settings) => saveSettings(settings));

ipcMain.handle('rename-file', async (_event, oldPath, newName) => {
  try {
    if (!fs.existsSync(oldPath)) {
      return { success: false, error: '\u539f\u59cb\u6587\u4ef6\u4e0d\u5b58\u5728' };
    }
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, newName);
    if (oldPath === newPath) {
      return { success: true, newPath };
    }
    if (fs.existsSync(newPath)) {
      return { success: false, error: `\u76ee\u6807\u6587\u4ef6 "${newName}" \u5df2\u5b58\u5728` };
    }
    fs.renameSync(oldPath, newPath);
    return { success: true, newPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: '\u9009\u62e9\u8981\u91cd\u547d\u540d\u7684\u6587\u4ef6',
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('read-file-info', async (_event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif', '.tiff'];
    const isImage = imageExts.includes(ext);

    let preview = null;
    if (isImage && stats.size < 10 * 1024 * 1024) {
      const data = fs.readFileSync(filePath);
      const mimeMap = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
        '.tiff': 'image/tiff',
      };
      const mime = mimeMap[ext] || 'image/png';
      preview = `data:${mime};base64,${data.toString('base64')}`;
    }

    return {
      name: path.basename(filePath),
      size: stats.size,
      isImage,
      preview,
      path: filePath,
    };
  } catch (err) {
    return null;
  }
});

ipcMain.handle('read-file-as-text', async (_event, filePath, maxBytes) => {
  try {
    maxBytes = maxBytes || 4000;
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    fs.closeSync(fd);
    return buffer.slice(0, bytesRead).toString('utf-8');
  } catch (err) {
    return '';
  }
});

ipcMain.handle('read-file-as-base64', async (_event, filePath) => {
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
    };
    const mime = mimeMap[ext] || 'application/octet-stream';
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch (err) {
    return null;
  }
});

ipcMain.handle('get-app-version', () => app.getVersion());

// 文档内容提取（docx/pdf/纯文本）：解析与 PDF 扫描页分诊在主进程完成
ipcMain.handle('extract-document', async (_event, filePath) => {
  try {
    const { extractDocumentContent } = await import('./documentParser.mjs');
    return await extractDocumentContent(filePath);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('open-path', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

// ============ App Lifecycle ============

app.whenReady().then(() => {
  // Fix CORS for AI API calls from renderer
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    headers['access-control-allow-origin'] = ['*'];
    headers['access-control-allow-headers'] = ['*'];
    headers['access-control-allow-methods'] = ['*'];
    callback({ responseHeaders: headers });
  });

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

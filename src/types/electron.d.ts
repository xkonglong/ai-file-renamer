interface ElectronAPI {
  getSettings: () => Promise<any>;
  saveSettings: (settings: any) => Promise<boolean>;
  renameFile: (oldPath: string, newName: string) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  selectFiles: () => Promise<string[]>;
  readFileInfo: (filePath: string) => Promise<{
    name: string;
    size: number;
    isImage: boolean;
    preview: string | null;
    path: string;
  } | null>;
  readFileAsText: (filePath: string, maxBytes?: number) => Promise<string>;
  readFileAsBase64: (filePath: string) => Promise<string | null>;
  extractDocument: (filePath: string) => Promise<DocumentExtractResult>;
  getAppVersion: () => Promise<string>;
  openPath: (filePath: string) => Promise<void>;
  getPathForFile: (file: File) => string;
}

interface Window {
  electronAPI: ElectronAPI;
}

// ============ 文档内容提取结果（主进程 documentParser） ============

interface PdfPageInfo {
  index: number;
  text: string;
  charCount: number;
  isScanned: boolean;
}

interface ScannedPage {
  index: number;
  charCount: number;
  imageDataUrl?: string;
  skipped?: boolean;
  renderError?: string;
}

type DocumentExtractResult =
  | { kind: 'docx'; text: string }
  | {
      kind: 'pdf';
      numPages: number;
      pages: PdfPageInfo[];
      scannedPages: ScannedPage[];
      fullText: string;
      isScanned: boolean;
    }
  | { kind: 'text'; text: string }
  | { kind: 'legacy-doc'; ext: string; hint: string }
  | { kind: 'unsupported'; text: string; hint: string }
  | { error: string };

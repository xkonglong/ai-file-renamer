import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Upload,
  FileImage,
  FileText,
  X,
  Sparkles,
  Download,
  Copy,
  Check,
  Trash2,
  RefreshCw,
  Settings,
  Image as ImageIcon,
  File as FileIcon,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  Pencil,
} from 'lucide-react';
import { compressImageToBase64 } from './services/imageUtils';
import { requestVisionStream, requestLLMStream, setAIConfig, type AIConfig, type VisionContent } from './services/aiService';

// ============ Types ============

interface FileItem {
  id: string;
  file: File | null;
  filePath: string;
  preview?: string;
  originalName: string;
  suggestedName: string;
  isGenerating: boolean;
  isRenamed: boolean;
  renameError?: string;
  documentHint?: string;
  isImage: boolean;
  fileType: string;
  size: number;
}

interface RenameRule {
  prefix: string;
  suffix: string;
  customPrompt: string;
}

interface AppSettings {
  api: AIConfig;
  rules: RenameRule;
  theme: string;
}

// ============ Constants ============

const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI;
const electronAPI: ElectronAPI | null = isElectron ? (window as any).electronAPI : null;

const DEFAULT_SETTINGS: AppSettings = {
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

// ============ Helper Functions ============

const generateId = () => Math.random().toString(36).substr(2, 9);

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const getFileIcon = (fileType: string, isImage: boolean) => {
  if (isImage) return <ImageIcon className="w-5 h-5 text-blue-400" />;
  if (fileType.includes('pdf')) return <FileText className="w-5 h-5 text-red-400" />;
  if (fileType.includes('doc')) return <FileText className="w-5 h-5 text-blue-500" />;
  if (fileType.includes('xls')) return <FileText className="w-5 h-5 text-green-500" />;
  if (fileType.includes('ppt')) return <FileText className="w-5 h-5 text-orange-500" />;
  if (fileType.includes('txt') || fileType.includes('text')) return <FileText className="w-5 h-5 text-gray-400" />;
  return <FileIcon className="w-5 h-5 text-gray-400" />;
};

const cleanFileName = (raw: string, rules: RenameRule, originalName: string): string => {
  // Remove thinking tags like <think>...</think>
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Remove markdown formatting
  cleaned = cleaned.replace(/[*_`#]/g, '').trim();
  // Remove quotes
  cleaned = cleaned.replace(/^["'`]+|["'`]+$/g, '').trim();
  // Remove file extension if AI included it
  const extMatch = originalName.match(/\.([^.]+)$/);
  const ext = extMatch ? extMatch[1] : '';
  if (ext) {
    const extPattern = new RegExp(`\\.${ext}$`, 'i');
    cleaned = cleaned.replace(extPattern, '');
  }
  // Clean invalid path characters
  cleaned = cleaned.replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50);

  if (!cleaned) cleaned = 'unnamed';

  const prefix = rules.prefix ? rules.prefix + '_' : '';
  const suffix = rules.suffix ? '_' + rules.suffix : '';

  return `${prefix}${cleaned}${suffix}.${ext}`;
};

// ============ 文档内容提取（主进程解析器，docx/pdf/纯文本） ============

// 优先主进程解析器；返回 null 表示无法解析（无 electron / 无路径 / 解析失败）
async function extractDocumentForItem(item: FileItem): Promise<DocumentExtractResult | null> {
  if (!electronAPI) return null;
  let fp = item.filePath;
  if (!fp && item.file) {
    try { fp = electronAPI.getPathForFile(item.file); } catch { /* ignore */ }
  }
  if (!fp) return null;
  try {
    const res = await electronAPI.extractDocument(fp);
    if (!res || 'error' in res) return null;
    return res;
  } catch {
    return null;
  }
}

// 从解析结果中取可用的文本（docx/text -> text，pdf 文本页 -> fullText）
function textFromExtract(extracted: DocumentExtractResult): string {
  if ('error' in extracted) return '';
  if (extracted.kind === 'pdf') return extracted.fullText || '';
  if (extracted.kind === 'docx' || extracted.kind === 'text') return extracted.text || '';
  return '';
}

// 扫描版 PDF 的视觉模型提示词（多页图片 + 可识别文本作为上下文）
function buildScannedVisionPrompt(
  extracted: Extract<DocumentExtractResult, { kind: 'pdf' }>,
  rules: RenameRule,
  originalName: string
): string {
  const context = extracted.fullText
    ? `\n\n文档中已可识别的文字信息：\n${extracted.fullText.slice(0, 1500)}`
    : '';
  const extra = rules.customPrompt ? `额外要求：${rules.customPrompt}` : '';
  return `这是一个扫描版/图片型 PDF 文档。请分析以下所有页面图片的内容，用简洁的中文概括文档主题，用于生成文件名。只返回描述内容，不要任何解释、引号或扩展名。\n文件原名：${originalName}${context}\n${extra}`;
}

// ============ Main App ============

export default function App() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'api' | 'rules'>('api');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [scriptType, setScriptType] = useState<'bash' | 'windows'>('windows');

  // Load settings on mount
  useEffect(() => {
    async function init() {
      if (electronAPI) {
        try {
          const saved = await electronAPI.getSettings();
          const merged: AppSettings = {
            ...DEFAULT_SETTINGS,
            ...saved,
            api: { ...DEFAULT_SETTINGS.api, ...(saved?.api || {}) },
            rules: { ...DEFAULT_SETTINGS.rules, ...(saved?.rules || {}) },
          };
          setSettings(merged);
          setAIConfig(merged.api);
        } catch (err) {
          console.error('Failed to load settings:', err);
        }
      }
      setIsInitialized(true);
    }
    init();
  }, []);

  // Save settings helper
  const updateSettings = useCallback(async (newSettings: AppSettings) => {
    setSettings(newSettings);
    setAIConfig(newSettings.api);
    if (electronAPI) {
      await electronAPI.saveSettings(newSettings);
    }
  }, []);

  // ============ File Drag & Drop ============

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // ============ File Processing ============

  const generateNameForFile = useCallback(async (item: FileItem, rules: RenameRule) => {
    try {
      let result = '';

      if (item.isImage) {
        // Get image as base64
        let base64Image: string;
        if (item.file) {
          base64Image = await compressImageToBase64(item.file);
        } else if (item.preview) {
          base64Image = await compressImageToBase64(item.preview);
        } else if (electronAPI && item.filePath) {
          const dataUrl = await electronAPI.readFileAsBase64(item.filePath);
          if (!dataUrl) throw new Error('无法读取图片数据');
          base64Image = await compressImageToBase64(dataUrl);
        } else {
          throw new Error('无法获取图片数据');
        }

        await requestVisionStream(
          {
            text: `请分析这张图片的内容，用简洁的中文描述图片主题，用于生成文件名。只返回描述内容，不要任何解释、引号或扩展名。${rules.customPrompt ? '额外要求：' + rules.customPrompt : ''}`,
            imageUrl: base64Image,
          },
          (chunk) => {
            result += chunk;
            setFiles(prev => prev.map(f =>
              f.id === item.id ? { ...f, suggestedName: result } : f
            ));
          }
        );
      } else {
        // 文档/文本文件：优先主进程解析器（docx/pdf/纯文本），扫描版 PDF 走视觉模型
        const extracted = await extractDocumentForItem(item);

        // 旧版二进制办公文档 / 不支持的格式：不空跑 AI，直接给出文字提示
        if (
          extracted &&
          !('error' in extracted) &&
          (extracted.kind === 'legacy-doc' || extracted.kind === 'unsupported')
        ) {
          const hint = extracted.kind === 'legacy-doc'
            ? extracted.hint
            : extracted.hint || '无法读取该文件内容，暂不支持自动命名。';
          setFiles(prev => prev.map(f =>
            f.id === item.id ? { ...f, documentHint: hint, suggestedName: '', isGenerating: false } : f
          ));
          return;
        }

        const isScannedPdf =
          !!extracted && !('error' in extracted) && extracted.kind === 'pdf' && extracted.isScanned;

        if (isScannedPdf) {
          const pdf = extracted as Extract<DocumentExtractResult, { kind: 'pdf' }>;
          // 收集扫描页图片（跳过渲染失败的页）
          const images = pdf.scannedPages
            .filter((sp) => sp.imageDataUrl)
            .map((sp) => ({ type: 'image_url', image_url: { url: sp.imageDataUrl! } }) as VisionContent);

          if (images.length > 0) {
            const content: VisionContent[] = [
              { type: 'text', text: buildScannedVisionPrompt(pdf, rules, item.originalName) },
              ...images,
            ];
            await requestVisionStream(
              { messages: [{ role: 'user', content }] },
              (chunk) => {
                result += chunk;
                setFiles(prev => prev.map(f =>
                  f.id === item.id ? { ...f, suggestedName: result } : f
                ));
              }
            );
          } else {
            // 所有扫描页都渲染失败 → 退回文本通道（可能为空）
            const truncatedText = (pdf.fullText || '').slice(0, 2000);
            await requestLLMStream(
              [
                {
                  role: 'system',
                  content: '你是一个文件命名助手，根据文件内容生成简洁、描述性的中文文件名。只返回文件名建议，不要任何解释、引号、扩展名或额外文字。',
                },
                {
                  role: 'user',
                  content: `请根据以下文件内容生成一个简洁的文件名（不含扩展名）：\n\n文件原名：${item.originalName}\n\n文件内容片段：\n${truncatedText || '（无法读取文本内容）'}\n\n${rules.customPrompt ? '额外要求：' + rules.customPrompt : ''}`,
                },
              ],
              (chunk) => {
                result += chunk;
                setFiles(prev => prev.map(f =>
                  f.id === item.id ? { ...f, suggestedName: result } : f
                ));
              }
            );
          }
        } else {
          // 普通文本 / docx / 非扫描 pdf → 提取文本后走 LLM
          let text = extracted ? textFromExtract(extracted) : '';
          if (!text && item.file) {
            text = await item.file.text().catch(() => '');
          }
          if (!text && electronAPI && item.filePath) {
            text = await electronAPI.readFileAsText(item.filePath, 4000);
          }
          const truncatedText = text.slice(0, 2000);

          await requestLLMStream(
            [
              {
                role: 'system',
                content: '你是一个文件命名助手，根据文件内容生成简洁、描述性的中文文件名。只返回文件名建议，不要任何解释、引号、扩展名或额外文字。',
              },
              {
                role: 'user',
                content: `请根据以下文件内容生成一个简洁的文件名（不含扩展名）：\n\n文件原名：${item.originalName}\n\n文件内容片段：\n${truncatedText || '（无法读取文本内容）'}\n\n${rules.customPrompt ? '额外要求：' + rules.customPrompt : ''}`,
              },
            ],
            (chunk) => {
              result += chunk;
              setFiles(prev => prev.map(f =>
                f.id === item.id ? { ...f, suggestedName: result } : f
              ));
            }
          );
        }
      }

      const finalName = cleanFileName(result, rules, item.originalName);
      setFiles(prev => prev.map(f =>
        f.id === item.id ? { ...f, suggestedName: finalName, isGenerating: false } : f
      ));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : '生成失败';
      setFiles(prev => prev.map(f =>
        f.id === item.id ? { ...f, suggestedName: '', isGenerating: false, renameError: errorMsg } : f
      ));
    }
  }, []);

  const processDroppedFiles = useCallback(async (fileList: FileList) => {
    const newFiles: FileItem[] = [];

    for (const file of Array.from(fileList)) {
      const isImage = file.type.startsWith('image/');
      let preview: string | undefined;
      let filePath = '';

      if (isImage) {
        preview = URL.createObjectURL(file);
      }

      if (electronAPI) {
        try {
          filePath = electronAPI.getPathForFile(file);
        } catch {
          filePath = '';
        }
      }

      const fileItem: FileItem = {
        id: generateId(),
        file,
        filePath,
        preview,
        originalName: file.name,
        suggestedName: '',
        isGenerating: true,
        isRenamed: false,
        isImage,
        fileType: file.type,
        size: file.size,
      };

      newFiles.push(fileItem);
    }

    setFiles(prev => [...prev, ...newFiles]);

    // Generate names for all new files
    for (const item of newFiles) {
      generateNameForFile(item, settings.rules);
    }
  }, [settings.rules, generateNameForFile]);

  const processDialogFiles = useCallback(async (filePaths: string[]) => {
    if (!electronAPI) return;

    const newFiles: FileItem[] = [];

    for (const filePath of filePaths) {
      const info = await electronAPI.readFileInfo(filePath);
      if (!info) continue;

      newFiles.push({
        id: generateId(),
        file: null,
        filePath,
        preview: info.preview || undefined,
        originalName: info.name,
        suggestedName: '',
        isGenerating: true,
        isRenamed: false,
        isImage: info.isImage,
        fileType: info.isImage ? 'image/*' : 'application/octet-stream',
        size: info.size,
      });
    }

    setFiles(prev => [...prev, ...newFiles]);

    for (const item of newFiles) {
      generateNameForFile(item, settings.rules);
    }
  }, [settings.rules, generateNameForFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processDroppedFiles(e.dataTransfer.files);
    }
  }, [processDroppedFiles]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processDroppedFiles(e.target.files);
    }
  };

  const handleNativeDialog = async () => {
    if (!electronAPI) return;
    const paths = await electronAPI.selectFiles();
    if (paths.length > 0) {
      processDialogFiles(paths);
    }
  };

  // ============ File Actions ============

  const removeFile = (id: string) => {
    setFiles(prev => {
      const file = prev.find(f => f.id === id);
      if (file?.preview && file.file) {
        URL.revokeObjectURL(file.preview);
      }
      return prev.filter(f => f.id !== id);
    });
  };

  const clearAll = () => {
    files.forEach(f => {
      if (f.preview && f.file) URL.revokeObjectURL(f.preview);
    });
    setFiles([]);
  };

  const regenerateName = (id: string) => {
    const item = files.find(f => f.id === id);
    if (!item) return;
    setFiles(prev => prev.map(f =>
      f.id === id ? { ...f, isGenerating: true, suggestedName: '', renameError: undefined } : f
    ));
    generateNameForFile(item, settings.rules);
  };

  const regenerateAllNames = () => {
    const toRegenerate = files.filter(f => !f.isGenerating && !f.isRenamed);
    if (toRegenerate.length === 0) return;

    for (const item of toRegenerate) {
      setFiles(prev => prev.map(f =>
        f.id === item.id ? { ...f, isGenerating: true, suggestedName: '', renameError: undefined } : f
      ));
      generateNameForFile(item, settings.rules);
    }
  };

  const renameFile = async (id: string) => {
    if (!electronAPI) return;
    const item = files.find(f => f.id === id);
    if (!item || !item.filePath || !item.suggestedName || item.isRenamed) return;

    const result = await electronAPI.renameFile(item.filePath, item.suggestedName);
    if (result.success) {
      setFiles(prev => prev.map(f =>
        f.id === id ? { ...f, isRenamed: true, filePath: result.newPath || f.filePath, renameError: undefined } : f
      ));
    } else {
      setFiles(prev => prev.map(f =>
        f.id === id ? { ...f, renameError: result.error } : f
      ));
    }
  };

  const renameAll = async () => {
    const validFiles = files.filter(f => f.suggestedName && !f.isGenerating && !f.isRenamed && f.filePath);
    for (const file of validFiles) {
      await renameFile(file.id);
    }
  };

  const updateSuggestedName = (id: string, name: string) => {
    setFiles(prev => prev.map(f =>
      f.id === id ? { ...f, suggestedName: name } : f
    ));
  };

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // ============ Batch Script ============

  const generateBatchScript = () => {
    const validFiles = files.filter(f => f.suggestedName && !f.isGenerating);
    if (validFiles.length === 0) return '';

    if (scriptType === 'windows') {
      let script = '@echo off\nchcp 65001 >nul\n\n:: AI\u6587\u4ef6\u91cd\u547d\u540d\u6279\u5904\u7406\u811a\u672c (Windows)\n\n';
      validFiles.forEach(f => {
        const safeOriginal = f.originalName.replace(/"/g, '""');
        const safeNew = f.suggestedName.replace(/"/g, '""');
        script += `ren "${safeOriginal}" "${safeNew}"\n`;
      });
      script += '\necho \u91cd\u547d\u540d\u5b8c\u6210\uff01\npause\n';
      return script;
    } else {
      let script = '#!/bin/bash\n\n# AI\u6587\u4ef6\u91cd\u547d\u540d\u6279\u5904\u7406\u811a\u672c (Linux/Mac)\n\n';
      validFiles.forEach(f => {
        const safeOriginal = f.originalName.replace(/'/g, "'\\''");
        const safeNew = f.suggestedName.replace(/'/g, "'\\''");
        script += `mv '${safeOriginal}' '${safeNew}'\n`;
      });
      script += '\necho "\u91cd\u547d\u540d\u5b8c\u6210\uff01"\n';
      return script;
    }
  };

  const downloadBatchScript = () => {
    const script = generateBatchScript();
    if (!script) return;
    const blob = new Blob([script], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = scriptType === 'windows' ? 'rename_files.bat' : 'rename_files.sh';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ============ Stats ============

  const completedCount = files.filter(f => !f.isGenerating).length;
  const renamedCount = files.filter(f => f.isRenamed).length;
  const readyToRename = files.filter(f => f.suggestedName && !f.isGenerating && !f.isRenamed && f.filePath).length;
  const apiConfigured = !!settings.api.apiKey;

  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <RefreshCw className="w-8 h-8 text-blue-400 animate-spin" />
      </div>
    );
  }

  // ============ Render ============

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      <div className="max-w-5xl mx-auto px-4 py-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-10"
        >
          <h1 className="text-4xl font-bold mb-3 bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
            {'\u5c0f\u6050\u9f99'} AI {'\u667a\u80fd\u6587\u4ef6\u66f4\u540d'}
          </h1>
          <p className="text-slate-400 text-lg">
            {'\u4e0a\u4f20\u6587\u4ef6\uff0cAI\u81ea\u52a8\u5206\u6790\u5185\u5bb9\u5e76\u751f\u6210\u5408\u9002\u7684\u6587\u4ef6\u540d'}
          </p>
          {!apiConfigured && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-amber-500/20 border border-amber-500/30 rounded-lg text-amber-400 text-sm"
            >
              <AlertCircle className="w-4 h-4" />
              {'\u8bf7\u5148\u70b9\u51fb\u201c\u8bbe\u7f6e\u201d\u914d\u7f6e AI API \u4fe1\u606f'}
            </motion.div>
          )}
        </motion.div>

        {/* Action Bar */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="mb-6 flex flex-wrap justify-center gap-3"
        >
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
              showSettings
                ? 'bg-blue-500/30 border border-blue-500/50 text-blue-300'
                : 'bg-slate-700/50 hover:bg-slate-700'
            }`}
          >
            <Settings className="w-4 h-4" />
            {'\u8bbe\u7f6e'}
          </button>

          {isElectron && (
            <button
              onClick={handleNativeDialog}
              className="flex items-center gap-2 px-4 py-2 bg-slate-700/50 hover:bg-slate-700 rounded-lg transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              {'\u9009\u62e9\u6587\u4ef6'}
            </button>
          )}

          {files.length > 0 && (
            <>
              <button
                onClick={clearAll}
                className="flex items-center gap-2 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                {'\u6e05\u7a7a\u5168\u90e8'}
              </button>
              <button
                onClick={regenerateAllNames}
                className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                {'\u91cd\u65b0\u751f\u6210\u5168\u90e8'}
              </button>

              {isElectron && readyToRename > 0 && (
                <button
                  onClick={renameAll}
                  className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 rounded-lg transition-all text-white font-medium"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {'\u5168\u90e8\u91cd\u547d\u540d'} ({readyToRename})
                </button>
              )}

              <div className="flex items-center gap-2">
                <select
                  value={scriptType}
                  onChange={(e) => setScriptType(e.target.value as 'bash' | 'windows')}
                  className="px-3 py-2 bg-slate-700/50 rounded-lg border border-slate-600 text-sm"
                >
                  <option value="windows">Windows (.bat)</option>
                  <option value="bash">Linux/Mac (.sh)</option>
                </select>
                <button
                  onClick={downloadBatchScript}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 rounded-lg transition-colors"
                >
                  <Download className="w-4 h-4" />
                  {'\u4e0b\u8f7d\u811a\u672c'}
                </button>
              </div>
            </>
          )}
        </motion.div>

        {/* Settings Panel */}
        <AnimatePresence>
          {showSettings && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-6 overflow-hidden"
            >
              <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700">
                {/* Tabs */}
                <div className="flex gap-4 mb-5">
                  <button
                    onClick={() => setSettingsTab('api')}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      settingsTab === 'api'
                        ? 'bg-blue-500/30 text-blue-300 border border-blue-500/40'
                        : 'bg-slate-700/30 text-slate-400 hover:text-slate-300'
                    }`}
                  >
                    API {'\u914d\u7f6e'}
                  </button>
                  <button
                    onClick={() => setSettingsTab('rules')}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      settingsTab === 'rules'
                        ? 'bg-blue-500/30 text-blue-300 border border-blue-500/40'
                        : 'bg-slate-700/30 text-slate-400 hover:text-slate-300'
                    }`}
                  >
                    {'\u547d\u540d\u89c4\u5219'}
                  </button>
                </div>

                {settingsTab === 'api' && (
                  <div className="space-y-4">
                    <p className="text-xs text-slate-500 mb-3">
                      {'\u652f\u6301\u6240\u6709 OpenAI \u517c\u5bb9\u7684 API\uff0c\u5305\u62ec OpenAI\u3001\u901a\u4e49\u5343\u95ee\u3001DeepSeek\u3001Ollama \u7b49'}
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm text-slate-400 mb-2">API Base URL</label>
                        <input
                          type="text"
                          value={settings.api.baseUrl}
                          onChange={(e) => {
                            const newSettings = { ...settings, api: { ...settings.api, baseUrl: e.target.value } };
                            updateSettings(newSettings);
                          }}
                          placeholder="https://api.openai.com/v1"
                          className="w-full px-4 py-2 bg-slate-700/50 rounded-lg border border-slate-600 focus:border-blue-500 outline-none text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-slate-400 mb-2">API Key</label>
                        <div className="relative">
                          <input
                            type={showApiKey ? 'text' : 'password'}
                            value={settings.api.apiKey}
                            onChange={(e) => {
                              const newSettings = { ...settings, api: { ...settings.api, apiKey: e.target.value } };
                              updateSettings(newSettings);
                            }}
                            placeholder="sk-..."
                            className="w-full px-4 py-2 pr-10 bg-slate-700/50 rounded-lg border border-slate-600 focus:border-blue-500 outline-none text-sm"
                          />
                          <button
                            onClick={() => setShowApiKey(!showApiKey)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-300"
                          >
                            {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm text-slate-400 mb-2">{'\u6587\u672c\u6a21\u578b'}</label>
                        <input
                          type="text"
                          value={settings.api.chatModel}
                          onChange={(e) => {
                            const newSettings = { ...settings, api: { ...settings.api, chatModel: e.target.value } };
                            updateSettings(newSettings);
                          }}
                          placeholder="gpt-4o-mini"
                          className="w-full px-4 py-2 bg-slate-700/50 rounded-lg border border-slate-600 focus:border-blue-500 outline-none text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-slate-400 mb-2">{'\u89c6\u89c9\u6a21\u578b'}</label>
                        <input
                          type="text"
                          value={settings.api.visionModel}
                          onChange={(e) => {
                            const newSettings = { ...settings, api: { ...settings.api, visionModel: e.target.value } };
                            updateSettings(newSettings);
                          }}
                          placeholder="gpt-4o"
                          className="w-full px-4 py-2 bg-slate-700/50 rounded-lg border border-slate-600 focus:border-blue-500 outline-none text-sm"
                        />
                      </div>
                    </div>
                    <div className="mt-3 p-3 bg-slate-900/50 rounded-lg">
                      <p className="text-xs text-slate-500">{'\u5e38\u7528\u914d\u7f6e\u53c2\u8003\uff1a'}</p>
                      <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-slate-400">
                        <div>
                          <span className="text-blue-400">OpenAI:</span> https://api.openai.com/v1
                        </div>
                        <div>
                          <span className="text-blue-400">{'\u901a\u4e49\u5343\u95ee'}:</span> https://dashscope.aliyuncs.com/compatible-mode/v1
                        </div>
                        <div>
                          <span className="text-blue-400">DeepSeek:</span> https://api.deepseek.com/v1
                        </div>
                        <div>
                          <span className="text-blue-400">Ollama ({'\u672c\u5730'}):</span> http://localhost:11434/v1
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {settingsTab === 'rules' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-slate-400 mb-2">{'\u6587\u4ef6\u540d\u524d\u7f00'}</label>
                      <input
                        type="text"
                        value={settings.rules.prefix}
                        onChange={(e) => {
                          const newSettings = { ...settings, rules: { ...settings.rules, prefix: e.target.value } };
                          updateSettings(newSettings);
                        }}
                        placeholder={'\u4f8b\u5982\uff1a\u9879\u76ee'}
                        className="w-full px-4 py-2 bg-slate-700/50 rounded-lg border border-slate-600 focus:border-blue-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-slate-400 mb-2">{'\u6587\u4ef6\u540d\u540e\u7f00'}</label>
                      <input
                        type="text"
                        value={settings.rules.suffix}
                        onChange={(e) => {
                          const newSettings = { ...settings, rules: { ...settings.rules, suffix: e.target.value } };
                          updateSettings(newSettings);
                        }}
                        placeholder={'\u4f8b\u5982\uff1av1'}
                        className="w-full px-4 py-2 bg-slate-700/50 rounded-lg border border-slate-600 focus:border-blue-500 outline-none"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm text-slate-400 mb-2">{'\u81ea\u5b9a\u4e49\u63d0\u793a\u8bcd\uff08\u53ef\u9009\uff09'}</label>
                      <input
                        type="text"
                        value={settings.rules.customPrompt}
                        onChange={(e) => {
                          const newSettings = { ...settings, rules: { ...settings.rules, customPrompt: e.target.value } };
                          updateSettings(newSettings);
                        }}
                        placeholder={'\u4f8b\u5982\uff1a\u5305\u542b\u65e5\u671f\u3001\u7a81\u51fa\u4e3b\u9898\u7b49\u989d\u5916\u8981\u6c42'}
                        className="w-full px-4 py-2 bg-slate-700/50 rounded-lg border border-slate-600 focus:border-blue-500 outline-none"
                      />
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Upload Zone */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`
            relative border-2 border-dashed rounded-2xl p-12 text-center transition-all duration-300 cursor-pointer
            ${isDragging
              ? 'border-blue-500 bg-blue-500/10'
              : 'border-slate-600 bg-slate-800/30 hover:border-slate-500 hover:bg-slate-800/50'
            }
          `}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <motion.div
            animate={isDragging ? { scale: 1.05 } : { scale: 1 }}
            className="flex flex-col items-center gap-4 pointer-events-none"
          >
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center">
              <Upload className="w-10 h-10 text-blue-400" />
            </div>
            <div>
              <p className="text-xl font-medium mb-2">
                {isDragging ? '\u677e\u5f00\u4ee5\u4e0a\u4f20\u6587\u4ef6' : '\u62d6\u62fd\u6587\u4ef6\u5230\u6b64\u5904\u6216\u70b9\u51fb\u4e0a\u4f20'}
              </p>
            </div>
            <p className="text-sm text-slate-500">
              {'\u652f\u6301\u56fe\u7247\u3001\u6587\u6863\u3001\u6587\u672c\u7b49\u591a\u79cd\u683c\u5f0f'}
            </p>
          </motion.div>
        </motion.div>

        {/* File List */}
        <AnimatePresence>
          {files.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-8"
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold">
                  {'\u5f85\u5904\u7406\u6587\u4ef6'} ({completedCount}/{files.length})
                  {renamedCount > 0 && (
                    <span className="ml-2 text-sm text-green-400 font-normal">
                      {'\u5df2\u91cd\u547d\u540d'} {renamedCount}
                    </span>
                  )}
                </h2>
              </div>

              <div className="space-y-3">
                {files.map((file, index) => (
                  <motion.div
                    key={file.id}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    transition={{ delay: index * 0.03 }}
                    className={`rounded-xl p-4 border transition-colors ${
                      file.isRenamed
                        ? 'bg-green-900/20 border-green-700/50'
                        : file.renameError
                        ? 'bg-red-900/10 border-red-700/30'
                        : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-start gap-4">
                      {/* File Preview */}
                      <div className="w-14 h-14 rounded-lg bg-slate-700/50 flex items-center justify-center overflow-hidden flex-shrink-0">
                        {file.isImage && file.preview ? (
                          <img
                            src={file.preview}
                            alt={file.originalName}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          getFileIcon(file.fileType, file.isImage)
                        )}
                      </div>

                      {/* File Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-slate-400 text-sm">{'\u539f\u6587\u4ef6\u540d\uff1a'}</span>
                          <span className="text-slate-300 truncate text-sm">{file.originalName}</span>
                          <span className="text-slate-500 text-xs">({formatFileSize(file.size)})</span>
                          {file.isRenamed && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/20 text-green-400 text-xs rounded-full">
                              <CheckCircle2 className="w-3 h-3" />
                              {'\u5df2\u91cd\u547d\u540d'}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="text-blue-400 text-sm flex-shrink-0">{'\u65b0\u6587\u4ef6\u540d\uff1a'}</span>
                          <div className="flex-1 flex items-center gap-2 min-w-0">
                            {file.isGenerating ? (
                              <div className="flex items-center gap-2 text-slate-400">
                                <RefreshCw className="w-4 h-4 animate-spin flex-shrink-0" />
                                <span className="text-sm truncate">{file.suggestedName || 'AI\u5206\u6790\u4e2d...'}</span>
                              </div>
                            ) : file.isRenamed ? (
                              <span className="text-green-400 font-medium truncate text-sm">
                                {file.suggestedName}
                              </span>
                            ) : file.suggestedName ? (
                              <input
                                type="text"
                                value={file.suggestedName}
                                onChange={(e) => updateSuggestedName(file.id, e.target.value)}
                                className="flex-1 min-w-0 px-2 py-1 bg-slate-700/50 rounded border border-slate-600 focus:border-blue-500 outline-none text-green-400 text-sm font-medium"
                              />
                            ) : file.documentHint ? (
                              <span className="text-amber-400 text-sm">{file.documentHint}</span>
                            ) : (
                              <span className="text-red-400 text-sm">{file.renameError || '\u751f\u6210\u5931\u8d25'}</span>
                            )}

                            {file.suggestedName && !file.isGenerating && (
                              <button
                                onClick={(e) => { e.stopPropagation(); copyToClipboard(file.suggestedName, file.id); }}
                                className="p-1 hover:bg-slate-700 rounded transition-colors flex-shrink-0"
                                title={'\u590d\u5236\u65b0\u6587\u4ef6\u540d'}
                              >
                                {copiedId === file.id ? (
                                  <Check className="w-4 h-4 text-green-400" />
                                ) : (
                                  <Copy className="w-4 h-4 text-slate-400" />
                                )}
                              </button>
                            )}
                          </div>
                        </div>

                        {file.renameError && !file.isRenamed && (
                          <div className="mt-1 text-xs text-red-400 flex items-center gap-1">
                            <AlertCircle className="w-3 h-3" />
                            {file.renameError}
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {isElectron && !file.isGenerating && !file.isRenamed && file.suggestedName && file.filePath && (
                          <button
                            onClick={() => renameFile(file.id)}
                            className="p-2 bg-green-500/20 hover:bg-green-500/30 rounded-lg transition-colors"
                            title={'\u91cd\u547d\u540d'}
                          >
                            <Pencil className="w-4 h-4 text-green-400" />
                          </button>
                        )}
                        {!file.isGenerating && !file.isRenamed && (
                          <button
                            onClick={() => regenerateName(file.id)}
                            className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                            title={'\u91cd\u65b0\u751f\u6210'}
                          >
                            <RefreshCw className="w-4 h-4 text-slate-400" />
                          </button>
                        )}
                        {!file.isRenamed && (
                          <button
                            onClick={() => removeFile(file.id)}
                            className="p-2 hover:bg-red-500/20 rounded-lg transition-colors"
                            title={'\u79fb\u9664'}
                          >
                            <X className="w-4 h-4 text-red-400" />
                          </button>
                        )}
                        {file.isRenamed && isElectron && (
                          <button
                            onClick={() => electronAPI?.openPath(file.filePath)}
                            className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                            title={'\u5728\u6587\u4ef6\u7ba1\u7406\u5668\u4e2d\u663e\u793a'}
                          >
                            <FolderOpen className="w-4 h-4 text-slate-400" />
                          </button>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Feature Cards */}
        {files.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-12 text-center"
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl mx-auto">
              <div className="bg-slate-800/30 rounded-xl p-6 border border-slate-700/50">
                <FileImage className="w-8 h-8 text-blue-400 mx-auto mb-3" />
                <h3 className="font-medium mb-2">{'\u56fe\u7247\u8bc6\u522b'}</h3>
                <p className="text-sm text-slate-400">{'\u81ea\u52a8\u5206\u6790\u56fe\u7247\u5185\u5bb9\uff0c\u751f\u6210\u63cf\u8ff0\u6027\u6587\u4ef6\u540d'}</p>
              </div>
              <div className="bg-slate-800/30 rounded-xl p-6 border border-slate-700/50">
                <FileText className="w-8 h-8 text-purple-400 mx-auto mb-3" />
                <h3 className="font-medium mb-2">{'\u6587\u6863\u5206\u6790'}</h3>
                <p className="text-sm text-slate-400">{'\u63d0\u53d6\u6587\u6863\u5173\u952e\u4fe1\u606f\uff0c\u667a\u80fd\u547d\u540d\u6587\u4ef6'}</p>
              </div>
              <div className="bg-slate-800/30 rounded-xl p-6 border border-slate-700/50">
                <Sparkles className="w-8 h-8 text-pink-400 mx-auto mb-3" />
                <h3 className="font-medium mb-2">{'\u76f4\u63a5\u91cd\u547d\u540d'}</h3>
                <p className="text-sm text-slate-400">{'\u652f\u6301\u76f4\u63a5\u91cd\u547d\u540d\u672c\u5730\u6587\u4ef6\uff0c\u65e0\u9700\u624b\u52a8\u64cd\u4f5c'}</p>
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}

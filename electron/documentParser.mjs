// 文档内容解析器（Electron 主进程）
// - .docx (OpenXML)      -> mammoth 解析 OpenXML 提取纯文本
// - .pdf                 -> pdfjs-dist 逐页提取文本，PDF 分诊：
//                             文本页 -> 提供文本；扫描页(无文本层) -> 渲染成图片供视觉模型
// - 纯文本类             -> 直接按 UTF-8 读取
//
// 说明：本项目为 Electron(Node)，OpenXML/PdfPig 为 .NET 库无法直接引用，
// 故使用同格式的 Node 标准实现：mammoth(OpenXML 解析)、pdfjs-dist(PdfPig 同源算法)。

import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';

// pdfjs v4+ 依赖 Promise.withResolvers（Node>=22）。打包后 Electron 主进程内嵌 Node20，
// 这里补一个兼容垫片（仅当缺失时注入，避免影响系统实现）。
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// 一页判定为“扫描页/图片页”的文本层字符数阈值（去掉空白后）
const SCANNED_MIN_CHARS = 20;
// 扫描页渲染倍率（保证清晰度适中，控制图片体积）
const RENDER_SCALE = 2;
// 单个文本文件最大读取字节数
const MAX_TEXT_BYTES = 200_000;
// 扫描页最多渲染的页数，防止超大文档爆内存
const MAX_SCANNED_RENDER = 12;

const TEXT_EXTS = new Set([
  '.txt', '.md', '.csv', '.tsv', '.log', '.json', '.xml', '.html', '.htm',
  '.ini', '.conf', '.cfg', '.yaml', '.yml', '.properties', '.env',
  '.py', '.js', '.ts', '.jsx', '.tsx', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.java', '.go', '.rs', '.rb', '.php', '.sh', '.bat', '.ps1', '.sql',
  '.gitignore', '.dockerfile',
]);

// 旧版二进制办公文档：无法用 OpenXML/PdfPig 解析，提示用户先另存为新版格式
const LEGACY_DOC_EXTS = new Set(['.doc', '.xls', '.xlt', '.ppt', '.pot', '.wps', '.et', '.dps']);

function legacyDocHint(ext) {
  const map = {
    '.doc': '旧版 Word 文档(.doc) 为二进制格式，无法直接提取文字。请先另存为 .docx 或导出 PDF 后重新上传。',
    '.xls': '旧版 Excel 文档(.xls) 为二进制格式，无法直接提取文字。请先另存为 .xlsx 后重新上传。',
    '.xlt': '旧版 Excel 模板(.xlt) 为二进制格式，无法直接提取文字。请先另存为新版格式后重新上传。',
    '.ppt': '旧版 PowerPoint 文档(.ppt) 为二进制格式，无法直接提取文字。请先另存为 .pptx 后重新上传。',
    '.pot': '旧版 PowerPoint 模板(.pot) 为二进制格式，无法直接提取文字。请先另存为新版格式后重新上传。',
    '.wps': 'WPS 文档(.wps) 为二进制格式，无法直接提取文字。请先另存为 .docx 后重新上传。',
    '.et': 'WPS 表格(.et) 为二进制格式，无法直接提取文字。请先另存为 .xlsx 后重新上传。',
    '.dps': 'WPS 演示(.dps) 为二进制格式，无法直接提取文字。请先另存为 .pptx 后重新上传。',
  };
  return map[ext] || '该旧版办公文档为二进制格式，无法直接提取文字，请先另存为新版格式(.docx/.xlsx/.pptx)或 PDF 后重新上传。';
}

/** 渲染 PDF 指定页为 JPEG dataURL */
async function renderPdfPageToImage(page) {
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));

  const canvas = createCanvas(width, height);
  const canvasContext = canvas.getContext('2d');

  // pdfjs v4+ 在 Node 环境需要 canvasFactory（含 create/reset/destroy）
  const canvasFactory = {
    create: (w, h) => {
      const c = createCanvas(w, h);
      return { canvas: c, context: c.getContext('2d') };
    },
    reset: (c, w, h) => {
      c.canvas.width = w;
      c.canvas.height = h;
    },
    destroy: () => {},
  };

  await page.render({
    canvasContext,
    viewport,
    canvasFactory,
    background: 'rgb(255,255,255)',
  }).promise;

  return canvas.toDataURL('image/jpeg', 0.85);
}

/** 解析 PDF：分诊每页，返回文本页内容与扫描页图片 */
async function parsePdf(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: false,
  }).promise;

  try {
    const numPages = doc.numPages;
    const pages = [];
    const scannedPages = [];
    const textParts = [];

    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let text = '';
      for (const item of tc.items) {
        if ('str' in item) {
          text += item.str + (item.hasEOL ? '\n' : ' ');
        }
      }
      const charCount = text.replace(/\s+/g, '').length;
      const isScanned = charCount < SCANNED_MIN_CHARS;
      pages.push({ index: i, text: text.trim(), charCount, isScanned });
      if (isScanned) {
        scannedPages.push({ index: i, charCount });
      } else {
        textParts.push(text.trim());
      }
      page.cleanup();
    }

    // 渲染扫描页为图片（限量，避免超大文档）
    let rendered = 0;
    for (const sp of scannedPages) {
      if (rendered >= MAX_SCANNED_RENDER) {
        sp.skipped = true;
        continue;
      }
      const page = await doc.getPage(sp.index);
      try {
        sp.imageDataUrl = await renderPdfPageToImage(page);
        rendered++;
      } catch (err) {
        sp.renderError = err instanceof Error ? err.message : String(err);
      }
      page.cleanup();
    }

    const isScanned = scannedPages.length > 0;
    return {
      kind: 'pdf',
      numPages,
      pages,
      scannedPages,
      fullText: textParts.join('\n'),
      isScanned,
    };
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
}

/** 解析 .docx（OpenXML）为纯文本 */
async function parseDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return { kind: 'docx', text: (result.value || '').trim() };
}

/** 按扩展名判断是否由本解析器处理的文档 */
export function isDocumentFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.docx' || ext === '.pdf' || TEXT_EXTS.has(ext);
}

/**
 * 提取文档内容。返回统一结构：
 *  - docx:  { kind:'docx', text }
 *  - pdf:   { kind:'pdf', pages, scannedPages, fullText, isScanned, numPages }
 *  - text:  { kind:'text', text }
 *  - error: { error }
 */
export async function extractDocumentContent(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { error: '无效的文件路径' };
  }
  try {
    if (!fs.existsSync(filePath)) {
      return { error: '文件不存在' };
    }
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.pdf') {
      return await parsePdf(filePath);
    }
    if (ext === '.docx') {
      return await parseDocx(filePath);
    }
    if (TEXT_EXTS.has(ext)) {
      const bytes = fs.readFileSync(filePath);
      const slice = bytes.length > MAX_TEXT_BYTES
        ? bytes.subarray(0, MAX_TEXT_BYTES)
        : bytes;
      return { kind: 'text', text: slice.toString('utf-8').replace(/^\uFEFF/, '') };
    }
    // 旧版二进制办公文档（doc/xls/ppt/wps 等）：给出提示，让用户先转换格式
    if (LEGACY_DOC_EXTS.has(ext)) {
      return { kind: 'legacy-doc', ext, hint: legacyDocHint(ext) };
    }
    // 其余二进制类型暂不支持文本提取
    return { kind: 'unsupported', text: '', hint: '无法读取该文件内容，暂不支持自动命名。' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

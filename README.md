# 🦖 小恐龙 AI 智能文件更名

> 一个本地运行、保护隐私的桌面文件批量更名工具。借助多模态大模型理解文件内容，自动为图片、文档生成清晰、语义化的文件名。

小恐龙工作室出品 · Electron + React

## ✨ 功能特性

- **图片智能更名**：将图片交给视觉模型，自动概括画面内容并生成文件名。
- **文档智能更名**：解析 **docx / PDF / 纯文本**，提取正文要点生成文件名。
- **PDF 扫描版分诊**：自动判断 PDF 是否为扫描版（无文字层）——文字版走大模型文本解析，**扫描版自动交给视觉模型**逐页识别。
- **旧版二进制文档提示**：`.doc/.xls/.ppt/.wps/.et/.dps` 等旧版二进制格式，给出友好提示而不误调 AI。
- **本地优先，隐私可控**：AI 接口地址与密钥完全由你配置，文件内容按你的配置发送。

## 🧠 工作方式

```
文件输入
   │
   ├─ 图片 ──────────────► 视觉模型 ──► 生成文件名
   │
   ├─ docx / 文本 ───────► 文本解析(mammoth) ─► LLM ──► 生成文件名
   │
   ├─ PDF
   │     ├─ 文字版 PDF ──► 文本解析(pdfjs-dist) ─► LLM ──► 生成文件名
   │     └─ 扫描版 PDF ──► 渲染页面为图片 ─► 视觉模型 ──► 生成文件名
   │
   └─ 旧版二进制(.doc/.xls/...) ──► 提示用户（不调用 AI）
```

- **docx**：使用 [mammoth](https://github.com/mammoth/mammoth) 解析 OpenXML 提取正文。
- **PDF**：使用 [pdfjs-dist](https://github.com/mozilla/pdf.js)（与 .NET 的 PdfPig 同源算法）提取文本；按页面文本量自动分诊，扫描页用 [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) 渲染为 JPEG 交给视觉模型。
- **解析实现**：见 `electron/documentParser.mjs`。

## 🛠 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 33 |
| 前端 | React 18 + TypeScript + Tailwind CSS + Framer Motion |
| 构建 | Webpack 5 + Babel |
| 文档解析 | mammoth · pdfjs-dist · @napi-rs/canvas |
| 打包 | electron-builder |

## 📁 项目结构

```
├─ electron/
│  ├─ main.js               # 主进程（含 extract-document IPC）
│  ├─ preload.js            # 预加载桥接
│  └─ documentParser.mjs    # 文档解析器（docx/pdf/文本/分诊）
├─ src/
│  ├─ App.tsx               # 主界面与文档分支逻辑
│  ├─ services/
│  │  ├─ aiService.ts       # 视觉/LLM 流式调用（可配置 OpenAI 兼容接口）
│  │  └─ imageUtils.ts      # 图片压缩
│  └─ types/electron.d.ts   # IPC 类型定义
├─ build/icon.ico           # 应用图标
├─ electron-builder.yml     # 打包配置
└─ package.json
```

## 🚀 快速开始

```bash
# 安装依赖
npm install

# 类型检查
npm run typecheck

# 开发模式（热更新）
npm run dev

# 打包为绿色便携版（免安装，解压即用）
npm run package:dir

# 打包为安装包 + zip
npm run package
```

打包产物输出到 `release/`：
- 绿色版：`release/win-unpacked/小恐龙AI智能文件更名.exe`
- 压缩包：`release/*.zip`

## 💡 使用说明

1. 启动应用后，在**设置**中配置你的 AI 接口（OpenAI 兼容格式）：
   - **接口地址**（Base URL）
   - **API Key**
2. 选择或拖入需要改名的图片 / 文档。
3. 应用自动识别文件类型、理解内容，生成新的文件名；确认后一键批量重命名。

> 提示：AI 服务由你自己配置的接口提供，请根据你的服务商与隐私需求选择合适的接口。

## 📄 许可

本项目 **MIT开源许可证** 。

---

© 2025 小恐龙工作室 · 小恐龙AI智能文件更名

<p align="center">
  <img src="assets/Logo_W.png" alt="OnHands" width="120" />
</p>

<h1 align="center">OnHands3</h1>

<p align="center"><strong>AI-driven smart cursor</strong> — a different way to interact with your desktop.</p>

<p align="center">
  <img src="assets/name.png" alt="OnHands" width="360" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-35-blue" />
  <img src="https://img.shields.io/badge/React-18-61dafb" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178c6" />
  <img src="https://img.shields.io/badge/Platform-Windows%2011-0078d4" />
  <img src="https://img.shields.io/badge/License-MIT-green" />
</p>

---

## What It Does

| Input | Example | Execution |
|-------|---------|-----------|
| 🎤 Long press + voice | "Move these files to a new folder" | Agent (Claude Code) |
| ⌨️ Text input | "Translate to Chinese" | Agent / Direct AI |
| 📂 Select files + long press | "Rename with today's date" | Agent (auto-detects selection) |

**Key capabilities:**
- **Voice recognition** — local Whisper large-v3-turbo, fully offline, good Chinese accuracy
- **Smart routing** — simple Q&A via Direct AI, file ops/coding via Agent CLI
- **Context awareness** — foreground window, working directory, selected files, selected text, clipboard
- **Real-time streaming** — tool calls and text output appear as the agent works
- **ASK protocol** — agent can present choices to the user when intent is ambiguous
- **Media generation** — image/video generation with preview UI
- **Global interrupt** — hold ESC 5s to force kill anytime

---

## What It Does / 功能概览

| 输入方式 | 示例指令 | 执行方式 |
|---------|---------|---------|
| 🎤 长按鼠标 + 语音 | "把这些文件移到新建文件夹" | Agent (Claude Code) |
| ⌨️ 文本输入 | "翻译成中文" | Agent / Direct AI |
| 📂 选中文件 + 长按 | "重命名为今天的日期" | Agent（自动识别选中文件）|

- **语音识别** — 本地 Whisper large-v3-turbo，完全离线
- **智能路由** — 简单问答走 Direct AI，文件操作/编程走 Agent CLI
- **上下文感知** — 自动收集前台窗口、工作目录、选中文件、选中文字、剪贴板
- **实时流** — Agent 执行过程实时显示
- **ASK 协议** — Agent 无法判断意图时弹出选项让用户选择
- **媒体生成** — 支持图片/视频生成，带预览 UI
- **全局中断** — 长按 ESC 5 秒强制退出

---

## System Requirements / 系统要求

| Item | Requirement |
|------|-------------|
| **OS** | Windows 11 (x64) |
| **Node.js** | >= 18.x |
| **Agent CLI** | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (recommended) or Codex / OpenCode |
| **GPU** | Optional — local Whisper can use CPU (slower) or CUDA |
| **Microphone** | Required — for voice input |

> Windows only for now. macOS/Linux needs MouseMonitor Win32 API adaptation.

---

## Installation / 安装

### 1. Clone / 克隆

```bash
git clone https://github.com/jonsams968-cloud/onhands3.git
cd onhands3
npm install
```

### 2. Install Agent CLI / 安装 Agent CLI

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

### 3. Configure / 配置

```bash
cp .env.example .env
```

Edit `.env`:

```env
# AI API (Direct AI fast mode)
AI_API_KEY=your-api-key
AI_BASE_URL=https://apihub.agnes-ai.com/v1
AI_MODEL=agnes-2.0-flash

# Speech-to-text
STT_MODE=local
WHISPER_MODEL=large-v3-turbo

# Long press sensitivity (ms)
LONG_PRESS_DURATION=800

# Force all requests through Agent
FORCE_AGENT=true
```

### 4. Download Whisper Model / 下载 Whisper 模型

For `STT_MODE=local`, download the model file:

- Path: `%APPDATA%/onhands3/data/whisper/`
- Download [ggml-large-v3-turbo.bin](https://huggingface.co/ggerganov/whisper.cpp/tree/main) (~1.5GB)
- whisper-cli.exe auto-downloads from [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases)

Manual placement:
```
%APPDATA%/onhands3/data/whisper/
├── Release/
│   └── whisper-cli.exe
└── ggml-large-v3-turbo.bin
```

---

## Usage / 使用

### Dev Mode / 开发模式

```bash
npm run dev
```

> If launching from inside an Electron app (e.g. CherryStudio), run `unset ELECTRON_RUN_AS_NODE` first.

### Controls / 操作

1. **Long press** (default 800ms) → start recording → release to transcribe
2. **Click input button** → switch to text input mode
3. **Hold ESC 5s** → force kill
4. **Test shortcuts**:
   - `Ctrl+Shift+1` — simulate recording
   - `Ctrl+Shift+2` — simulate transcription
   - `Ctrl+Shift+3` — simulate routing
   - `Ctrl+Shift+4` — simulate execution with streaming
   - `Ctrl+Shift+0` — hide window

### Build / 构建

```bash
npm run build
npm run preview
```

---

## Architecture / 项目架构

```
src/
├── main/                          # Electron main process
│   ├── index.ts                   # Window creation, global shortcuts, IPC
│   ├── config.ts                  # Environment config loader
│   ├── orchestrator/
│   │   └── Orchestrator.ts        # Core: voice → route → execute → result
│   ├── agents/
│   │   ├── ClaudeCodeAgent.ts     # Claude Code CLI wrapper (stream-json)
│   │   └── AgentDetector.ts       # Auto-detect installed Agent CLIs
│   ├── ai/
│   │   ├── DirectAI.ts            # Direct AI API (quick tasks)
│   │   └── Router.ts              # Command routing: direct vs agent
│   ├── input/
│   │   ├── MouseMonitor.ts        # Mouse long-press detection (GetAsyncKeyState poll)
│   │   └── SelectionMonitor.ts    # Text selection capture (child process + selection-hook)
│   ├── context/
│   │   └── ContextCollector.ts    # Context: window, selected files/text, clipboard
│   ├── stt/
│   │   └── WhisperSTT.ts          # STT: local whisper.cpp / cloud Whisper API
│   └── permission/
│       └── PermissionServer.ts    # Dangerous operation approval system
├── renderer/                      # Renderer process (React)
│   ├── App.tsx                    # UI state machine + glassmorphism overlay
│   ├── hooks/useVoiceRecorder.ts  # Microphone recording (MediaRecorder API)
│   └── styles.css                 # All styles (no Tailwind)
├── preload/
│   └── index.ts                   # IPC bridge (contextBridge)
├── shared/
│   └── types.ts                   # Shared type definitions
scripts/
└── selection-worker.cjs           # selection-hook worker (runs in child process)
```

### Execution Flow / 执行流程

```
Long press → hide overlay → capture foreground window → show recording UI
    ↓
Release → audio data via IPC → Whisper STT transcription
    ↓
Route (Direct AI / Agent CLI)
    ↓
Collect context (window, selected text, files, clipboard, working dir)
    ↓
Execute → stream output → show result / auto-hide after 12s
```

---

## Tech Stack / 技术栈

| Layer | Technology |
|-------|-----------|
| Framework | Electron 35 + electron-vite 3 |
| UI | React 18 + TypeScript 5.7 |
| STT | whisper.cpp (local) / OpenAI Whisper API (cloud) |
| Agent | Claude Code CLI (stream-json mode) |
| Text selection | selection-hook via child process (UIA + IAccessible + Clipboard fallback) |
| Window capture | Win32 API via koffi (GetForegroundWindow, Shell COM) |
| Mouse input | Win32 API via koffi (GetAsyncKeyState polling) |
| Audio | ffmpeg-static (webm → wav conversion) |

---

## Config Reference / 配置说明

| Variable | Description | Default |
|----------|-------------|---------|
| `AI_API_KEY` | Direct AI API key | - |
| `AI_BASE_URL` | AI API endpoint | `https://apihub.agnes-ai.com/v1` |
| `AI_MODEL` | AI model name | `agnes-2.0-flash` |
| `STT_MODE` | STT mode: `local` / `cloud` | `local` |
| `WHISPER_MODEL` | Whisper model size | `large-v3-turbo` |
| `LONG_PRESS_DURATION` | Long press threshold (ms) | `800` |
| `DRAG_THRESHOLD_PX` | Drag detection threshold (px) | `15` |
| `FORCE_AGENT` | Force all requests to Agent | `false` |

---

## Known Issues / 已知问题

- **White title bar flash** — Electron 35 bug (#47946), DWM briefly draws white chrome on focus change. Fixed in Electron 37.3.1+
- **Agent encoding** — Chinese path operations occasionally hit UTF-8 issues. Mitigated with single-quote wrapping + UTF-8 prefix
- **Windows only** — MouseMonitor uses Win32 API. macOS/Linux needs reimplementation
- **GPU cache** — If app exits immediately with GPU cache errors, delete `%LOCALAPPDATA%/OnHands3/GPUCache` and restart

---

## Version History / 版本历史

| Version | Date | Summary |
|---------|------|---------|
| v0.47 | 2026-06-08 | selection-hook replaces Ctrl+C for text selection capture |
| v0.46 | 2026-06-07 | ASK protocol — agent can present choices to user |
| v0.45 | 2026-06-07 | Permission API with proper Chinese encoding |
| v0.44 | 2026-06-06 | Permission server + Shell COM merge |
| v0.43 | 2026-06-06 | Fix foreground capture on re-trigger + img2img mode |
| v0.42 | 2026-06-05 | Universal media preview + selected image context |

---

## Acknowledgments / 致谢

- [**Multica**](https://github.com/multica-ai/multica) — AI desktop assistant framework
- [**selection-hook**](https://github.com/0xfullex/selection-hook) — cross-platform text selection detection

---

## License

MIT

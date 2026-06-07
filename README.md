<p align="center">
  <img src="assets/name.png" alt="OnHands" width="480" />
</p>

# OnHands3

**AI 驱动的智能光标** — 鼠标长按触发语音/文字指令，由 AI Agent 执行桌面操作。

<p align="center">
  <img src="https://img.shields.io/badge/Electron-35-blue" />
  <img src="https://img.shields.io/badge/React-18-61dafb" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178c6" />
  <img src="https://img.shields.io/badge/Platform-Windows%2011-0078d4" />
  <img src="https://img.shields.io/badge/License-MIT-green" />
</p>

---

## 它能做什么？

| 操作方式 | 示例指令 | 执行方式 |
|---------|---------|---------|
| 🎤 长按鼠标 + 语音 | "把这些文件移到新建文件夹" | Agent (Claude Code) |
| ⌨️ 文本输入 | "翻译成中文" | Agent / Direct AI |
| 📂 选中文件 + 长按 | "重命名为今天的日期" | Agent（自动识别选中文件）|

**核心功能：**
- **语音识别** — 本地 Whisper large-v3-turbo 模型，完全离线，中文识别率高
- **智能路由** — 简单问答走 Direct AI，文件操作/编程走 Agent CLI
- **上下文感知** — 自动识别当前窗口、工作目录、选中文件、剪贴板内容
- **实时流** — Agent 执行过程实时显示工具调用和文本输出
- **全局中断** — 双击 ESC 随时终止执行

---

## 系统要求

| 项目 | 要求 |
|------|------|
| **操作系统** | Windows 11（x64） |
| **Node.js** | >= 18.x |
| **Agent CLI** | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (推荐) 或 Codex / OpenCode |
| **GPU** | 可选 — 本地 Whisper 推理可用 CPU（较慢）或 CUDA |
| **麦克风** | 需要 — 用于语音输入 |

> ⚠️ 目前仅支持 Windows。macOS/Linux 需要适配 MouseMonitor 的 Win32 API 调用。

---

## 安装

### 1. 克隆仓库

```bash
git clone https://github.com/jonsams968-cloud/onhands3.git
cd onhands3
npm install
```

### 2. 安装 Agent CLI（推荐 Claude Code）

```bash
npm install -g @anthropic-ai/claude-code
```

确保 `claude` 命令在 PATH 中：
```bash
claude --version
```

### 3. 配置环境变量

复制示例配置并填写：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
# AI API（用于 Direct AI 快速模式）
AI_API_KEY=你的API密钥
AI_BASE_URL=https://apihub.agnes-ai.com/v1
AI_MODEL=agnes-2.0-flash

# 语音转写
STT_MODE=local                    # local 或 cloud
WHISPER_MODEL=large-v3-turbo      # tiny / base / medium / large-v3-turbo

# 长按灵敏度（毫秒）
LONG_PRESS_DURATION=800

# 路由：强制所有请求走 Agent（DirectAI 不稳定时启用）
FORCE_AGENT=true
```

### 4. 下载 Whisper 模型（本地 STT）

首次使用 `STT_MODE=local` 时，需要下载模型文件：

- 模型存放路径：`%APPDATA%/onhands3/data/whisper/`
- 下载 [ggml-large-v3-turbo.bin](https://huggingface.co/ggerganov/whisper.cpp/tree/main)（~1.5GB）
- whisper-cli.exe 会自动从 [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) 下载

手动放置：
```
%APPDATA%/onhands3/data/whisper/
├── Release/
│   └── whisper-cli.exe      # whisper.cpp CLI
└── ggml-large-v3-turbo.bin  # 模型文件
```

---

## 使用

### 启动开发模式

```bash
npm run dev
```

> 如果从 Electron 应用（如 CherryStudio）内启动，需要先 `unset ELECTRON_RUN_AS_NODE`。

### 操作方式

1. **长按鼠标**（默认 800ms）→ 触发录音 → 松开后自动识别
2. **点击输入按钮** → 切换到文本输入模式
3. **双击 ESC** → 全局中断，终止当前任务
4. **测试快捷键**：
   - `Ctrl+Shift+1` — 模拟录音状态
   - `Ctrl+Shift+2` — 模拟识别结果
   - `Ctrl+Shift+3` — 模拟路由
   - `Ctrl+Shift+4` — 模拟执行（含流输出）
   - `Ctrl+Shift+0` — 隐藏窗口

### 构建生产版本

```bash
npm run build
npm run preview
```

---

## 项目架构

```
src/
├── main/                          # Electron 主进程
│   ├── index.ts                   # 窗口创建、全局快捷键、IPC 注册
│   ├── config.ts                  # 环境配置加载
│   ├── orchestrator/
│   │   └── Orchestrator.ts        # 核心编排器：语音→路由→执行→结果
│   ├── agents/
│   │   ├── ClaudeCodeAgent.ts     # Claude Code CLI 封装（stream-json）
│   │   └── AgentDetector.ts       # 自动检测已安装的 Agent CLI
│   ├── ai/
│   │   ├── DirectAI.ts            # 直连 AI API（翻译、问答等快速任务）
│   │   └── Router.ts              # 指令路由：direct vs agent
│   ├── input/
│   │   └── MouseMonitor.ts        # 全局鼠标监听（Win32 API 长按检测）
│   ├── context/
│   │   └── ContextCollector.ts    # 上下文收集：窗口、选中文件、剪贴板
│   ├── stt/
│   │   └── WhisperSTT.ts          # 语音转写：本地 whisper.cpp / 云端 Whisper API
│   └── utils/
│       └── spawn-utf8.ts          # UTF-8 编码子进程工具
├── renderer/                      # 渲染进程（React）
│   ├── App.tsx                    # UI 状态机 + 毛玻璃悬浮窗
│   ├── hooks/useVoiceRecorder.ts  # 麦克风录音 Hook（MediaRecorder API）
│   ├── styles.css                 # 全部样式（无 Tailwind 依赖）
│   └── index.html
├── preload/
│   └── index.ts                   # IPC 桥接（contextBridge）
└── shared/
    └── types.ts                   # 共享类型定义
```

### 执行流程

```
长按鼠标 → 隐藏窗口 → 捕获前台窗口信息 → 显示录音 UI
    ↓
松开鼠标 → 录音数据 IPC → Whisper STT 转写
    ↓
路由判断（Direct AI / Agent CLI）
    ↓
收集上下文（窗口、选中文件、剪贴板、工作目录）
    ↓
执行 → 实时流输出 → 显示结果 / 12秒后自动隐藏
```

---

## 技术栈

| 层 | 技术 |
|----|------|
| 框架 | Electron 35 + electron-vite 3 |
| UI | React 18 + TypeScript 5.7 |
| 语音识别 | whisper.cpp（本地）/ OpenAI Whisper API（云端） |
| Agent | Claude Code CLI（stream-json 模式） |
| 窗口捕获 | Win32 API via koffi（GetForegroundWindow, Shell COM） |
| 鼠标监听 | Win32 API via koffi（SetWindowsHookEx, 全局钩子） |
| 音频处理 | ffmpeg-static（webm → wav 转换） |

---

## 配置说明

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `AI_API_KEY` | Direct AI 的 API 密钥 | - |
| `AI_BASE_URL` | AI API 地址 | `https://apihub.agnes-ai.com/v1` |
| `AI_MODEL` | AI 模型名称 | `agnes-2.0-flash` |
| `STT_MODE` | 语音转写模式：`local` / `cloud` | `local` |
| `WHISPER_MODEL` | Whisper 模型：`tiny` / `base` / `medium` / `large-v3-turbo` | `large-v3-turbo` |
| `LONG_PRESS_DURATION` | 长按触发时间（毫秒） | `800` |
| `DRAG_THRESHOLD_PX` | 拖拽判定阈值（像素） | `15` |
| `FORCE_AGENT` | 强制所有请求走 Agent（`true`/`false`） | `false` |

---

## 已知问题

- **白色标题框** — Electron 35 的已知 bug（#47946），窗口失焦时 DWM 可能短暂显示白色边框，升级到 Electron 37.3.1+ 可修复
- **Agent 编码** — 中文路径文件操作偶尔出现 UTF-8 编码问题，已通过单引号包裹 + UTF-8 前缀缓解
- **仅 Windows** — MouseMonitor 使用 Win32 全局钩子，macOS/Linux 需重新实现

---

## License

MIT

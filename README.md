# 📚 收藏到就是学到

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/H2T024VDBG)

> 一款 Chrome 浏览器扩展，在你收藏 X (Twitter) 内容时，自动生成 AI 摘要并保存为本地 Markdown 文件，让每次收藏都变成一次学习。

[English](#english) | 中文

<a href="https://x.com/JamesAI/status/2021089989136875810">查看 X 发布帖</a>

### 演示视频

<video src="assets/demo.mp4" width="100%" controls></video>

---

## 功能特点

- **一键摘要** — 点击收藏按钮，自动生成结构化 TLDR 摘要（要点提炼、步骤流程、事实核查评分）
- **AI 开关** — 一键关闭 AI 摘要和事实核查，仅保存原文 + 元数据到 Markdown（无需 API Key），默认开启
- **原文模式** — 支持切换为原文模式，跳过 AI 摘要，直接保存完整原文到 Markdown（无需 API Key）
- **多模型支持** — 支持 OpenAI (GPT)、Claude (Anthropic)、Kimi (月之暗面)、智谱 (GLM)，以及本地 Claude CLI（无需 API Key）
- **自定义 Base URL** — 支持配置中转 API 地址，可走私有网关或代理服务
- **深度内容提取** — 自动展开"显示更多"折叠内容，支持 X Articles 长文、引用/转发长帖的全文抓取
- **卡片堆叠** — 支持连续快速收藏，多张 TLDR 卡片同时显示，互不阻塞
- **历史记录** — 自动保存所有摘要，随时回顾，附带原帖链接
- **Markdown 归档** — 每次收藏自动下载 Markdown 文件到本地，包含 TLDR + 原文，方便知识管理
- **自定义保存路径** — 通过 Native Helper 可选择任意本地文件夹保存 Markdown 文件
- **多语言摘要** — 支持简体中文、繁體中文、English、日本語、한국어
- **深色模式** — 跟随系统偏好自动切换，支持手动切换（自动/浅色/深色）
- **事实核查** — 每条摘要末尾附带可信度评分 (1-10)
- **安全存储** — API Key 通过 AES-GCM 加密存储在本地，不会同步到云端

## 安装方法

1. 下载或克隆本仓库：
   ```bash
   git clone git@github.com:iamzifei/bookmark-is-learned.git
   ```
2. 打开 Chrome，进入 `chrome://extensions/`
3. 开启右上角的 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择项目文件夹
5. 点击浏览器工具栏中的扩展图标，填写你的 API Key 并保存

## 使用方法

1. **设置** — 点击扩展图标，选择 AI 模型，填入 API Key，选择摘要语言和保存模式
2. **AI 开关** — 在 AI 服务配置区域右侧有一个开关，关闭后收藏时仅保存原文和元数据，不调用 AI
3. **选择模式** — TLDR 摘要模式（默认）会生成 AI 摘要；原文模式直接保存完整原文
4. **收藏** — 在 X (Twitter) 时间线上，点击任意推文的收藏/书签按钮
5. **阅读摘要** — 页面右下角会弹出 TLDR 卡片，包含要点提炼和事实核查
6. **查看历史** — 点击扩展图标，切换到「历史记录」标签页
7. **本地归档** — 每次收藏自动下载 Markdown 文件到本地

### 自定义保存路径（可选）

默认保存到 `Downloads/bookmark-is-learned/` 目录。如需保存到其他文件夹：

1. 在高级设置中点击「一键下载安装脚本」
2. 在终端运行 `bash ~/Downloads/install-btl-native.sh`
3. 重启浏览器
4. 在高级设置中点击「选择文件夹」，选择任意本地目录

## 保存模式

| 模式 | 说明 |
|------|------|
| AI 开启 + TLDR 摘要模式 | 调用 AI 生成结构化摘要，Markdown 包含 TLDR + 原文（需要 API Key） |
| AI 开启 + 原文模式 | 调用 AI 生成摘要，Markdown 包含 TLDR + 完整原文；若帖子含引用链接（含链接预览卡片），会在 `Referenced Links` 小节附上可点击链接（需要 API Key） |
| AI 关闭 | 不调用 AI，Markdown 仅保存元数据 + 完整原文；若帖子含引用链接（含链接预览卡片），会在 `Referenced Links` 小节附上可点击链接（无需 API Key） |

## 支持的内容类型

| 类型 | 说明 |
|------|------|
| 普通推文 | 提取推文全文生成摘要 |
| 长推文 | 自动展开"显示更多"获取完整内容 |
| X Articles | 后台抓取长文全文，生成详细摘要 |
| 引用/转发帖 | 自动获取被引用帖的完整内容一并总结 |
| 帖子串 (Thread) | 后台抓取整个 Thread 内容 |

## Markdown 文件格式

每次收藏会自动保存一个 `.md` 文件，文件结构如下：

**TLDR 摘要模式：**
```markdown
# 作者名 或 文章标题

> **Author**: 作者名
> **Source**: https://x.com/user/status/123456
> **Date**: 2025-01-15 14:30

---

## TLDR

AI 生成的结构化摘要（要点、流程、事实核查评分）

---

## Original Content

原文完整内容

### Quoted Content (by 被引用作者)

被引用/转发的完整内容（如有）

### Referenced Links

- [https://github.com/volcengine/OpenViking](https://github.com/volcengine/OpenViking)
```

**原文模式：**
```markdown
# 作者名 或 文章标题

> **Author**: 作者名
> **Source**: https://x.com/user/status/123456
> **Date**: 2025-01-15 14:30

---

## TLDR

AI 生成的结构化摘要

---

## Original Content

原文完整内容

### Quoted Content (by 被引用作者)

被引用/转发的完整内容（如有）

### Referenced Links

- [https://github.com/volcengine/OpenViking](https://github.com/volcengine/OpenViking)
```

**AI 关闭模式：**
```markdown
# 作者名 或 文章标题

> **Author**: 作者名
> **Source**: https://x.com/user/status/123456
> **Date**: 2025-01-15 14:30

---

## Original Content

原文完整内容

### Quoted Content (by 被引用作者)

被引用/转发的完整内容（如有）

### Referenced Links

- [https://github.com/volcengine/OpenViking](https://github.com/volcengine/OpenViking)
```

## 工作原理

```
用户点击收藏 → 内容脚本检测点击 → 提取推文内容（展开折叠、抓取全文）
     ↓
后台脚本接收 → 如有长文/引用帖，后台标签页抓取完整内容
     ↓
┌─ AI 开启 ────────────────────────────────────┐
│  调用 LLM API → 生成结构化 TLDR 摘要         │
└──────────────────────────────────────────────┘
┌─ AI 关闭 ────────────────────────────────────┐
│  跳过 API 调用，仅保存原文 + 元数据          │
└──────────────────────────────────────────────┘
     ↓
┌─────────────────────────────────────────┐
│  ① 页面右下角弹出卡片                  │
│  ② 保存到插件历史记录                   │
│  ③ 下载 Markdown 文件到本地             │
└─────────────────────────────────────────┘
```

## 默认模型

| 模型提供商 | 默认模型 |
|-----------|---------|
| OpenAI | `gpt-4o-mini` |
| Claude | `claude-sonnet-4-20250514` |
| Kimi | `moonshot-v1-8k` |
| 智谱 | `glm-4-flash` |
| 本地 Claude | 自动（使用本机 Claude CLI） |

可在设置中自定义模型版本（如 `gpt-4o`、`claude-opus-4-20250514` 等）。

本地 Claude 使用已安装的 Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)，无需 API Key，需先完成 CLI 登录认证并安装 Native Helper。

可选配置 `Base URL` 以使用中转服务：
- 填写 `https://your-proxy.com/v1` 时，将自动补全为对应模型接口
- 也可直接填写完整接口地址，如 `https://your-proxy.com/v1/chat/completions`
- 首次保存会弹出权限授权，用于访问你填写的域名

## 项目结构

```
bookmark-is-learned/
├── manifest.json          # Chrome 扩展配置 (Manifest V3)
├── background.js          # 后台 Service Worker（API 调用、内容抓取、历史保存、Markdown 下载）
├── content.js             # 内容脚本（收藏检测、DOM 提取、卡片 UI）
├── content.css            # 内容脚本样式（卡片堆叠、深色模式）
├── popup.html             # 弹出页面（设置 + 历史记录）
├── popup.js               # 弹出页面逻辑（标签切换、历史浏览）
├── popup.css              # 弹出页面样式
├── native-host/           # Native Messaging Host（自定义文件夹写入）
│   └── btl_file_writer.py
└── icons/                 # 扩展图标
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## API Key 获取

| 模型 | 获取地址 |
|------|---------|
| OpenAI | https://platform.openai.com/api-keys |
| Claude | https://console.anthropic.com/settings/keys |
| Kimi | https://platform.moonshot.cn/console/api-keys |
| 智谱 | https://open.bigmodel.cn/usercenter/apikeys |

## 许可证

MIT License

---

<a name="english"></a>

# 📚 Bookmark Is Learned

> A Chrome extension that automatically generates AI-powered TLDR summaries and saves local Markdown files when you bookmark content on X (Twitter) — turning every bookmark into a learning moment.

[中文](#) | English

<a href="https://x.com/JamesAI/status/2021089989136875810">View on X</a>

### Demo

<video src="assets/demo.mp4" width="100%" controls></video>

---

## Features

- **One-Click Summaries** — Bookmark a post and instantly get a structured TLDR (key points, step-by-step processes, fact-check scoring)
- **AI Toggle** — Disable AI summarization and fact-checking with one click — saves only original text + metadata to Markdown (no API Key needed), enabled by default
- **Original Text Mode** — Switch to Original mode to save the full original text directly to Markdown without AI summarization (no API Key required)
- **Multi-Model Support** — Choose between OpenAI (GPT), Claude (Anthropic), Kimi (Moonshot), Zhipu (GLM), and Local Claude CLI (no API Key needed)
- **Custom Base URL** — Route requests through your API proxy or private gateway
- **Deep Content Extraction** — Auto-expands "Show more" truncated text, fetches full X Articles, and retrieves complete quoted/retweeted long posts
- **Card Stacking** — Bookmark multiple posts in rapid succession — each TLDR loads independently as a stacked card
- **History** — All summaries are saved automatically with links back to the original posts
- **Markdown Export** — Each bookmark is automatically saved as a local Markdown file (TLDR + original content) for knowledge management
- **Custom Save Path** — Install the Native Helper to save Markdown files to any local folder
- **Multi-Language** — Summaries available in Simplified Chinese, Traditional Chinese, English, Japanese, and Korean
- **Dark Mode** — Follows your system preference automatically, with manual toggle (auto/light/dark)
- **Fact Check** — Every summary includes a credibility score (1-10)
- **Secure Storage** — API Keys are encrypted via AES-GCM and stored locally only (never synced to the cloud)

## Installation

1. Clone this repository:
   ```bash
   git clone git@github.com:iamzifei/bookmark-is-learned.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the project folder
5. Click the extension icon in the toolbar, enter your API key, and save

## Usage

1. **Configure** — Click the extension icon, select your AI model, enter your API key, choose the summary language and save mode
2. **AI Toggle** — Use the toggle switch in the AI config section to enable/disable AI; when off, bookmarks save only original text and metadata
3. **Choose Mode** — TLDR mode (default) generates AI summaries; Original mode saves full original text
4. **Bookmark** — On the X (Twitter) timeline, click the bookmark button on any post
5. **Read** — A TLDR card appears at the bottom-right corner with key insights and a fact-check score
6. **Browse History** — Click the extension icon and switch to the "History" tab
7. **Local Archive** — Each bookmark is automatically saved as a Markdown file locally

### Custom Save Path (Optional)

By default, files are saved to `Downloads/bookmark-is-learned/`. To use a custom folder:

1. Click "Download install script" in Advanced Settings
2. Run `bash ~/Downloads/install-btl-native.sh` in Terminal
3. Restart your browser
4. Click "Choose Folder" in Advanced Settings to select any local directory

## Save Modes

| Mode | Description |
|------|-------------|
| AI On + TLDR Mode | Calls AI to generate structured summaries; Markdown includes TLDR + original text (requires API Key) |
| AI On + Original Mode | Calls AI to generate summaries; Markdown includes TLDR + full original text. If the post contains referenced links (including link-preview cards), they are appended under `Referenced Links` as clickable URLs (requires API Key) |
| AI Off | Skips AI entirely; Markdown saves only metadata + full original text. If the post contains referenced links (including link-preview cards), they are appended under `Referenced Links` as clickable URLs (no API Key required) |

## Supported Content Types

| Type | Description |
|------|-------------|
| Regular tweets | Extracts full tweet text for summarization |
| Long tweets | Auto-expands "Show more" to get complete content |
| X Articles | Fetches the full long-form article in a background tab |
| Quoted/Retweeted posts | Fetches the complete quoted post and summarizes both |
| Threads | Fetches the full thread content from the background |

## Markdown File Format

Each bookmark automatically saves a `.md` file:

**TLDR Mode:**
```markdown
# Author Name or Article Title

> **Author**: Author Name
> **Source**: https://x.com/user/status/123456
> **Date**: 2025-01-15 14:30

---

## TLDR

AI-generated structured summary (key points, processes, fact-check score)

---

## Original Content

Full original text

### Quoted Content (by Quoted Author)

Full quoted/retweeted content (if applicable)

### Referenced Links

- [https://github.com/volcengine/OpenViking](https://github.com/volcengine/OpenViking)
```

**Original Mode:**
```markdown
# Author Name or Article Title

> **Author**: Author Name
> **Source**: https://x.com/user/status/123456
> **Date**: 2025-01-15 14:30

---

## TLDR

AI-generated structured summary

---

## Original Content

Full original text

### Quoted Content (by Quoted Author)

Full quoted/retweeted content (if applicable)

### Referenced Links

- [https://github.com/volcengine/OpenViking](https://github.com/volcengine/OpenViking)
```

**AI Off Mode:**
```markdown
# Author Name or Article Title

> **Author**: Author Name
> **Source**: https://x.com/user/status/123456
> **Date**: 2025-01-15 14:30

---

## Original Content

Full original text

### Quoted Content (by Quoted Author)

Full quoted/retweeted content (if applicable)

### Referenced Links

- [https://github.com/volcengine/OpenViking](https://github.com/volcengine/OpenViking)
```

## How It Works

```
User clicks bookmark → Content script detects click → Extract tweet (expand, fetch full text)
     ↓
Background receives → If article/quoted post, fetch full content via background tab
     ↓
┌─ AI On ──────────────────────────────────────┐
│  Call LLM API → Generate structured TLDR      │
└───────────────────────────────────────────────┘
┌─ AI Off ─────────────────────────────────────┐
│  Skip API call, save original text + metadata │
└───────────────────────────────────────────────┘
     ↓
┌──────────────────────────────────────────────────┐
│  ① Show card at bottom-right of page             │
│  ② Save to extension history                     │
│  ③ Download Markdown file to local disk           │
└──────────────────────────────────────────────────┘
```

## Default Models

| Provider | Default Model |
|----------|--------------|
| OpenAI | `gpt-4o-mini` |
| Claude | `claude-sonnet-4-20250514` |
| Kimi | `moonshot-v1-8k` |
| Zhipu | `glm-4-flash` |
| Local Claude | Auto (uses local Claude CLI) |

You can override the model version in settings (e.g. `gpt-4o`, `claude-opus-4-20250514`).

Local Claude uses the installed Claude Code CLI (`npm install -g @anthropic-ai/claude-code`). No API Key required — just complete CLI authentication first and install the Native Helper.

Optional `Base URL` for proxy routing:
- `https://your-proxy.com/v1` will be expanded to the model-specific endpoint
- Full endpoint is also supported, e.g. `https://your-proxy.com/v1/chat/completions`
- The first save triggers a permission prompt for the custom domain

## Project Structure

```
bookmark-is-learned/
├── manifest.json          # Chrome extension config (Manifest V3)
├── background.js          # Service worker (API calls, content fetching, history, Markdown download)
├── content.js             # Content script (bookmark detection, DOM extraction, card UI)
├── content.css            # Content script styles (card stacking, dark mode)
├── popup.html             # Popup page (settings + history tabs)
├── popup.js               # Popup page logic (tab switching, history browsing)
├── popup.css              # Popup page styles
├── native-host/           # Native Messaging Host (custom folder writing)
│   └── btl_file_writer.py
└── icons/                 # Extension icons
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Getting API Keys

| Provider | URL |
|----------|-----|
| OpenAI | https://platform.openai.com/api-keys |
| Claude | https://console.anthropic.com/settings/keys |
| Kimi | https://platform.moonshot.cn/console/api-keys |
| Zhipu | https://open.bigmodel.cn/usercenter/apikeys |

## License

MIT License

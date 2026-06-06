# cc-linker

> 让手机聊天应用和终端（Claude Code CLI）之间的对话切换，像切换设备一样无缝。
>
> **目前已接入飞书**，更多聊天平台持续扩展中。

[![npm version](https://img.shields.io/npm/v/cc-linker)](https://www.npmjs.com/package/cc-linker)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**语言:** 中文 | [English](README_en.md)

## 💡 为什么需要 cc-linker？

你是否遇到过这样的场景：

- **通勤路上用手机聊，到公司终端继续** — 地铁上用手机飞书给 Bot 发消息讨论技术方案，到公司打开终端 `cc-linker list` 找到会话，`resume` 一键恢复上下文
- **飞书快速提问，终端深度调试** — 在飞书里快速问了个 API 用法，发现需要本地调试，终端 `cc-linker resume` 切换到同一会话继续让 Claude 帮你写代码
- **多项目并行，会话不乱** — 同时在 `project-a` 和 `project-b` 两个目录与 Claude 对话，`/list` 清晰展示每个会话的目录和状态，卡片按钮一键切换不混淆

**cc-linker 就是解决这些痛点的桥接工具。** 它在你电脑上维护一个统一的会话注册表，让手机聊天应用和 Claude Code CLI 共享同一套会话状态——无论你在哪个端发起对话，都能无缝切换到另一端继续。

> **当前已接入飞书**，更多聊天平台持续扩展中。

## ✨ 核心特性

| 特性 | 说明 |
|------|------|
| 🔄 **跨端无缝切换** | 聊天应用发起的对话，终端一键恢复（含上下文和目录）；终端创建的会话，聊天应用随时查看 |
| 💬 **流式卡片交互** | 聊天应用中实时看到 Claude 的 thinking 和回复，不再是"转圈等待" |
| 🛡 **交互式权限确认** | SDK 模式下 Claude 需要执行工具时，飞书卡片弹出允许/拒绝按钮 |
| 🖼 **图片消息支持** | 飞书发送的图片自动下载并传递给 Claude 分析 |
| 📂 **目录浏览** | `/listDir` 命令交互式浏览和切换工作目录 |
| 📋 **统一会话管理** | 自动扫描、增量同步，无需手动维护会话列表 |
| 🎛 **多模型切换** | 在卡片中一键切换模型，无需改配置 |
| 💾 **持久化不丢消息** | 文件级消息队列，进程崩溃、重启后消息不丢失 |
| 🚀 **3 步上手** | `install → setup → start`，5 分钟完成配置 |

## 📸 效果展示

### 聊天应用端体验（飞书）

> 当前已支持飞书，更多平台开发中。

<table>
  <tr>
    <td align="center"><b>会话列表</b><br><code>/list</code> 查看所有会话</td>
    <td align="center"><b>开始处理</b><br>消息发出后即时反馈</td>
    <td align="center"><b>流式实时反馈</b><br>实时看到 thinking 过程</td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/feishu-list.png" alt="飞书会话列表" width="280"></td>
    <td align="center"><img src="docs/images/feishu-start-processing.png" alt="开始处理" width="280"></td>
    <td align="center"><img src="docs/images/feishu-streaming-thinking.png" alt="流式 thinking" width="280"></td>
  </tr>
</table>

<table>
  <tr>
    <td align="center"><b>处理完成</b><br>token / 耗时 / 轮数统计</td>
    <td align="center"><b>处理完成（长回复）</b><br>长文本同样展示</td>
    <td align="center"><b>模型切换</b><br>卡片按钮一键切换</td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/feishu-complete.png" alt="处理完成" width="280"></td>
    <td align="center"><img src="docs/images/feishu-complete-long.png" alt="处理完成-长回复" width="280"></td>
    <td align="center"><img src="docs/images/feishu-model.png" alt="模型选择" width="280"></td>
  </tr>
</table>

<table>
  <tr>
    <td align="center"><b>目录浏览</b><br><code>/listDir</code> 交互式浏览文件系统</td>
    <td align="center"><b>SDK 权限确认</b><br>交互式允许/拒绝 Claude 的工具调用</td>
    <td align="center"><b>图片消息</b><br>飞书发送图片，Claude 自动分析</td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/feishu-listdir.png" alt="目录浏览" width="280"></td>
    <td align="center"><img src="docs/images/feishu-sdk-permission-card.png" alt="SDK 权限确认" width="280"></td>
    <td align="center"><img src="docs/images/feishu-image-analysis.png" alt="图片消息分析" width="280"></td>
  </tr>
</table>

### 终端端体验

**查看所有会话** — 清晰的表格展示，状态一目了然：

<img src="docs/images/cli-list.png" alt="终端会话列表" width="700">

**一键恢复会话** — 支持前缀匹配，自动切换目录并恢复上下文：

<img src="docs/images/cli-resume.png" alt="终端恢复会话" width="700">

## 🚀 快速开始

### 1. 安装

**前置要求**：`Bun >= 1.0`（必需运行时）。如果通过 `npm install -g` 安装，还需要 `Node.js >= 20` 提供 `npm`。

```bash
# 方式 1：通过 npm 全局安装
# 安装时需要 Node.js/npm，运行 cc-linker 仍需要 Bun 运行时
npm install -g cc-linker@latest

# 方式 2：通过 Bun 全局安装
bun add -g cc-linker

# 安装 Bun:
# curl -fsSL https://bun.sh/install | bash
```

> **说明**：当前 npm 包入口基于 Bun 构建；如果希望完全不依赖 Bun，请使用仓库构建出的独立二进制版本。
>
> **更新提示**：`npm install -g cc-linker@latest` 时，如果 daemon 正在运行，会自动调用 `cc-linker restart` 升级到新版，无需手动重启。

### 2. 一键配置

```bash
cc-linker setup
```

交互式向导会引导你完成：
- 初始化会话注册表
- 安装 Claude Code 自动注册钩子
- 配置聊天应用 Bot（当前仅飞书：App ID + App Secret + 开机自启）

> **仅需终端侧功能？** 运行 `cc-linker setup --skip-feishu` 跳过聊天应用配置。

### 3. 开始使用

| 场景 | 操作 |
|------|------|
| 聊天应用中给 Bot 发消息（飞书） | 直接对话，流式卡片实时更新 |
| 终端查看所有会话 | `cc-linker list` |
| 终端恢复某个会话 | `cc-linker resume <UUID>` |
| 聊天应用切换会话（飞书） | `/switch <序号\|UUID>` |
| 聊天应用选择新会话目录（飞书） | `/listDir` 浏览目录，为下一条消息选择新会话目录 |
| 聊天应用创建新会话（飞书） | `/new [路径] [--model <别名>] [-- 提示词]` |

## 📋 命令参考

### CLI 命令

```bash
cc-linker list                      # 列出所有会话
cc-linker resume <UUID>             # 恢复指定会话到终端（支持前缀匹配）
cc-linker show <UUID>               # 查看会话详情
cc-linker sync                      # 手动同步两端会话
cc-linker search <关键词>           # 搜索会话
cc-linker export <UUID>             # 导出会话为 Markdown/JSON/Text
cc-linker clean                     # 清理无效记录
cc-linker status                    # 查看桥接状态
```

### 聊天应用 Bot 命令（飞书）

在飞书私聊中给 Bot 发送：

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/list` | 列出会话（带切换/恢复按钮卡片） |
| `/listDir` | 浏览目录，并为下一条消息选择新会话目录 |
| `/new [路径] [--model <别名>] [-- 提示词]` | 立即创建新会话，或只预设新会话目录/模型 |
| `/switch <序号\|UUID>` | 切换会话 |
| `/resume <序号\|UUID>` | 获取终端恢复命令 |
| `/model [序号\|别名\|--clear]` | 查看、设置或清除默认模型 |
| `/status` | 查看状态 |
| `/whoami` | 获取你的 open_id |

> **说明 1**：`/switch` 和 `/resume` 中的数字序号来自最近一次 `/list` 生成的列表快照，默认 10 分钟内有效；超时后请重新执行 `/list`。
>
> **说明 2**：`/new` 支持“先选目录/模型，后发第一条消息再真正创建会话”的用法；`/model` 设置的是当前用户的默认模型，直到 `/model --clear` 清除。

### Bot 运行管理

| 命令 | 说明 |
|------|------|
| `cc-linker start` | 前台启动（阻塞终端） |
| `cc-linker start --daemon` | 后台守护进程模式 |
| `cc-linker stop` | 停止后台 Bot |
| `cc-linker restart` | 重启 Bot 服务 |
| `cc-linker daemon install` | 配置开机自动启动 |
| `cc-linker daemon uninstall` | 移除开机自启 |
| `cc-linker daemon status` | 查看后台服务状态 |

## 🛰 Agent View 集成

Agent View 是 cc-linker 的"远端会话接管"能力:在飞书里查看终端后台 `claude` session 的实时状态,直接 Peek 日志、Reply 文字、Stop 进程或 Attach 回主对话流。依赖 `claude agents --json` 接口(需 Claude Code CLI ≥ 2.1.139)。

### 命令与按钮语义

| 入口 | 行为 |
|------|------|
| `/agents` | 拉取所有 background session 快照,按 busy / waiting / idle 分组,发一张可交互列表卡 |
| 列表卡 `[Peek]` | 抓 session 元信息 + `claude logs <shortId>` 尾部 30 行(最多 2KB),发独立 peek 卡 |
| 列表卡 `[Reply]` | 仅 waiting 状态出现:写 `pending_agent_reply` 状态 + patch 触发的卡为等待输入卡,提示用户发文字 |
| 列表卡 `[Stop]` | 仅 busy 状态出现:先弹二次确认卡(防误触),确认后 `claude stop <shortId>` |
| 列表卡 `[Attach]` | 把 openId 切到该 session,后续普通消息自动走 SDK 注入(保留用户级 defaultProvider) |
| 列表卡 `[Refresh]` | patch 原卡(2 秒防抖);messageId 不匹配则发新卡,避免误 patch 已被覆盖的旧卡 |
| 列表卡 `[返回聊天]` | 纯文本回复,无状态变更,退回到普通消息流 |
| Peek 卡 `[取消等待]` | 清除 `pending_agent_reply` 状态 |
| `/cancel` | 同上(文字版) |

### 配置

`config.toml` 新增 `[agent_view]` 段(全部可选项,默认值已适用大多数场景):

```toml
[agent_view]
# 总开关。设为 false 关闭 /agents 命令和所有 card action 处理
# enabled = true

# /agents 列表卡 [Refresh] 按钮防抖间隔(ms)
# refresh_min_interval_ms = 2000

# Peek 卡取最近多少行 claude logs 输出
# peek_lines = 30

# Peek 卡截到多少字节(超出按字符截断,避免飞书卡片体积超限)
# peek_max_bytes = 2048

# waiting → 用户多久不发文字就自动取消(ms)
# expected_reply_timeout_ms = 300000

# 是否只允许 kind=background 的 session 出现在列表
# background_only = true

# Stop 按钮是否需要二次确认卡
# stop_requires_confirm = true

# Claude CLI 最低版本要求,低于则不启用 Agent View
# min_claude_version = "2.1.139"

# Reply 路径下相邻两个 reply 之间的最小间隔(ms),防止 spam
# reply_throttle_ms = 500
```

对应环境变量(优先级高于配置文件):

| 变量 | 字段 |
|------|------|
| `CC_LINKER_AGENT_VIEW_ENABLED` | `enabled` |
| `CC_LINKER_AGENT_VIEW_REFRESH_MIN_INTERVAL_MS` | `refresh_min_interval_ms` |
| `CC_LINKER_AGENT_VIEW_PEEK_LINES` | `peek_lines` |
| `CC_LINKER_AGENT_VIEW_PEEK_MAX_BYTES` | `peek_max_bytes` |
| `CC_LINKER_AGENT_VIEW_EXPECTED_REPLY_TIMEOUT_MS` | `expected_reply_timeout_ms` |
| `CC_LINKER_AGENT_VIEW_BACKGROUND_ONLY` | `background_only` |
| `CC_LINKER_AGENT_VIEW_STOP_REQUIRES_CONFIRM` | `stop_requires_confirm` |
| `CC_LINKER_AGENT_VIEW_REPLY_THROTTLE_MS` | `reply_throttle_ms` |

> **前提条件**:本机需运行 `claude` daemon(>= `agent_view.min_claude_version`)。`/agents` 会先用 `claude --version` 做版本守卫,再 `claude agents --json` 拉快照。版本不达标时返回红色错误卡,不污染用户主流程。

## 🔧 接入飞书（第一个支持的聊天平台）

cc-linker 的架构设计支持接入多种聊天应用，**飞书是第一个已实现的平台**。后续可扩展支持其他 IM 平台。

在配置飞书 Bot 前，需要在 [飞书开放平台](https://open.feishu.cn/app) 创建应用并配置权限。

### 创建应用

1. 访问 https://open.feishu.cn/app → 创建企业自建应用
2. 在「应用功能」→「机器人」中启用 Bot 能力
3. 获取 App ID 和 App Secret（凭证与基础信息）

### 必需权限

进入「权限管理」，搜索并开通以下权限：

| 权限 | 用途 |
|------|------|
| `im:message` | 读取和发送消息 |
| `im:message:send_as_bot` | 以应用身份发送消息 |
| `im:message:readonly` | 获取消息详情 |
| `im:resource` | 下载用户发送的图片资源 |
| `im:chat:readonly` | 获取群组信息 |
| `contact:user.base:readonly` | 获取用户基本信息 |

### 必需事件订阅

进入「事件与回调」，按以下两个位置分别添加：

**事件配置**：

| 事件 | 用途 |
|------|------|
| `im.message.receive_v1` | 接收用户发给 Bot 的消息 |
| `im.chat.member.bot.added_v1` | Bot 被邀请进群时触发（可选） |

**回调配置**：

| 回调 | 用途 |
|------|------|
| `card.action.trigger` | 接收卡片按钮点击（`/list` 切换会话、模型切换、SDK 权限确认等交互） |

> **重要**：订阅方式选择 **WebSocket**（不是 HTTP 回调）。
>
> **说明**：`card.action.trigger` 是卡片交互的基础，不添加会导致 `/list`、`/model`、SDK 权限确认等所有卡片按钮点击无响应。

### 发布应用

配置完权限后，进入「版本管理与发布」→ 创建版本 → 发布。**只有发布后的权限才会生效。**

## 📖 配置说明

配置文件：`~/.cc-linker/config.toml`（可选，不创建则使用默认值）

```toml
[general]
log_level = "info"
claude_bin = "claude"

[feishu_bot]
# owner_open_id = "ou_xxx"
# default_cwd = "/path/to/workspace"

[stream]
enabled = true
throttle_ms = 1500
show_thinking = true
max_card_bytes = 25000
fallback_to_text = true

[claude]
# 权限模式：控制 Claude Code 执行操作时的交互确认行为
# 由于飞书端无法完成终端式交互确认，默认自动接受文件编辑
# 可选值：acceptEdits / auto / bypassPermissions / default / dontAsk / plan
permission_mode = "acceptEdits"

# 工具白名单（可选）：显式允许的工具列表
# 默认空数组，表示遵从 Claude Code 本地设置（~/.claude/settings.json）
# 若配置此项，会覆盖本地设置。示例：["Read", "Edit", "Bash(git *)"]
# allowed_tools = []

# 工具黑名单（可选）：显式禁止的工具列表
# 默认空数组，表示遵从 Claude Code 本地设置
# 若配置此项，会覆盖本地设置。示例：["Bash", "Write"]
# disallowed_tools = []

[sdk]
# Agent SDK 模式（支持飞书卡片上的交互式权限确认）
# 默认开启。如需关闭，设为 false
# enabled = true               # 默认 true，支持飞书端交互式权限确认
# permission_mode = "acceptEdits"  # SDK 基础权限模式
# timeout_ms = 600000          # 权限确认超时（10分钟）
# claude_executable = "claude" # Claude 可执行文件路径

[images]
# 图片消息处理（默认开启）
# enabled = true               # 默认 true，自动下载飞书图片并传递给 Claude
# max_size_bytes = 10485760    # 图片大小限制（默认 10MB）
# cleanup_max_age_hours = 24   # 过期图片清理周期（默认 24 小时）
```

**注意：** SDK 模式需要系统已安装 `claude` 命令行工具（`npm install -g @anthropic-ai/claude-code`）。如需自定义可执行文件路径，可使用 `general.claude_bin` 或 `sdk.claude_executable`。

**补充：** SDK 权限确认卡片如果发送失败，或用户在超时时间内未确认，当前实现会自动拒绝该次工具调用。

**环境变量覆盖**：

| 环境变量 | 说明 |
|---------|------|
| `CC_LINKER_DIR` | 覆盖 cc-linker 数据目录（默认 `~/.cc-linker`） |
| `CC_LINKER_CONFIG_PATH` | 指定配置文件路径 |
| `CC_LINKER_REGISTRY_PATH` | 指定 registry 文件路径 |
| `CC_LINKER_LOG_PATH` | 指定日志文件路径 |
| `CC_LINKER_FEISHU_APP_ID` | 飞书 App ID |
| `CC_LINKER_FEISHU_APP_SECRET` | 飞书 App Secret |
| `CC_LINKER_FEISHU_OWNER_OPEN_ID` | 限制仅指定用户使用 |
| `CC_LINKER_FEISHU_DEFAULT_CWD` | 默认工作目录 |
| `CC_LINKER_STREAM_ENABLED` | 流式响应开关 |
| `CC_LINKER_LOG_LEVEL` | 日志级别 |
| `CC_LINKER_CLAUDE_PERMISSION_MODE` | Claude Code 权限模式 |
| `CC_LINKER_CLAUDE_ALLOWED_TOOLS` | 允许的工具列表（逗号分隔） |
| `CC_LINKER_CLAUDE_DISALLOWED_TOOLS` | 禁止的工具列表（逗号分隔） |
| `CC_LINKER_SDK_ENABLED` | 启用 Agent SDK 模式（true/false，默认 true） |
| `CC_LINKER_SDK_PERMISSION_MODE` | SDK 权限模式 |
| `CC_LINKER_SDK_TIMEOUT_MS` | 权限确认超时（毫秒） |
| `CC_LINKER_SDK_CLAUDE_EXECUTABLE` | Claude 可执行文件路径 |
| `CC_LINKER_MAX_CONCURRENT_SESSIONS` | 最大并发会话数（默认 5） |
| `CC_LINKER_SESSION_LOCK_TIMEOUT_MS` | 单个会话锁超时（毫秒） |
| `CC_LINKER_MAX_QUEUE_SIZE` | 消息队列最大积压数量 |
| `CC_LINKER_CONFIRM_RISKY_ACTIONS` | 是否确认高风险操作（true/false） |
| `CC_LINKER_IMAGES_ENABLED` | 图片处理开关（默认 true） |
| `CC_LINKER_IMAGES_MAX_SIZE` | 图片大小限制（字节） |
| `CC_LINKER_IMAGES_CLEANUP_HOURS` | 图片清理周期（小时） |

### 启用 CLI 端 activity marker（可选）

cc-linker 默认通过 OS 信号检测 CLI 端活跃度。如需更精确的检测，可在 `~/.claude/settings.json` 中配置 hooks（Claude Code 通过 stdin 传入 JSON 事件，`session_id` 字段需自行用 `jq` 提取）：

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "SESSION_ID=$(jq -r '.session_id' </dev/stdin); cc-linker activity-hook --platform=cli --action=start --session=\"$SESSION_ID\""
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "SESSION_ID=$(jq -r '.session_id' </dev/stdin); cc-linker activity-hook --platform=cli --action=end --session=\"$SESSION_ID\""
      }]
    }]
  }
}
```

这样 cc-linker 可以 100% 准确检测 CLI 侧活跃状态，而不是依赖 CPU/子进程采样。

## 🏗 架构概览

```
┌──────────────────────────────────────────────────────┐
│  Claude Code CLI    ←→  Registry  ←→  聊天应用 Bot    │
│  (session JSONL)    (registry.json)  (当前: 飞书)     │
│                          ↑                           │
│                   SessionStart hook                  │
│                                                      │
│  内置模块：                                           │
│  - SDK 模式 (默认): Agent SDK + 交互式权限确认        │
│  - 流式模式: stream-json + 卡片实时更新               │
│  - 图片处理: 自动下载 + prompt 注入                   │
│  - 目录浏览: /listDir 交互式切换 cwd                  │
│  - 文件队列: 消息持久化 + 崩溃恢复                    │
└──────────────────────────────────────────────────────┘
```

- **Registry** (`~/.cc-linker/registry.json`): 统一会话索引，带文件锁和自动备份
- **User Mapping** (`~/.cc-linker/user-mapping.json`): 飞书用户 open_id → 当前会话目标的映射（CAS 原子更新）
- **Scanner**: 增量扫描 Claude Code JSONL 文件，保持注册表最新
- **Hook**: Claude Code 启动时自动注册新会话
- **Spool Queue**: 持久化消息队列，崩溃后可恢复（pending → processing → replied → done/failed）
- **Stream Parser**: 解析 Claude `stream-json` 输出
- **Card Updater**: 流式卡片 + 权限卡片的发送与节流
- **Permission Handler**: SDK 模式下工具权限的交互式确认（允许/拒绝/超时自动拒绝）
- **Image Processor**: 飞书图片下载、prompt 注入、过期清理
- **Startup Reconciler**: 进程启动时自动修复不一致状态（恢复卡住的消息、回滚超时 claim、补齐 jsonl_path）
- **Provider Manager**: 多模型管理，支持 CC Switch 集成和手动配置
- **Activity Detection**: CLI 端会话活跃检测，防止飞书和 CLI 同时操作同一会话

详细架构见 [docs/产品设计文档-自建方案.md](docs/产品设计文档-自建方案.md)。

## 💻 开发者指南

```bash
git clone https://github.com/yujuntea/cc-linker.git
cd cc-linker
bun install
bun run dev <命令>        # 开发模式
bun run typecheck         # 类型检查
bun test                  # 运行测试
bun test --coverage       # 带覆盖率
```

### 两种构建产物

cc-linker 支持两种分发形式，构建脚本不同：

| 产物 | 构建命令 | 输出 | 用途 |
|------|----------|------|------|
| **独立二进制** | `bun run build` | `dist/cc-linker` | 单机使用，无需额外运行时 |
| **npm 包** | `bun run build:npm` | `dist/cli.js` | `npm install -g` 全局安装（运行时仍需 Bun） |

### 开发命令速查

| 命令 | 行为 | 适用场景 |
|------|------|---------|
| `bun run dev <命令>` | 直接运行 `src/index.ts`（不构建） | 开发调试 |
| `bun run build:npm` | 构建 npm 包 → `dist/cli.js` | 构建产物 |
| `bun run reload` | 构建 → 如果 daemon 在运行则自动重启 | 开发时快速生效（适合 `bun link` 安装） |
| `bun run reload:force` | 构建 → 强制重启（没在运行也会启动） | 开发时确保 daemon 在运行 |
| **`bun run deploy`** ⭐ | **构建 → 打包 → 全局安装 → 自动重启** | **正式发布到全局并生效** |
| `bun run deploy:force` | 构建 → 打包 → 全局安装 → 强制重启 | 同上，确保启动 |
| `bun run pack:test` | 构建 → 打包 → 安装到隔离目录 | 验证 npm 包完整性 |
| `bun run typecheck` | TypeScript 类型检查 | CI/提交前 |
| `bun test` | 运行所有测试 | CI/提交前 |

> **💡 `deploy` 与 `reload` 的区别**：
> - `reload` 只更新源码目录的 `dist/cli.js`，重启的是**旧的全局安装版本**（如果通过 `npm install -g` 安装）
> - `deploy` 会 `npm install -g ./cc-linker-x.y.z.tgz`，确保全局安装的是最新代码，再重启
> - 通过 `bun link` 本地链接安装的用户，`reload` 即可生效（符号链接自动指向源码目录）

### npm 包本地测试

正式发布前，建议先在本地打包安装验证，确保 `files` 字段和 `bin` 入口正确。

**方法 1：pack + install（最接近真实发布）**

```bash
# 1. 构建并打包
bun run build:npm         # 生成 dist/cli.js
npm pack                  # → cc-linker-x.y.z.tgz

# 2. 在干净环境安装测试
mkdir -p /tmp/test-cc-linker && cd /tmp/test-cc-linker
npm install /path/to/cc-linker-0.2.0.tgz
npx cc-linker --version   # 验证命令可用
cc-linker list            # 验证功能正常

# 3. 特别验证 daemon install 生成的 plist/service 中可执行路径正确
cc-linker daemon install  # 检查生成的配置文件中 ProgramArguments/ExecStart
```

**方法 2：bun link（开发迭代最快）**

```bash
# 创建全局符号链接，修改代码后重新 build:npm 立即生效
bun run build:npm
bun link                  # 或 npm link

# 全局任意位置测试
cc-linker list
cc-linker daemon install

# 解除链接
bun unlink cc-linker
```

> ⚠️ `bun link` 是符号链接到源码目录，不经过 `files` 字段过滤。发布前**务必用方法 1 验证一次**，避免 `files` 遗漏必要文件。

### 发布

```bash
# 独立二进制（本地分发）
bun run build             # → dist/cc-linker

# npm 发布
npm version minor         # 或 patch / major
npm publish               # prepublishOnly 自动触发 build:npm
git push --tags
```

## 📚 详细文档

| 文档 | 说明 |
|------|------|
| [docs/产品设计文档-自建方案.md](docs/产品设计文档-自建方案.md) | 产品设计文档 |
| [docs/验收指南.md](docs/验收指南.md) | 功能验收指南 |
| [docs/验收测试报告.md](docs/验收测试报告.md) | 验收测试结果 |
| [docs/Product.md](docs/Product.md) | 产品需求文档 |
| [docs/model-switch-design.md](docs/model-switch-design.md) | 模型切换设计 |

## License

MIT

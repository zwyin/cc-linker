# cc-linker

> Seamless switching between Feishu Bot and terminal (Claude Code CLI) conversations — like switching devices.

[![npm version](https://img.shields.io/npm/v/cc-linker)](https://www.npmjs.com/package/cc-linker)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Language:** [中文](README.md) | English

## Why cc-linker?

Have you ever found yourself in these situations:

- **Chat on your phone during commute, continue on terminal at work** — Discuss technical solutions with the Bot via Feishu on the subway, then at the office run `cc-linker list` to find the session and `resume` to pick up right where you left off
- **Quick questions on Feishu, deep debugging on terminal** — Ask a quick API usage question on Feishu, realize you need local debugging, and switch to the same session on terminal to keep coding with Claude
- **Multiple projects, sessions stay organized** — Talk to Claude across `project-a` and `project-b` simultaneously, use `/list` to clearly see each session's directory and status, and switch with one click without getting confused

**cc-linker is the bridge tool that solves these pain points.** It maintains a unified session registry on your machine, allowing Feishu Bot and Claude Code CLI to share the same session state — no matter which side you start a conversation on, you can seamlessly switch to the other.

## Features

| Feature | Description |
|---------|-------------|
| Seamless cross-device switching | Resume Feishu sessions on terminal (with context & directory), view terminal sessions on Feishu |
| Streaming card interaction | See Claude's thinking and replies in real-time on Feishu — no more "spinning wait" |
| Unified session management | Auto-scan, incremental sync, no manual session list maintenance needed |
| Multi-model switching | One-click model switch in Feishu cards, no config changes required |
| Persistent message queue | File-level message queue survives crashes and restarts |
| 3-step setup | `install → setup → start`, ready in 5 minutes |

## Showcase

### Feishu Experience

<table>
  <tr>
    <td align="center"><b>Session List</b><br><code>/list</code> to view all sessions</td>
    <td align="center"><b>Processing</b><br>Instant feedback after sending</td>
    <td align="center"><b>Streaming Feedback</b><br>Real-time thinking process</td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/feishu-list.png" alt="Feishu session list" width="280"></td>
    <td align="center"><img src="docs/images/feishu-start-processing.png" alt="Processing" width="280"></td>
    <td align="center"><img src="docs/images/feishu-streaming-thinking.png" alt="Streaming thinking" width="280"></td>
  </tr>
</table>

<table>
  <tr>
    <td align="center"><b>Complete</b><br>Token / time / turn stats</td>
    <td align="center"><b>Complete (Long Reply)</b><br>Long text displayed equally well</td>
    <td align="center"><b>Model Switch</b><br>One-click switch via card buttons</td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/feishu-complete.png" alt="Processing complete" width="280"></td>
    <td align="center"><img src="docs/images/feishu-complete-long.png" alt="Complete - long reply" width="280"></td>
    <td align="center"><img src="docs/images/feishu-model.png" alt="Model selection" width="280"></td>
  </tr>
</table>

### Terminal Experience

**View all sessions** — Clean table display, status at a glance:

<img src="docs/images/cli-list.png" alt="Terminal session list" width="700">

**Resume session with one click** — Supports prefix matching, auto-switches directory and restores context:

<img src="docs/images/cli-resume.png" alt="Terminal resume session" width="700">

## Quick Start

### 1. Install

```bash
# Install globally via npm
npm install -g cc-linker

# Or via bun
bun add -g cc-linker

# Requires Bun runtime. Install Bun:
# curl -fsSL https://bun.sh/install | bash
```

### 2. One-Step Setup

```bash
cc-linker setup
```

The interactive wizard guides you through:
- Initializing the session registry
- Installing the Claude Code auto-register hook
- Configuring the Feishu Bot (App ID + App Secret + auto-start)

> **Need terminal-only features?** Run `cc-linker setup --skip-feishu` to skip Feishu configuration.

### 3. Start Using

| Scenario | Action |
|----------|--------|
| Send message to Bot on Feishu | Direct conversation, streaming card updates in real-time |
| View all sessions on terminal | `cc-linker list` |
| Resume a session on terminal | `cc-linker resume <UUID>` |
| Switch session on Feishu | `/switch <index>` |
| Create new session on Feishu | `/new <path> -- <prompt>` |

## Command Reference

### CLI Commands

```bash
cc-linker list                      # List all sessions
cc-linker resume <UUID>             # Resume a session on terminal (supports prefix matching)
cc-linker show <UUID>               # Show session details
cc-linker sync                      # Manually sync sessions on both sides
cc-linker search <keyword>          # Search sessions
cc-linker export <UUID>             # Export session as Markdown/JSON/Text
cc-linker clean                     # Clean up invalid records
cc-linker status                    # Check bridge status
```

### Feishu Bot Commands

Send these in a Feishu private chat with the Bot:

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/list` | List sessions (with switch/resume button cards) |
| `/new [path] [-- prompt]` | Create a new session |
| `/switch <index\|UUID>` | Switch session |
| `/resume <index\|UUID>` | Get terminal resume command |
| `/model` | View/set default model |
| `/status` | Check status |
| `/whoami` | Get your open_id |

### Bot Runtime Management

| Command | Description |
|---------|-------------|
| `cc-linker start` | Start in foreground (blocks terminal) |
| `cc-linker start --daemon` | Start as background daemon |
| `cc-linker stop` | Stop the background Bot |
| `cc-linker restart` | Restart the Bot service |
| `cc-linker daemon install` | Configure auto-start on boot |
| `cc-linker daemon uninstall` | Remove auto-start on boot |
| `cc-linker daemon status` | Check background service status |

## Feishu Open Platform Configuration

Before configuring the Feishu Bot, you need to create an app and set permissions on the [Feishu Open Platform](https://open.feishu.cn/app).

### Create an App

1. Visit https://open.feishu.cn/app → Create an enterprise self-built app
2. Enable Bot capability under "App Features" → "Bot"
3. Get App ID and App Secret (from Credentials & Basic Info)

### Required Permissions

Go to "Permission Management", search and enable:

| Permission | Purpose |
|------------|---------|
| `im:message` | Read and send messages |
| `im:message:send_as_bot` | Send messages as the app |
| `im:message:readonly` | Get message details |
| `im:chat:readonly` | Get chat info |
| `contact:user.base:readonly` | Get basic user info |

### Required Event Subscriptions

Go to "Event Subscriptions", add:

| Event | Purpose |
|-------|---------|
| `im.message.receive_v1` | Receive messages sent to the Bot |
| `im.chat.member.bot.added_v1` | Triggered when Bot is invited to a group (optional) |

> **Important**: Choose **WebSocket** (not HTTP callback) for event subscription method.

### Publish the App

After configuring permissions, go to "Version Management & Release" → Create Version → Publish. **Permissions only take effect after publishing.**

## Configuration

Config file: `~/.cc-linker/config.toml` (optional, defaults used if not created)

```toml
[general]
log_level = "info"

[stream]
enabled = true
throttle_ms = 1500
show_thinking = true
max_card_bytes = 25000
fallback_to_text = true
```

**Environment Variable Overrides**:

| Variable | Description |
|----------|-------------|
| `CC_LINKER_FEISHU_APP_ID` | Feishu App ID |
| `CC_LINKER_FEISHU_APP_SECRET` | Feishu App Secret |
| `CC_LINKER_FEISHU_OWNER_OPEN_ID` | Restrict to specific user only |
| `CC_LINKER_STREAM_ENABLED` | Streaming response toggle |
| `CC_LINKER_LOG_LEVEL` | Log level |

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│  Claude Code CLI    ←→  Registry  ←→  Feishu Bot     │
│  (session JSONL)    (registry.json)  (WebSocket)     │
│                          ↑                           │
│                   SessionStart hook                  │
└──────────────────────────────────────────────────────┘
```

- **Registry** (`~/.cc-linker/registry.json`): Unified session index with file locking and auto-backup
- **Scanner**: Incrementally scans Claude Code JSONL files to keep registry up-to-date
- **Hook**: Auto-registers new sessions when Claude Code starts
- **Spool Queue**: Persistent message queue, recoverable after crashes
- **Stream Parser**: Parses Claude `stream-json` output
- **Card Updater**: Streaming card sending with throttling

## Developer Guide

```bash
git clone https://github.com/yujuntea/cc-linker.git
cd cc-linker
bun install
bun run dev <command>       # Dev mode
bun run typecheck           # Type check
bun test                    # Run tests
bun test --coverage         # With coverage
bun run build               # Compile to standalone binary
```

### Build & Release

```bash
# Standalone binary (local distribution)
bun run build               # → dist/cc-linker

# npm publish
npm version minor
npm publish                 # prepublishOnly triggers build:npm automatically
git push --tags
```

## Detailed Documentation

| Document | Description |
|----------|-------------|
| [Product Design Doc (Chinese)](docs/产品设计文档-自建方案.md) | Product design document |
| [Acceptance Guide](docs/验收指南.md) | Feature acceptance guide |
| [Acceptance Test Report](docs/验收测试报告.md) | Acceptance test results |
| [Product Requirements](docs/Product.md) | Product requirements document |
| [Model Switch Design](docs/model-switch-design.md) | Model switching design |

## License

MIT

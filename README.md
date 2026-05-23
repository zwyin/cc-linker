# cc-bridge

让飞书（cc-connect）和终端（Claude Code CLI）之间的对话切换像切换设备一样无缝。

## 什么是 cc-bridge

cc-bridge 是一个轻量级本地桥接工具，解决 cc-connect 和 Claude Code CLI 之间的**会话发现壁垒**问题。它通过建立一个统一的会话注册表，让两端的会话互相可见、互相恢复。

**核心能力**：
- 在终端列出所有 cc-connect 和 CLI 发起的会话
- 一键恢复任意会话到 Claude Code CLI
- 在飞书中通过 `/bridge` 命令统一管理所有会话（含 CLI 发起的）
- 支持飞书 ↔ 终端之间往返切换同一会话
- **飞书流式响应卡片** — 实时展示 Claude 的思考过程和回复内容，交互卡片状态自动流转（处理中 → 流式更新 → 完成）

详细产品文档见 [docs/产品设计文档-自建方案.md](docs/产品设计文档-自建方案.md)。

**完整文档索引**：

| 文档 | 说明 |
|------|------|
| [docs/产品设计文档-自建方案.md](docs/产品设计文档-自建方案.md) | 产品设计文档 |
| [docs/验收指南.md](docs/验收指南.md) | 功能验收指南 |
| [docs/验收测试报告.md](docs/验收测试报告.md) | 验收测试结果 |
| [docs/验收文档-自建方案.md](docs/验收文档-自建方案.md) | 验收文档 |
| [docs/Product.md](docs/Product.md) | 产品需求文档 |
| [docs/model-switch-design.md](docs/model-switch-design.md) | 模型切换设计 |

## 快速开始

### 安装

```bash
# 方式 1：从源码安装（推荐开发/调试）
git clone https://github.com/xxx/cc-bridge.git
cd cc-bridge
bun install
bun run build

# 将生成的 dist/cc-bridge 加入 PATH
export PATH="$(pwd)/dist:$PATH"

# 方式 2：npm 全局安装（发布后可用）
npm install -g cc-bridge

# 方式 3：bun 全局安装
bun add -g cc-bridge

# 方式 4：直接运行（无需安装全局命令）
bunx cc-bridge <命令>
```

### 初始化

```bash
cc-bridge init
```

首次运行会：
1. 创建 `~/.cc-bridge/` 目录和 `registry.json`
2. 扫描已有的 cc-connect 会话（`~/.cc-connect/sessions/*.json`）
3. 扫描 Claude Code 会话（`~/.claude/projects/*/*.jsonl`）
4. 将所有会话注册到统一索引

### 安装 Hook（推荐）

```bash
cc-bridge hook install
```

安装后，每次启动 Claude Code 会自动注册新会话到 registry，无需手动同步。

### 常用命令

```bash
# 列出所有会话
cc-bridge list

# 恢复指定会话到终端（支持 UUID 前缀匹配）
cc-bridge resume <UUID前缀>

# 查看会话详情
cc-bridge show <UUID前缀>

# 手动同步两端会话
cc-bridge sync

# 导出会话为 Markdown
cc-bridge export <UUID前缀>

# 搜索会话
cc-bridge search <关键词>

# 查看桥接状态
cc-bridge status
```

### 飞书集成

cc-bridge 提供两种飞书集成模式：

#### 模式 A：独立飞书 Bot（推荐）

通过 WebSocket 直连飞书开放平台，无需 cc-connect 中间层：

```bash
# 交互式配置（App ID + App Secret + Owner）
cc-bridge init-feishu

# 启动 Bot
cc-bridge start              # 前台运行
cc-bridge start --daemon     # 后台运行
cc-bridge stop               # 停止后台 Bot
```

**Bot 运行模式**：

| 命令 | 说明 |
|------|------|
| `cc-bridge start` | 前台启动飞书 Bot（阻塞终端） |
| `cc-bridge start --daemon` | 后台守护进程模式 |
| `cc-bridge stop` | 停止后台 Bot |
| `cc-bridge daemon install` | 配置开机自动启动 |
| `cc-bridge daemon uninstall` | 移除开机自动启动 |
| `cc-bridge daemon status` | 查看后台服务状态 |

**Bot 特性**：

- **持久化消息队列**：消息通过文件系统队列（`~/.cc-bridge/spool/`）持久化，崩溃/重启后自动恢复
- **单进程锁**：`StateCoordinator` 确保同一时间只有一个 Bot 实例运行
- **流式响应卡片**：Claude 的思考过程和回复实时展示在飞书交互卡片上

#### 模式 B：cc-connect 集成（遗留）

如果你仍在使用 cc-connect 作为飞书 AI 编程入口：

```bash
bash scripts/setup-feishu.sh
```

脚本会自动：
1. 检查 cc-connect 配置文件
2. 备份现有配置
3. 添加 `/bridge` 命令配置
4. 提示重启 cc-connect

配置完成后，在飞书中使用：

| 命令 | 说明 |
|------|------|
| `/bridge list` | 列出所有会话（含 CLI 发起的） |
| `/bridge switch <Ref>` | 切换到指定会话 |
| `/bridge resume <Ref>` | 获取终端恢复命令 |
| `/bridge status` | 查看桥接状态 |
| `/bridge new [路径] [-- 提示词]` | 创建新会话（支持流式卡片） |

**流式响应体验**：

当 `stream.enabled = true`（默认开启）时，飞书中的普通消息和 `/bridge new` 命令会触发流式响应：

1. **⏳ 正在处理...** — 蓝色卡片，Claude 进程启动后立即出现
2. **💭 处理中** — 实时展示 thinking 过程（`> ` 引用格式）和回复内容，底部显示已用时间
3. **✅ 处理完成** — 绿色卡片，展示最终回复 + 费用/耗时/轮数统计

流式卡片支持节流控制（默认 1500ms）、内容大小管理（25KB 上限自动降级）和 thinking 展示开关。

> **模式 B 说明**：cc-connect 集成模式已不再积极维护，建议使用独立飞书 Bot 模式。
> cc-connect v1.3.2 不支持 `{{user}}` 模板变量，cc-bridge 会自动从 cc-connect session 文件中识别调用者身份，无需手动传递。

### 配置说明

配置文件：`~/.cc-bridge/config.toml`（可选，不创建则使用默认值）

```toml
[general]
# 日志级别：debug | info | warn | error
log_level = "info"
# 日志文件路径（可选，不设置则输出到 stderr）
log_path = "~/.cc-bridge/cc-bridge.log"

[bridge]
# cc-connect bridge API 地址（默认 http://localhost:9810）
api_url = "http://localhost:9810"
# bridge API token（建议从环境变量读取）
token = ""

[scanner]
# 最大文件大小（字节），超过此大小的 JSONL 文件跳过解析
max_file_size = 104857600  # 100MB

[stream]
# 是否启用流式响应卡片（飞书 Bot）
enabled = true
# 卡片更新节流间隔（毫秒），防止触发飞书 5 QPS 限流
throttle_ms = 1500
# 是否在流式卡片中展示 thinking 内容
show_thinking = true
# 卡片内容字节上限，超过时降级为普通文本消息
max_card_bytes = 25000
# 超长回复时是否将超出部分以普通文本分片发送
fallback_to_text = true
```

**环境变量覆盖**：

| 环境变量 | 配置项 | 说明 |
|---------|--------|------|
| `CC_BRIDGE_REGISTRY_PATH` | `general.registry_path` | Registry 文件路径 |
| `CC_BRIDGE_LOG_LEVEL` | `general.log_level` | 日志级别 |
| `CC_BRIDGE_LOG_PATH` | `general.log_path` | 日志文件路径 |
| `CC_BRIDGE_TOKEN` | `bridge.token` | bridge API token |
| `CC_BRIDGE_API_URL` | `bridge.api_url` | bridge API 地址 |
| `CC_BRIDGE_STREAM_ENABLED` | `stream.enabled` | 流式响应开关 |
| `CC_BRIDGE_STREAM_THROTTLE_MS` | `stream.throttle_ms` | 卡片更新节流间隔 |
| `CC_BRIDGE_STREAM_SHOW_THINKING` | `stream.show_thinking` | 是否展示 thinking 内容 |

## 架构概览

```
┌──────────────────────────────────────────────────────────────────────┐
│                            用户设备                                  │
│                                                                      │
│  ┌───────────────┐          ┌──────────────────┐   ┌─────────────┐  │
│  │ Claude Code   │          │  cc-connect       │   │  飞书 Bot    │  │
│  │ CLI           │          │  (飞书/微信/...)   │   │  (WebSocket)│  │
│  │               │          │                   │   │             │  │
│  │ session-1     │          │  session-A        │   │  流式卡片    │  │
│  │ session-2     │          │  session-B        │   │  状态流转    │  │
│  └───────┬───────┘          └──────┬────────────┘   └──────┬──────┘  │
│          │                         │                     │          │
│          │ SessionStart hook       │ cc-connect          │ Stream   │
│          │ (entrypoint=cli)        │ bridge API          │ Parser   │
│          ▼                         ▼                     ▼          │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Session Registry                                │   │
│  │              ~/.cc-bridge/registry.json                      │   │
│  │                                                              │   │
│  │  {                                                           │   │
│  │    "sessions": {                                             │   │
│  │      "<uuid>": {                                             │   │
│  │        "origin": "cli" | "cc-connect" | "feishu",           │   │
│  │        "cwd": "...",                                        │   │
│  │        "project_name": "...",                               │   │
│  │        ...                                                   │   │
│  │      }                                                       │   │
│  │    }                                                         │   │
│  │  }                                                           │   │
│  │                                                              │   │
│  │  来源判别（origin）:                                          │   │
│  │    主判别: UUID ∈ cc-connect sessions 权威集                 │   │
│  │    辅助:   entrypoint="sdk-cli" 兜底                         │   │
│  │    都不命中: 归为 cli                                        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│          │                                                           │
│          ▼                                                           │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │         Claude Code 原生 JSONL 存储                           │   │
│  │         ~/.claude/projects/<project>/*.jsonl                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

| 组件 | 说明 |
|------|------|
| **Registry** | `~/.cc-bridge/registry.json`，统一会话索引 |
| **Scanner** | 扫描 cc-connect session JSON + Claude Code JSONL，增量更新 registry |
| **Hook** | Claude Code SessionStart 钩子，即时注册新会话 |
| **CLI** | `cc-bridge` 命令入口：list / resume / show / sync / export 等 |
| **Bridge API** | 调用 cc-connect 的 `/bridge/sessions/switch` 实现无重启切换 |
| **Feishu Bot** | WebSocket 机器人，接收飞书消息，代理到 Claude Code CLI |
| **Stream Parser** | 解析 Claude `--output-format stream-json` 输出，提取 thinking/text/result |
| **Card Updater** | 发送和更新飞书交互卡片，支持节流和内容大小管理 |
| **Spool Queue** | 持久化文件队列，确保消息按序处理，支持崩溃恢复 |
| **State Coordinator** | 单进程锁，防止多个 Bot 实例同时运行 |
| **Reconciler** | Bot 启动时恢复 processing 状态的队列消息 |

**数据流**：
- 两端会话元数据 → Scanner/Hook → Registry → CLI 命令读取并展示
- JSONL 对话文件本身由 Claude Code 原生管理，cc-bridge 不做任何修改
- `resume` 命令直接调用 `claude --resume <uuid>`，Claude Code 从 JSONL 加载完整历史
- 飞书消息 → WebSocket → SpoolQueue（持久化） → ClaudeSessionManager（spawn 进程） → StreamParser → CardUpdater → 飞书卡片

## 项目结构

```
src/
├── index.ts                  # CLI 入口（Commander）
├── cli/
│   ├── commands/             # 各子命令实现
│   │   ├── init.ts           # cc-bridge init
│   │   ├── init-feishu.ts    # cc-bridge init-feishu（交互式配置飞书）
│   │   ├── list.ts           # cc-bridge list
│   │   ├── resume.ts         # cc-bridge resume
│   │   ├── show.ts           # cc-bridge show
│   │   ├── sync.ts           # cc-bridge sync
│   │   ├── search.ts         # cc-bridge search
│   │   ├── export.ts         # cc-bridge export
│   │   ├── clean.ts          # cc-bridge clean
│   │   ├── hook.ts           # cc-bridge hook（install/uninstall/status）
│   │   ├── start.ts          # cc-bridge start（启动飞书 Bot）
│   │   ├── stop.ts           # cc-bridge stop（停止飞书 Bot）
│   │   ├── daemon.ts         # cc-bridge daemon install/uninstall/status
│   │   ├── register.ts       # cc-bridge register（内部命令）
│   │   └── status.ts         # cc-bridge status
│   └── output.ts             # 表格/格式化输出
├── feishu/                   # 飞书 Bot、卡片更新、用户状态管理
│   ├── bot.ts                # 飞书消息路由、命令处理、流式代理
│   ├── card-updater.ts       # 交互卡片发送/更新/节流
│   ├── mapping.ts            # 用户状态映射（CAS 更新）
│   └── list-snapshot.ts      # 会话列表快照
├── proxy/                    # Claude CLI 代理
│   ├── session.ts            # 进程管理、stdout/stderr 处理
│   └── stream-parser.ts      # stream-json 解析器
├── queue/                    # 持久化消息队列
│   └── spool.ts              # 文件队列（pending → processing → done/failed）
├── registry/                 # Registry 读写、文件锁、备份
├── runtime/                  # 运行时协调
│   ├── state-coordinator.ts  # 单进程锁（防止多个 Bot 同时运行）
│   └── reconciler.ts         # 启动时恢复 processing 队列消息
├── scanner/                  # cc-connect + JSONL 扫描器
├── hook/                     # SessionStart hook 脚本
└── utils/                    # 工具函数（配置、日志、路径、错误、验证）
tests/
├── unit/                     # 单元测试
├── integration/              # 集成测试
└── fixtures/                 # 测试固件
```

## 使用场景

### 场景 1：飞书开始 → 终端继续

1. 在飞书中使用 cc-connect 发起 AI 编程对话
2. 回到工位，运行 `cc-bridge list` 查看所有会话
3. 运行 `cc-bridge resume <Ref>` 恢复到终端继续

### 场景 2：终端开始 → 飞书继续

1. 在终端使用 Claude Code CLI 开始编程
2. 出门在外，在飞书中运行 `/bridge list` 查看会话
3. 运行 `/bridge switch <Ref>` 切换到该会话继续

### 场景 3：频繁切换同一会话

1. 首次映射后，可在飞书和终端之间往返切换
2. 飞书：`/bridge switch <Ref>`
3. 终端：`cc-bridge resume <Ref>`
4. 两端共享同一 JSONL 历史，数据一致

### 场景 4：飞书流式对话

1. 在飞书中发送普通消息（已绑定会话后）或 `/bridge new <路径> -- <提示词>`
2. 飞书实时展示 **⏳ 正在处理...** → **💭 处理中** → **✅ 处理完成** 卡片
3. 处理过程中可看到 Claude 的思考过程（`> ` 引用格式）和逐步生成的回复
4. 完成后卡片展示费用、耗时和轮数统计

### 场景 5：多会话管理

1. `cc-bridge list` 查看所有会话（默认按最后活跃排序）
2. `cc-bridge search <关键词>` 搜索特定会话
3. `cc-bridge show <Ref>` 查看会话详情
4. `cc-bridge export <Ref>` 导出会话为 Markdown/JSON/Text

### 场景 6：会话清理

1. `cc-bridge clean --dry-run` 预览将清理的会话
2. `cc-bridge clean --older-than 30` 清理 30 天前的会话
3. `cc-bridge clean` 清理所有无效记录（JSONL 文件不存在的）

详细验收指南见 [docs/验收指南.md](docs/验收指南.md)。

## 开发者指南

### 技术栈

- **运行时**: Bun（详见 CLAUDE.md）
- **CLI 框架**: commander
- **交互**: inquirer
- **表格**: cli-table3
- **样式**: chalk
- **验证**: zod
- **配置**: @iarna/toml
- **文件锁**: proper-lockfile
- **语言**: TypeScript

### 开发

```bash
# 安装依赖
bun install

# 开发模式（直接运行 TypeScript）
bun run dev <命令>
# 例如：
bun run dev init
bun run dev list

# 类型检查
bun run typecheck
```

### 测试

```bash
# 运行全部测试
bun test

# 运行带覆盖率报告
bun test --coverage

# 运行指定测试文件
bun test tests/unit/scanner/jsonl.test.ts

# 运行匹配名称的测试
bun test --test-name-pattern="scan"
```

**测试注意事项**：
- 单元测试在 `tests/unit/` 下，集成测试在 `tests/integration/` 下
- 测试覆盖：Scanner、Registry、Queue、Feishu Bot、Proxy、StreamParser、StateCoordinator、Reconciler 等模块
- 测试依赖 `tests/fixtures/` 中的样本数据（JSONL、cc-connect session JSON）
- Registry 相关测试涉及文件锁，注意 macOS/Linux 的 `fcntl` 行为差异
- Hook 测试使用 `tests/fixtures/cc-connect-session.json` 模拟 cc-connect 环境
- 提交前确保 `bun test` 和 `bun run typecheck` 均通过
- 功能验收请参考 [docs/验收指南.md](docs/验收指南.md)

### 编译和发布

```bash
# 编译为独立二进制文件
bun run build
# 输出：dist/cc-bridge
```

编译后的产物是零依赖的单个可执行文件，可直接分发。

**发布流程**：

```bash
# 1. 确保测试通过
bun test

# 2. 类型检查
bun run typecheck

# 3. 编译
bun run build

# 4. 验证编译产物
./dist/cc-bridge --help
./dist/cc-bridge init --dry-run  # 如需 dry-run 支持

# 5. 打 tag 并发布
git tag v0.2.0
git push --tags
```

## License

MIT

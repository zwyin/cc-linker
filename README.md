# cc-bridge

让飞书（cc-connect）和终端（Claude Code CLI）之间的对话切换像切换设备一样无缝。

## 什么是 cc-bridge

cc-bridge 是一个轻量级本地桥接工具，解决 cc-connect 和 Claude Code CLI 之间的**会话发现壁垒**问题。它通过建立一个统一的会话注册表，让两端的会话互相可见、互相恢复。

**核心能力**：
- 在终端列出所有 cc-connect 和 CLI 发起的会话
- 一键恢复任意会话到 Claude Code CLI
- 在飞书中通过 `/bridge` 命令统一管理所有会话（含 CLI 发起的）
- 支持飞书 ↔ 终端之间往返切换同一会话

详细产品文档见 [docs/产品文档.md](docs/产品文档.md)。

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

运行配置脚本一键完成飞书集成：

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

**手动配置**（如脚本不适用）：

在 cc-connect 的 `config.toml` 末尾添加：

```toml
[[commands]]
  name = "bridge"
  description = "跨平台会话管理 / Cross-platform session management"
  exec = "cc-bridge feishu-cmd {{args}}"
```

> **注意**：cc-connect v1.3.2 不支持 `{{user}}` 模板变量。cc-bridge 会自动从 cc-connect session 文件中识别调用者身份，无需手动传递。

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
```

**环境变量覆盖**：

| 环境变量 | 配置项 | 说明 |
|---------|--------|------|
| `CC_BRIDGE_REGISTRY_PATH` | `general.registry_path` | Registry 文件路径 |
| `CC_BRIDGE_LOG_LEVEL` | `general.log_level` | 日志级别 |
| `CC_BRIDGE_LOG_PATH` | `general.log_path` | 日志文件路径 |
| `CC_BRIDGE_TOKEN` | `bridge.token` | bridge API token |
| `CC_BRIDGE_API_URL` | `bridge.api_url` | bridge API 地址 |

## 架构概览

```
┌──────────────────────────────────────────────────────┐
│                      用户设备                        │
│                                                      │
│  ┌───────────────┐           ┌──────────────────┐   │
│  │ Claude Code   │           │  cc-connect       │   │
│  │ CLI           │           │  (飞书/微信/...)   │   │
│  │               │           │                   │   │
│  │ session-1     │           │  session-A        │   │
│  │ session-2     │           │  session-B        │   │
│  └───────┬───────┘           └──────┬────────────┘   │
│          │                          │                │
│          │ SessionStart hook        │ cc-connect     │
│          │ (entrypoint=cli)         │ bridge API     │
│          ▼                          ▼                │
│  ┌──────────────────────────────────────────────┐   │
│  │         Session Registry                     │   │
│  │         ~/.cc-bridge/registry.json           │   │
│  │                                              │   │
│  │  {                                           │   │
│  │    "sessions": {                             │   │
│  │      "<uuid>": {                             │   │
│  │        "origin": "cli" | "cc-connect",      │   │
│  │        "cwd": "...",                        │   │
│  │        "project_name": "...",               │   │
│  │        ...                                   │   │
│  │      }                                       │   │
│  │    }                                         │   │
│  │  }                                           │   │
│  │                                              │   │
│  │  来源判别（origin）:                          │   │
│  │    主判别: UUID ∈ cc-connect sessions 权威集 │   │
│  │    辅助:   entrypoint="sdk-cli" 兜底         │   │
│  │    都不命中: 归为 cli                        │   │
│  └──────────────────────────────────────────────┘   │
│          │                                           │
│          ▼                                           │
│  ┌──────────────────────────────────────────────┐   │
│  │    Claude Code 原生 JSONL 存储                │   │
│  │    ~/.claude/projects/<project>/*.jsonl      │   │
│  └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

| 组件 | 说明 |
|------|------|
| **Registry** | `~/.cc-bridge/registry.json`，统一会话索引 |
| **Scanner** | 扫描 cc-connect session JSON + Claude Code JSONL，增量更新 registry |
| **Hook** | Claude Code SessionStart 钩子，即时注册新会话 |
| **CLI** | `cc-bridge` 命令入口：list / resume / show / sync / export 等 |
| **Bridge API** | 调用 cc-connect 的 `/bridge/sessions/switch` 实现无重启切换 |

**数据流**：
- 两端会话元数据 → Scanner/Hook → Registry → CLI 命令读取并展示
- JSONL 对话文件本身由 Claude Code 原生管理，cc-bridge 不做任何修改
- `resume` 命令直接调用 `claude --resume <uuid>`，Claude Code 从 JSONL 加载完整历史

## 项目结构

```
src/
├── index.ts                  # CLI 入口（Commander）
├── cli/
│   ├── commands/             # 各子命令实现
│   │   ├── init.ts           # cc-bridge init
│   │   ├── list.ts           # cc-bridge list
│   │   ├── resume.ts         # cc-bridge resume
│   │   ├── show.ts           # cc-bridge show
│   │   ├── sync.ts           # cc-bridge sync
│   │   ├── search.ts         # cc-bridge search
│   │   ├── export.ts         # cc-bridge export
│   │   ├── clean.ts          # cc-bridge clean
│   │   ├── hook.ts           # cc-bridge hook
│   │   ├── register.ts       # cc-bridge register（内部命令）
│   │   ├── feishu-cmd.ts     # cc-bridge feishu-cmd（飞书侧入口）
│   │   └── status.ts         # cc-bridge status
│   └── output.ts             # 表格/格式化输出
├── registry/                 # Registry 读写、文件锁、备份
├── scanner/                  # cc-connect + JSONL 扫描器
├── hook/                     # SessionStart hook 脚本
└── utils/                    # 工具函数（配置、日志、路径、错误）
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

### 场景 4：多会话管理

1. `cc-bridge list` 查看所有会话（默认按最后活跃排序）
2. `cc-bridge search <关键词>` 搜索特定会话
3. `cc-bridge show <Ref>` 查看会话详情
4. `cc-bridge export <Ref>` 导出会话为 Markdown/JSON/Text

### 场景 5：会话清理

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
git tag v0.1.0
git push --tags
```

## License

MIT

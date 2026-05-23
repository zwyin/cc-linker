# cc-linker 设计文档

> cc-connect 与 Claude Code CLI 的会话桥接工具

---

## 1. 概述

cc-linker 是一个轻量级本地 CLI 工具，解决 cc-connect（飞书/微信等 IM 平台）和 Claude Code CLI 之间的**会话发现壁垒**问题。

通过建立统一的会话注册表（Session Registry），让两端会话互相可见、互相恢复。

## 2. 技术栈

| 组件 | 选择 | 理由 |
|------|------|------|
| 语言 | TypeScript | 与 Claude Code 同生态，类型安全 |
| 运行时 | bun | 极快的 TS 支持，内置测试/bundler |
| CLI 框架 | commander | 流行、简洁、API 清晰 |
| 交互提示 | inquirer | 成熟的交互库 |
| 文件锁 | proper-lockfile | 2M+ 周下载量，可靠 |
| 配置解析 | @iarna/toml | TOML 格式，与 cc-connect 一致 |
| 终端颜色 | chalk | 标准选择 |
| 表格输出 | cli-table3 | 功能丰富 |
| 类型校验 | zod | 运行时 schema 校验 |
| 测试 | bun test | 内置，兼容 Jest API |

## 3. 项目结构

```
cc-linker/
├── src/
│   ├── index.ts                 # CLI 入口，commander 注册
│   ├── registry/
│   │   ├── registry.ts          # Registry 读写、锁、备份
│   │   ├── types.ts             # Registry/Session 类型定义
│   │   └── index.ts             # 导出
│   ├── scanner/
│   │   ├── cc-connect.ts        # cc-connect session 扫描器
│   │   ├── jsonl.ts             # JSONL 文件扫描器
│   │   ├── cache.ts             # mtime 缓存（scan_cache.json）
│   │   └── index.ts             # 统一扫描入口
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── init.ts          # cc-linker init
│   │   │   ├── list.ts          # cc-linker list
│   │   │   ├── resume.ts        # cc-linker resume
│   │   │   ├── show.ts          # cc-linker show
│   │   │   ├── sync.ts          # cc-linker sync
│   │   │   ├── status.ts        # cc-linker status
│   │   │   ├── hook.ts          # cc-linker hook install/uninstall/status
│   │   │   ├── register.ts      # cc-linker register（内部）
│   │   │   ├── export.ts        # cc-linker export
│   │   │   ├── search.ts        # cc-linker search
│   │   │   ├── clean.ts         # cc-linker clean
│   │   │   └── feishu-cmd.ts    # cc-linker feishu-cmd
│   │   └── output.ts            # 表格/JSON/CSV 格式化
│   ├── hook/
│   │   └── session-start.ts     # Hook 脚本逻辑
│   └── utils/
│       ├── lock.ts              # proper-lockfile 封装
│       ├── config.ts            # TOML 配置加载
│       ├── logger.ts            # 日志（文件 + stderr）
│       ├── errors.ts            # 错误码定义
│       └── paths.ts             # 路径常量
├── tests/
│   ├── unit/
│   │   ├── registry.test.ts
│   │   ├── scanner/
│   │   │   ├── cc-connect.test.ts
│   │   │   └── jsonl.test.ts
│   │   └── utils/
│   │       ├── lock.test.ts
│   │       └── config.test.ts
│   ├── integration/
│   │   ├── cli-commands.test.ts
│   │   └── full-scan.test.ts
│   └── fixtures/
│       ├── cc-connect-session.json
│       ├── sample.jsonl
│       └── registry.json
├── package.json
├── tsconfig.json
└── README.md
```

## 4. 核心数据结构

### 4.1 SessionEntry

```typescript
interface SessionEntry {
  // 标识
  origin: 'cli' | 'cc-connect';
  source: string;                    // "terminal" | "feishu:ou_xxx"
  platform: string | null;           // "feishu" | "weixin" | null
  owner: string | null;              // "feishu:ou_xxx" | "terminal:wuyujun"
  owner_user_key: string | null;     // "feishu:chat_id:user_id"

  // 路径
  cwd: string;
  project_name: string | null;
  jsonl_path: string;
  project_dir: string | null;

  // cc-connect 映射
  cc_connect_session_id: string | null;
  cc_connect_session_file: string | null;

  // 时间
  created_at: string;   // ISO8601
  last_active: string;  // ISO8601

  // 内容摘要
  title: string | null;
  message_count: number;
  last_message_preview: string;
  status: 'active' | 'archived' | 'corrupted';

  // 权限
  visibility?: 'private' | 'team' | 'public';
  shared_with?: string[];
}
```

### 4.2 Registry

```typescript
interface Registry {
  version: 1;
  updated_at: string;  // ISO8601
  sessions: Record<string, SessionEntry>;  // UUID -> SessionEntry
}
```

### 4.3 文件路径

```
~/.cc-linker/
├── registry.json          # 主文件（权限 600）
├── registry.json.lock     # proper-lockfile 创建
├── registry.json.bak      # 软链接 → 最新备份
├── backups/               # 备份目录
│   └── registry.YYYYMMDD_HHMMSS.json
├── scan_cache.json        # mtime 缓存
├── hook.log               # Hook 日志
└── config.toml            # 配置文件（可选）
```

## 5. Registry 实现

### 5.1 原子写入

1. 获取文件锁（proper-lockfile，重试 3 次）
2. 写入临时文件 `registry.json.tmp`
3. `rename` 替换原文件（原子操作）
4. 释放锁

### 5.2 备份策略

- 独立目录 `~/.cc-linker/backups/`
- 带时间戳：`registry.20260504_153000.json`
- 保留最近 3 个版本
- `.bak` 软链接指向最新备份

### 5.3 损坏恢复

1. 加载时用 Zod schema 校验
2. 校验失败 → 尝试从 `.bak` 恢复
3. 恢复失败 → 创建空 registry

### 5.4 UUID 短前缀

- 取 UUID 前 8 位
- 要求全局唯一，否则报错 E006
- 所有命令都支持短前缀和完整 UUID

## 6. Scanner 实现

### 6.1 运行模型

cc-linker **不强制后台 daemon**。Scanner 通过两层触发覆盖：

| 触发点 | 时机 | 范围 | 默认开启 |
|--------|------|------|----------|
| Hook | Claude Code 启动时 | 单个 UUID | 是 |
| CLI 命令前 | list/resume/show/sync 执行前 | 增量扫描 | 是 |

### 6.2 cc-connect Scanner

扫描 `~/.cc-connect/sessions/*.json`，输出：
- `agent_session_id` 集合（用于来源判别）
- `sid` 集合（用于 stale 检测）

**来源判别**：
- 主判别：UUID 在 cc-connect 权威集 → `origin="cc-connect"`
- 辅助：`entrypoint="sdk-cli"` → `origin="cc-connect"`
- 兜底：`origin="cli"`

### 6.3 JSONL Scanner

扫描 `~/.claude/projects/<*>/*.jsonl`，基于 mtime 增量：

1. 首次扫描：完整解析前 10 行 + 后 10 行
2. 增量扫描：只读末尾 4KB 更新 last_active/preview
3. 缓存 mtime 到 `scan_cache.json`

**性能数据**（实测 718 文件，453MB）：
- 首次扫描：371ms
- 增量扫描（无变化）：1ms

### 6.4 项目名推断

优先级：
1. `package.json` → `name` 字段
2. `go.mod` → `module` 路径最后一段
3. `Cargo.toml` → `[package].name`
4. `pyproject.toml` → `[project].name`
5. 目录名
6. Home 目录 → `"Home"`

## 7. CLI 命令

### 7.1 cc-linker init

初始化 registry 并扫描已有会话。

### 7.2 cc-linker list

列出所有可恢复的会话。支持过滤：`--project`、`--platform`、`--origin`、`--active`。

### 7.3 cc-linker resume

恢复指定会话到 Claude Code CLI。

**流程**：
1. 确定目标 UUID（前缀/交互选择/搜索）
2. 验证 JSONL 文件存在
3. reset_on_idle 检测（cc-connect 会话）
4. CWD 检查与确认
5. `execvp` 进程替换：`cd <cwd> && claude --resume <uuid>`

### 7.4 cc-linker show

查看会话详情。

### 7.5 cc-linker sync

手动同步两端会话。

### 7.6 cc-linker status

查看桥接工具状态。

### 7.7 cc-linker hook

管理 Claude Code 钩子：install / uninstall / status。

### 7.8 cc-linker register

内部命令，由 Hook 调用。容错设计：永不阻塞 Claude Code 启动。

### 7.9 cc-linker export

导出会话为 markdown/text/json。流式处理，避免内存问题。

### 7.10 cc-linker search

搜索会话标题和内容。

### 7.11 cc-linker clean

清理无效记录。

### 7.12 cc-linker feishu-cmd

飞书侧 `/bridge` 命令入口。cc-connect 通过 `[[commands]]` 机制调用。

## 8. 飞书侧命令

### 8.1 注册方式

```toml
# cc-connect config.toml
[[commands]]
name = "bridge"
description = "跨平台会话管理"
exec = "cc-linker feishu-cmd --caller {{user}} {{args}}"
```

### 8.2 /bridge list

列出所有会话（含 CLI 发起的）。

**权限模型**：
- 飞书用户只能看自己的 cc-connect 会话 + 所有 cli 会话
- 缺少 caller 时拒绝返回列表（fail closed）

### 8.3 /bridge switch

- 已有映射：调用 bridge API，无需重启
- 首次映射：MVP 阶段只输出提示

### 8.4 /bridge resume

输出终端恢复命令。

### 8.5 /bridge status

输出桥接状态摘要。

## 9. Hook 机制

### 9.1 SessionStart Hook

在 Claude Code 每次启动时触发，注册当前会话到 registry。

**环境变量探测**（多源，按优先级）：
1. `CLAUDE_CODE_SESSION_ID`
2. `SESSION_ID`
3. `CLAUDE_SESSION_ID`

**容错**：
- 任何异常被捕获，永不阻塞 Claude Code 启动
- 失败时记录到 `~/.cc-linker/hook.log`
- 由 CLI 命令前的兜底扫描发现遗漏

## 10. 配置管理

### 10.1 配置文件

`~/.cc-linker/config.toml`（可选）。

### 10.2 优先级

```
命令行参数 > 环境变量 > 配置文件 > 默认值
```

### 10.3 环境变量

| 环境变量 | 配置项 |
|----------|--------|
| `CC_LINKER_CONFIG_PATH` | 配置文件路径 |
| `CC_LINKER_REGISTRY_PATH` | Registry 路径 |
| `CC_LINKER_LOG_LEVEL` | 日志级别 |
| `CC_LINKER_TOKEN` | bridge API token |
| `CC_LINKER_API_URL` | bridge API 地址 |

## 11. 错误处理

### 11.1 错误码

| 错误码 | 说明 | 解决方式 |
|--------|------|----------|
| E001 | Registry 不存在 | 运行 `cc-linker init` |
| E002 | JSONL 文件不存在 | 会话已被清理 |
| E007 | 注册表被锁 | 等待或删除 .lock 文件 |
| E008 | cwd 目录不存在 | 使用 --cwd 指定替代目录 |

### 11.2 全局错误处理

- 所有命令入口用 `try/catch` 包裹
- `CCLinkerError` 提供错误码、消息、详情和修复建议
- 未知错误打印堆栈

## 12. 测试策略

### 12.1 测试结构

```
tests/
├── unit/              # 单元测试
├── integration/       # 集成测试
└── fixtures/          # 测试数据
```

### 12.2 覆盖率目标

| 模块 | 目标 |
|------|------|
| Registry | > 90% |
| Scanner | > 80% |
| CLI 命令 | > 70% |
| Utils | > 90% |

### 12.3 测试要点

- Registry：CRUD、锁、备份轮转、损坏恢复
- Scanner：来源判别、增量扫描、边界情况
- CLI：命令参数、交互流程、错误处理
- 并发：多进程同时写入 registry

## 13. 开发顺序

1. **项目初始化**：package.json、tsconfig、依赖安装
2. **Utils 层**：errors、paths、config、logger、lock
3. **Registry 层**：types、registry（CRUD + 锁 + 备份）
4. **Scanner 层**：cc-connect、jsonl、cache、统一入口
5. **CLI 命令**：init → list → resume → show → sync → status
6. **Hook**：session-start、install/uninstall
7. **飞书命令**：feishu-cmd
8. **高级命令**：export、search、clean

## 14. 性能基准

基于实测数据（718 JSONL 文件，453MB）：

| 操作 | 耗时 |
|------|------|
| 首次全量扫描 | 371ms |
| 增量扫描（无变化） | 1ms |
| cc-connect 扫描 | 1ms |
| Registry 读取 | < 5ms |
| Registry 写入（含锁） | < 50ms |

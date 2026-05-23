# cc-linker 产品文档

> 让飞书（cc-connect）和终端（Claude Code CLI）之间的对话像切换设备一样无缝。

***

## 一、概述

### 1.1 产品定位

cc-linker 是一个轻量级本地桥接工具，解决 cc-connect 和 Claude Code CLI 之间的**会话发现壁垒**问题。

cc-connect 将 Claude Code 桥接到飞书、微信等 IM 平台，让用户可以远程发起和继续 AI 编程对话。但它和 Claude Code 原生 CLI 之间存在会话隔离——两端各自管理会话列表，互不可见。

cc-linker 通过建立一个**统一的会话注册表（Session Registry）**，让两端会话互相可见、互相恢复。

### 1.2 核心原理

cc-connect 的每个会话都有一个 `agent_session_id` 字段（UUID），它**直接对应 Claude Code 原生的会话 ID**。对应的 JSONL 文件存在于 `~/.claude/projects/<项目目录>/<agent_session_id>.jsonl`，包含完整的对话数据（用户消息、助手回复、thinking block、tool\_use/tool\_result、完整的 parentUuid 链）。

因此，cc-linker 不需要做任何数据格式转换——只需要做一个**发现 + 注册 + 引导**的薄层。

### 1.3 用户场景

| 场景       | 描述                     | 解决方式                                              |
| -------- | ---------------------- | ------------------------------------------------- |
| 办公室 → 通勤 | 在公司用 CLI 开始，路上想直接在飞书继续 | CLI 会话自动注册到 registry，飞书 `/bridge switch` 可首次映射并继续 |
| 手机 → 电脑  | 在飞书讨论了需求方案，回工位想在终端实现   | `cc-linker resume` 一键恢复飞书会话                       |
| 多人协作     | Tech Lead 想查看所有成员的会话进展 | `cc-linker list` 集中查看                             |
| 频繁切换     | 同一会话在飞书和终端之间来回切换       | 首次映射后可 `/bridge switch` + `resume` 往返，同步同一 JSONL  |

### 1.4 MVP 边界

一期（MVP）承诺以下能力：

- 发现并注册 `cc-connect` / Claude Code CLI 会话
- 在终端侧统一 `list / show / resume`
- 在飞书侧统一 `/bridge list`、`/bridge resume` 与 `/bridge switch`
- 对**尚未映射到 cc-connect 的 CLI 会话**，允许首次写入 `~/.cc-connect/sessions/*.json` 创建映射
- 在 cc-connect 不支持运行时热加载时，由 `/bridge switch` 触发**受控重启/重载**使首次映射生效

### 1.5 一期限制

上述能力在一期内以“受限支持”的方式提供，前提如下：

- `cc-connect` 与 Claude Code CLI 运行在同一台机器
- 当前机器上的 `cc-connect` session JSON 可由 `cc-linker` 读写
- 首次映射 CLI 会话时，用户需要显式确认可能发生的重启与对话中断
- 如果检测到其他活跃用户，会先列出受影响对象，再由当前操作者确认是否继续
- 该能力依赖 cc-connect 当前的 session JSON 结构与重载行为；后续优先用公开 API 替代

***

## 二、架构

### 2.1 整体架构

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
│  │         ~/.cc-linker/registry.json           │   │
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

### 2.2 三大组件

| 组件                    | 形态                           | 职责                                                |
| --------------------- | ---------------------------- | ------------------------------------------------- |
| **Registry**          | `~/.cc-linker/registry.json` | 统一的会话索引，包含所有来源的会话元数据                              |
| **CLI 工具**            | `cc-linker` 命令               | 终端用户交互入口：list / resume / sync                     |
| **Scanner + Hook**    | 后台扫描器 + Claude Code 钩子       | 自动发现和注册新会话                                        |
| **Bridge API Client** | HTTP 客户端                     | 调用 cc-connect 的 `/bridge/sessions/switch` 实现无重启切换 |

### 2.3 数据流

```
发现流程：

cc-connect session JSON ──┐
                          ├──► Scanner ──► Registry
Claude Code JSONL 文件  ──┘
                            │
                            ▼
                    Claude Code 启动
                    (SessionStart hook)
                            │
                            ▼
                       注册到 Registry
```

```
恢复流程（飞书 → 终端）：

用户: cc-linker resume
         │
         ▼
读取 registry.json
         │
         ▼
找到目标 UUID
         │
         ▼
权限检查（飞书侧）
  - 检查 owner 字段
  - 检查 visibility 字段
  - 检查 shared_with 字段
         │
         ▼
验证 JSONL 文件存在
         │
         ▼
执行: cd <cwd> && claude --resume <uuid>
         │
         ▼
Claude Code 加载完整 JSONL 历史
```

```
切换流程（终端 → 飞书）：

用户: /bridge switch <uuid或短前缀>
         │
         ▼
cc-linker 从 registry 找到目标 UUID
         │
         ├─ 已存在 cc-connect 映射 ──► POST /bridge/sessions/switch
         │                              │
         │                              ▼
         │                         无需重启，即时生效
         │
         └─ 首次映射 CLI 会话 ───────► 写入 session JSON
                                        │
                                        ▼
                               用户确认后重启/重载 cc-connect
                                        │
                                        ▼
                               下次用户消息继续该 agent_session_id
```

> **说明**：首次映射链路是一期能力，但必须带确认提示、并发用户提示、乐观锁校验和失败回退。

***

## 三、Session Registry 规范

### 3.1 文件位置

```
~/.cc-linker/registry.json
```

### 3.2 数据结构

```json
{
  "version": 1,
  "updated_at": "2026-05-03T10:30:00Z",
  "sessions": {
    "b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec": {
      "origin": "cc-connect",
      "source": "feishu:ou_xxx123",
      "platform": "feishu",
      "owner": "feishu:ou_xxx123",
      "owner_user_key": "feishu:chat_xxx:ou_xxx123",
      "cwd": "/Users/wuyujun",
      "project_name": "Home",
      "jsonl_path": "/Users/wuyujun/.claude/projects/-Users-wuyujun/b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec.jsonl",
      "cc_connect_session_id": "s2",
      "cc_connect_session_file": "/Users/wuyujun/.cc-connect/sessions/feishu-main.json",
      "created_at": "2026-05-03T09:00:00Z",
      "last_active": "2026-05-03T10:30:00Z",
      "title": "API 认证模块设计",
      "message_count": 28,
      "last_message_preview": "好的，我来实现 JWT 认证中间件...",
      "status": "active"
    },
    "a3f8c1d2-xxxx-yyyy-zzzz-123456789abc": {
      "origin": "cli",
      "source": "terminal",
      "platform": null,
      "owner": "terminal:wuyujun",
      "cwd": "/Users/wuyujun/Git/my-backend",
      "project_name": "my-backend",
      "jsonl_path": "/Users/wuyujun/.claude/projects/-Users-wuyujun-Git-my-backend/a3f8c1d2-xxxx-yyyy-zzzz-123456789abc.jsonl",
      "created_at": "2026-05-03T08:00:00Z",
      "last_active": "2026-05-03T08:45:00Z",
      "title": "数据库迁移方案",
      "message_count": 15,
      "last_message_preview": "migration 脚本已经写好了，需要测试一下...",
      "status": "active"
    }
  }
}
```

### 3.3 字段说明

| 字段           | 类型      | 必填 | 说明                   |
| ------------ | ------- | -- | -------------------- |
| `version`    | int     | 是  | Registry 格式版本号，当前为 1 |
| `updated_at` | ISO8601 | 是  | 最后一次更新时间             |
| `sessions`   | object  | 是  | 以 UUID 为 key 的会话映射   |

#### Session 对象字段

| 字段                        | 类型        | 必填 | 说明                                                                                                                                                                          |
| ------------------------- | --------- | -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin`                  | string    | 是  | 会话来源：`"cli"` 或 `"cc-connect"`。**主判别**：UUID 是否出现在 cc-connect session JSON 的 `agent_session_id` 集合中；**辅助判别**：JSONL 中 `entrypoint="sdk-cli"`（兜底，应对其他 SDK 工具产生的会话）；都不命中归为 `cli` |
| `source`                  | string    | 是  | 来源标识：飞书用户 ID / `"terminal"`                                                                                                                                                 |
| `platform`                | string    | 否  | 平台类型：`"feishu"` / `"weixin"` / `null`                                                                                                                                       |
| `owner`                   | string    | 否  | 会话创建者标识（如 `"feishu:ou_xxx"` 或 `"terminal:wuyujun"`）。用于展示和权限过滤，不作为 cc-connect 内部主键                                                                                           |
| `owner_user_key`          | string    | 否  | cc-connect 内部用户键（如 `"feishu:<chat_id>:<user_id>"`）。优先从 `user_sessions` 反查得到，`active_session` 仅作为补充；用于飞书侧权限控制与 `reset_on_idle` 检测                                            |
| `visibility`              | string    | 否  | 会话可见性：`"private"`（默认，仅 owner 可见）/ `"team"`（同一团队可见）/ `"public"`（所有人可见）                                                                                                       |
| `shared_with`             | string\[] | 否  | 共享给哪些用户（当 `visibility="private"` 时生效）                                                                                                                                       |
| `cwd`                     | string    | 是  | 会话创建时的工作目录（从 JSONL 首条记录的 `cwd` 字段提取），用于 `resume` 时切换到正确目录                                                                                                                   |
| `project_name`            | string    | 否  | 人类可读的项目名称。提取优先级：① 项目配置文件中读取 name（见下方各格式处理规则）② 目录名最后一部分 ③ 如 cwd 为用户 home 目录则显示 `"Home"`                                                                                      |
| `jsonl_path`              | string    | 是  | JSONL 文件的绝对路径（扫描时直接记录，不依赖路径推断）。例如 `/Users/wuyujun/.claude/projects/-Users-wuyujun/abc.jsonl`。文件被移动后由下次扫描自动修正                                                                |
| `project_dir`             | string    | 否  | Claude Code 的 project 目录名（如 `-Users-wuyujun-Git-cc-linker`），仅用于显示，不参与路径定位                                                                                                   |
| `cc_connect_session_id`   | string    | 否  | cc-connect 内部会话 ID（如 `"s2"`）。表示“当前扫描时观察到该 UUID 在某个 cc-connect session 文件中已有映射”，不是永久主键                                                                                       |
| `cc_connect_session_file` | string    | 否  | `cc_connect_session_id` 所在的 cc-connect session JSON 文件路径。用于 stale 检测和问题诊断                                                                                                   |
| `created_at`              | ISO8601   | 是  | 会话创建时间                                                                                                                                                                      |
| `last_active`             | ISO8601   | 是  | 最后活跃时间（从 JSONL 最后一条 assistant/user 类型记录的 `timestamp` 字段提取）                                                                                                                  |
| `title`                   | string    | 否  | 会话标题。提取规则：① 优先取 JSONL 中 `ai-title` 类型记录 ② 无则取 `last-prompt` 的 `lastPrompt` 前 50 字符 ③ 均无则用 `"Untitled (<uuid前8位>)"`                                                          |
| `message_count`           | int       | 否  | 消息总数（JSONL 文件行数近似）                                                                                                                                                          |
| `last_message_preview`    | string    | 否  | 最后一条消息预览（从 JSONL 最后一条 assistant 类型记录的 `message.content` 中取第一个 `type="text"` 的文本，截取前 100 字符）                                                                                 |
| `status`                  | string    | 否  | 会话状态：`"active"` / `"archived"` / `"corrupted"`                                                                                                                              |

> **owner 说明**：cc-connect 会话的归属关系以 `user_sessions` 为主来源，因为大量历史会话并不在 `active_session` 中；`active_session` 只反映“当前活跃会话”，不能单独用来恢复 owner。

> **项目名推断格式处理规则**：
>
> - `package.json`：取 `"name"` 字段原值
> - `go.mod`：取 `module` 路径的最后一段（如 `module github.com/user/repo` → `"repo"`）
> - `Cargo.toml`：取 `[package]` 段下的 `name` 字段
> - `pyproject.toml`：优先取 `[project].name`，其次取 `[tool.poetry].name`

> **说明**：MVP 阶段不再维护 `past_uuids` 字段。cc-connect 的 `reset_on_idle_mins` 触发时，每个 `agent_session_id` 在 registry 中独立存在，由 resume 时实时检测并提示跳转（详见 9.3 节）。

### 3.4 并发安全

Registry 可能被多个进程同时写入（Scanner、Hook、CLI），需要文件锁：

- **锁粒度**：锁整个 registry.json 文件（而非单个条目），实现简单且足够安全
- **读写分离**：读取使用共享锁（`LOCK_SH`），写入使用独占锁（`LOCK_EX`）
- **短持锁策略**：Scanner 先在内存中完成解析和差异计算，再短时间持锁写入
- **原子写入**：写临时文件后 rename，避免写入中断导致文件损坏
- **重试机制**：获取锁失败时等待重试（最多 3 次，每次等待 100ms \* attempt），而不是直接失败
- **超时设置**：获取锁超时 5 秒，超时后返回错误码 `E007`

**备份策略**：

- **独立备份目录**：备份文件存放在 `~/.cc-linker/backups/` 目录
- **带时间戳**：备份文件名包含时间戳（如 `registry.20260503_153000.json`）
- **轮转机制**：保留最近 3 个版本，自动删除最旧的备份
- **软链接**：保留 `registry.json.bak` 软链接指向最新备份，方便快速恢复
- **备份验证**：恢复前验证备份文件的 `version` 字段，确保完整性

**备份轮转实现**：

```python
def _rotate_backup(self):
    """轮转备份：保留最近 N 个版本"""
    # 1. 删除最旧的备份
    backups = sorted(self.backup_dir.glob('registry.*.json'))
    while len(backups) >= self.max_backups:
        oldest = backups.pop(0)
        oldest.unlink()

    # 2. 创建新备份（带时间戳，同秒冲突时追加序号）
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_path = self.backup_dir / f'registry.{timestamp}.json'
    counter = 0
    while backup_path.exists():
        counter += 1
        backup_path = self.backup_dir / f'registry.{timestamp}_{counter}.json'

    if self.path.exists():
        shutil.copy2(self.path, backup_path)

    # 3. 同时保留一个 .bak 软链接
    bak_path = self.path.with_suffix('.json.bak')
    if bak_path.exists() or bak_path.is_symlink():
        bak_path.unlink()
    bak_path.symlink_to(backup_path)
```

**并发风险评估**：

- 高风险：CLI 命令前的扫描与 Hook 启动注册可能同时写入；`cc-linker watch`（如启用）与 Hook 可能同时写入
- 中风险：用户手动执行 `cc-linker sync` 时与其他 CLI 命令冲突
- 低风险：多个 CLI 命令同时执行

**实现示例**：

```python
def write_with_lock(data: dict, max_retries: int = 3):
    lock_fd = open(lock_path, 'w')
    for attempt in range(max_retries):
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # 成功获取锁
            atomic_write(data)
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            return
        except BlockingIOError:
            # 锁被占用，等待后重试
            time.sleep(0.1 * (attempt + 1))
    raise CCLinkerError('E007', '注册表被锁，等待超时')
```

**第三方进程禁止直写 registry**：

`registry.json` 由 cc-linker 内部多个组件（Scanner / Hook / CLI）共享，统一使用 fcntl.flock（advisory lock）。请勿用第三方工具（脚本、文本编辑器等）直接修改 `registry.json`，否则可能：

- 读到不一致的中间状态（写入未完成）
- 写入冲突（advisory lock 对非 cc-linker 进程无效）
- 触发自动备份将损坏状态轮转写入

如需批量操作 registry，请通过 `cc-linker` 命令进行（list / sync / clean / show 都已封装锁逻辑）。如需脚本化集成，使用 `cc-linker list --format json` 等公开输出。

***

## 四、CLI 命令设计

### 4.1 `cc-linker init`

初始化 registry 并扫描已有会话。

```bash
cc-linker init
```

**输出**：

```
✅ Created ~/.cc-linker/registry.json
🔍 Scanning for existing sessions...
   Found 2 cc-connect sessions
   Found 3 Claude Code sessions
✅ Registered 5 sessions total

Next steps:
  1. Run 'cc-linker hook install' to install Claude Code hook
  2. Run 'cc-linker list' to view all sessions
  3. Run 'cc-linker resume' to resume a session
```

**行为**：

1. 创建 `~/.cc-linker/` 目录（权限 `700`）
2. 创建空的 `registry.json`（权限 `600`）
3. 运行一次完整扫描（使用并发扫描提升性能）
4. 提示后续步骤

### 4.2 `cc-linker list`

列出所有可恢复的会话。

```bash
cc-linker list [OPTIONS]
```

**选项**：

| 选项                  | 简写   | 说明                                                  |
| ------------------- | ---- | --------------------------------------------------- |
| `--project <name>`  | `-p` | 按项目名过滤                                              |
| `--platform <name>` | `-P` | 按平台过滤（feishu/weixin）                                |
| `--origin <type>`   | `-o` | 按来源过滤（cli/cc-connect）                               |
| `--active`          | `-a` | 只显示最近 2 小时内活跃的会话                                    |
| `--format <type>`   | `-f` | 输出格式：table（默认）/ json / csv                          |
| `--limit <n>`       | `-l` | 最多显示 n 条（默认 20）                                     |
| `--sort <field>`    | `-s` | 排序字段：last\_active（默认）/ created\_at / message\_count |

**输出示例**（table 格式）：

```
┌──────────┬────────────────────┬──────────┬──────────┬──────┬─────────────────┐
│ Ref      │ 标题               │ 来源     │ 项目     │ 消息 │ 最后活跃        │
├──────────┼────────────────────┼──────────┼──────────┼──────┼─────────────────┤
│ b21d6d04 │ API 认证模块设计   │ 🟢 飞书  │ Home     │ 28   │ 3 分钟前        │
│ a3f8c1d2 │ 数据库迁移方案     │ 💻 终端  │ backend  │ 15   │ 1 小时前        │
│ 93ab7c10 │ 前端组件重构       │ 🟢 飞书  │ frontend │ 42   │ 2 小时前        │
└──────────┴────────────────────┴──────────┴──────────┴──────┴─────────────────┘

共 3 个会话。使用 cc-linker resume <Ref> 或完整 UUID 恢复会话。
```

**输出示例**（json 格式）：

```json
[
  {
    "ref": "b21d6d04",
    "uuid": "b21d6d04-...",
    "title": "API 认证模块设计",
    "origin": "cc-connect",
    "platform": "feishu",
    "project_name": "Home",
    "cwd": "/Users/wuyujun",
    "message_count": 28,
    "last_active": "2026-05-03T10:27:00Z"
  }
]
```

### 4.3 `cc-linker resume`

恢复指定会话到 Claude Code CLI。

```bash
cc-linker resume [TARGET] [OPTIONS]
```

**TARGET 参数**：

- UUID：直接指定会话 ID
- 短前缀：指定 UUID 的前 8-12 位，要求全局唯一
- 不指定：进入交互式选择

**选项**：

| 选项                  | 简写     | 说明              |
| ------------------- | ------ | --------------- |
| `--search <query>`  | `-s`   | 按标题模糊搜索         |
| `--latest`          | `-L`   | 恢复最近活跃的会话       |
| `--project <name>`  | `-p`   | 指定项目的最近活跃会话     |
| `--platform <name>` | `-P`   | 指定平台的最近活跃会话     |
| `--user <id>`       | `-u`   | 指定飞书用户的会话       |
| `--dry-run`         | `-n`   | 显示将要执行的命令，不实际执行 |
| `--no-confirm`      | <br /> | 跳过 CWD 变更提示     |

**交互式选择流程**：

```
$ cc-linker resume

可选会话：
  b21d6d04  API 认证模块设计 (🟢 飞书, Home, 28条, 3分钟前)
  a3f8c1d2  数据库迁移方案 (💻 终端, backend, 15条, 1小时前)
  93ab7c10  前端组件重构 (🟢 飞书, frontend, 42条, 2小时前)

请输入 Ref / UUID (或输入关键词搜索):
```

**执行逻辑**：

1. 确定目标 UUID（UUID / 唯一短前缀 / 交互选择 / 搜索）
2. 从 registry 读取 entry：`cwd`、`jsonl_path`、`origin`、`cc_connect_session_id`
3. **验证 JSONL 文件存在**（直接读 `entry.jsonl_path`，不再依赖路径推断）
   - 文件存在 → 继续步骤 4
   - 文件不存在 → 全量扫描 `~/.claude/projects/<*>/<uuid>.jsonl` 查找
     找到则更新 `registry.jsonl_path` 后继续；仍找不到则标记 `status=corrupted`（E002）
4. **若 origin=cc-connect，校验是否仍是当前 active\_session**（`reset_on_idle` 检测）
   - 反查 cc-connect session JSON 中目标 UUID 的 `user_key` 与对应的 `active_session`
   - 若目标 UUID ≠ 当前 active UUID，提示用户：「此会话已被新会话替代（<新会话标题>），恢复哪个？1) 旧会话 2) 最新会话」
   - 详见 9.3 节
5. **检查目标 cwd 与当前工作目录是否一致**
   - 不一致时提示：「⚠️ 此会话在 `{cwd}` 中创建，将切换到该目录并恢复会话。继续？\[Y/n]」
   - 用户确认或 `--no-confirm` 时继续；拒绝则退出
   - 若 cwd 目录不存在（E008），允许用户通过 `--cwd <path>` 手动指定替代目录
6. **执行恢复（进程替换，非启动子进程）**：

```python
os.chdir(cwd)
claude_bin = config.get('general.claude_bin', 'claude')
os.execvp(claude_bin, [claude_bin, '--resume', uuid])
# cc-linker 进程被 claude 替换，Claude Code 退出后用户回到原 shell
```

- 假设 `claude` 命令在 PATH 中，可通过配置项 `general.claude_bin` 指定自定义路径
- 用 `execvp` 而非 `subprocess.run`：cc-linker 不会挂着等子进程，行为等同直接敲 `claude --resume`
- Go 实现等价于 `syscall.Chdir(cwd) + syscall.Exec(...)`

### 4.4 `cc-linker show`

查看指定会话的详细信息。

```bash
cc-linker show <UUID或短前缀>
```

**输出示例**：

```
会话详情
───────────────────────────────────────
UUID:        b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec
标题:        API 认证模块设计
来源:        🟢 飞书 (ou_xxx123)
项目:        Home
工作目录:    /Users/wuyujun
状态:        active
创建时间:    2026-05-03 09:00:00
最后活跃:    2026-05-03 10:30:00
消息数:      28

最近消息:
  User:  好的，现在开始实现 JWT 中间件
  Agent: 好的，我来实现 JWT 认证中间件...

JSONL 文件: ~/.claude/projects/-Users-wuyujun/b21d6d04-....jsonl

操作:
  cc-linker resume b21d6d04   恢复此会话
  cc-linker export b21d6d04   导出为 markdown
```

### 4.5 `cc-linker sync`

手动同步两端会话。

```bash
cc-linker sync [OPTIONS]
```

**选项**：

| 选项        | 说明                        |
| --------- | ------------------------- |
| `--scan`  | 只扫描，不更新 registry（dry run） |
| `--force` | 强制刷新，忽略缓存                 |
| `--clean` | 清理已不存在 JSONL 的会话记录        |

**输出**：

```
🔄 Syncing sessions...
   Scanning cc-connect sessions... found 2
   Scanning Claude Code sessions... found 3
   New sessions registered: 1
   Sessions updated: 2
   Sessions cleaned: 0
✅ Sync complete. Total registered: 5
```

### 4.6 `cc-linker status`

查看桥接工具状态。

```bash
cc-linker status
```

**输出**：

```
cc-linker Status
───────────────────────────────────────
Registry:      ~/.cc-linker/registry.json
Version:       1
Last sync:     2 minutes ago
Total sessions: 5
  From CLI:       3
  From cc-connect: 2
  Active:         4
  Archived:       1

Scanners:
  cc-connect scanner: enabled
  Claude Code hook:   installed

Commands:
  cc-linker list       List all sessions
  cc-linker resume     Resume a session
  cc-linker sync       Sync sessions
  cc-linker hook       Manage hooks
```

### 4.7 `cc-linker hook`

管理 Claude Code 钩子。

```bash
# 安装钩子
cc-linker hook install

# 卸载钩子
cc-linker hook uninstall

# 检查状态
cc-linker hook status

# 手动触发（测试用）
cc-linker hook session-start --session-id <uuid>
```

**安装时行为**：

```
$ cc-linker hook install

Installing Claude Code SessionStart hook...

Detected Claude Code settings file: ~/.claude/settings.json
Adding hook configuration...

✅ Hook installed successfully.

The following was added to ~/.claude/settings.json:

{
  "hooks": {
    "SessionStart": "cc-linker hook session-start"
  }
}

You can remove it anytime with: cc-linker hook uninstall
```

### 4.7b `cc-linker register`（内部命令）

将单个会话注册到 Registry。主要由 Hook 脚本调用，不建议用户直接使用。

```bash
cc-linker register <UUID> [OPTIONS]
```

**选项**：

| 选项                | 简写     | 说明                           |
| ----------------- | ------ | ---------------------------- |
| `--origin <type>` | `-o`   | 会话来源：`cli`（默认）/ `cc-connect` |
| `--cwd <path>`    | `-c`   | 工作目录（默认当前目录）                 |
| `--source <id>`   | <br /> | 来源标识（默认 `"terminal"`）        |
| `--dry-run`       | `-n`   | 显示将要注册的条目，不实际写入              |

**行为**：

1. 校验 UUID 格式（必须为合法 UUID，否则 E005）
2. 读取 `registry.json`（共享锁）
3. 检查是否已存在该 UUID → 已存在则更新 `last_active` 和 `cwd`，不重复创建
4. 写入新条目（独占锁 + 原子写入）
5. 记录到 `~/.cc-linker/hook.log`

**容错**：

- 任何关键字段缺失时不报错退出，只记录到 `hook.log`
- 所有异常被捕获，**永不阻塞 Claude Code 启动**
- 若 registry 被锁，等待重试（最多 3 次，每次 100ms \* attempt），超时则记录日志后退出

### 4.8 `cc-linker export`

导出会话为可读格式。

```bash
cc-linker export <编号或UUID> [OPTIONS]
```

**选项**：

| 选项                   | 说明                                      |
| -------------------- | --------------------------------------- |
| `--format <type>`    | 输出格式：markdown（默认）/ text / json          |
| `--output <path>`    | 输出文件路径（无此选项时输出到文件 `./export-<uuid>.md`） |
| `--include-thinking` | 包含 thinking block                       |
| `--include-tools`    | 包含工具调用详情                                |

**说明**：markdown 默认输出到 `./export-<uuid>.md` 文件（不输出到 stdout，可读性更好）。

**安全防护**：

- JSONL 文件大小超过 100MB 时提示确认，避免内存溢出
- 单条消息内容超过 1MB 时截断并标注 `[truncated]`
- 支持 `--max-messages <n>` 限制导出条数
- **流式处理**：逐行读取 JSONL，边读边写入输出文件，避免一次性加载整个文件
- **定期刷新**：每处理 100 条消息刷新缓冲区，避免缓冲区过大

**流式导出实现**：

```python
def export_session(session_id: str, output_path: Path, max_messages: int = None):
    """导出会话，使用流式处理避免内存问题"""
    jsonl_path = find_jsonl_file(session_id)
    if not jsonl_path:
        raise CCLinkerError('E002', 'JSONL 文件不存在')

    # 检查文件大小
    file_size = jsonl_path.stat().st_size
    if file_size > 100 * 1024 * 1024:  # 100MB
        print(f"警告：文件大小 {file_size / 1024 / 1024:.1f}MB，导出可能需要较长时间")
        if not confirm("继续？"):
            return

    # 流式处理
    with open(output_path, 'w') as out_f:
        message_count = 0
        with open(jsonl_path) as in_f:
            for line in in_f:
                if max_messages and message_count >= max_messages:
                    break

                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue  # 跳过损坏的行

                # 只处理用户和助手消息
                if entry.get('type') not in ('user', 'assistant'):
                    continue

                message_count += 1

                # 格式化并写入
                formatted = format_message(entry, format)
                out_f.write(formatted)

                # 定期刷新，避免缓冲区过大
                if message_count % 100 == 0:
                    out_f.flush()

    print(f"导出完成：{output_path} ({message_count} 条消息)")
```

**输出示例**（markdown 格式）：

```markdown
# API 认证模块设计

> Session: b21d6d04-...
> Source: cc-connect (feishu)
> Created: 2026-05-03 09:00:00
> Messages: 28

---

**User** (09:00): 帮我设计一个用户认证模块

**Assistant** (09:01): 好的，我来帮你设计用户认证模块。

常见的认证方案有：
1. JWT (JSON Web Token)
2. OAuth 2.0
3. Session-based

...

**User** (09:30): 好的，现在开始实现 JWT 中间件

**Assistant** (09:31): 好的，我来实现 JWT 认证中间件...
```

### 4.9 `cc-linker search`

搜索会话。

```bash
cc-linker search <query> [OPTIONS]
```

**选项**：

| 选项             | 说明                 |
| -------------- | ------------------ |
| `--in-title`   | 只搜索标题（默认搜索标题+消息预览） |
| `--in-content` | 搜索 JSONL 内容（较慢）    |

### 4.10 `cc-linker clean`

清理 registry 中的无效记录。

```bash
cc-linker clean [OPTIONS]
```

**选项**：

| 选项                    | 说明            |
| --------------------- | ------------- |
| `--dry-run`           | 预览将清理哪些，不实际删除 |
| `--older-than <days>` | 清理超过 N 天不活跃的  |

### 4.11 `cc-linker feishu-cmd`

飞书侧 `/bridge` 命令的路由入口。cc-connect 通过 `exec = "cc-linker feishu-cmd {{args}}"` 调用，负责解析参数并格式化输出。

```bash
cc-linker feishu-cmd <subcommand> [args...]
```

**支持的子命令**：

| 子命令                                    | 对应飞书命令                    | 说明                                   |
| -------------------------------------- | ------------------------- | ------------------------------------ |
| `list [--active\|--origin\|--project]` | `/bridge list`            | 读取 registry 格式化会话列表                  |
| `switch <target>`                      | `/bridge switch <target>` | 已映射会话直接切换；未映射 CLI 会话首次创建映射并在确认后重启/重载 |
| `resume <target>`                      | `/bridge resume <target>` | 输出终端恢复命令                             |
| `status`                               | `/bridge status`          | 输出桥接状态摘要                             |

**执行逻辑**：

```
1. 解析子命令（feishu-cmd 后的第一个参数）
2. 读取 ~/.cc-linker/registry.json（共享锁）
3. 执行对应操作
4. 输出格式化结果到 stdout（cc-connect 捕获并发送给飞书用户）
```

**输出格式**：默认使用 Markdown 文本（飞书自动渲染），支持飞书卡片模式（通过 `--card` 参数启用）。

**错误处理**：

- 非零退出码 → cc-connect 不发送消息，视为错误
- 零退出码 + stderr 内容 → 作为警告信息追加到回复末尾
- 零退出码 + stdout 内容 → 作为机器人回复发送

***

## 五、飞书侧命令设计

### 5.0 设计原理

cc-connect 已内置 `/list`、`/switch`、`/delete` 等会话管理命令（`filter_external_sessions = false` 时显示 agent 的全部会话）。但这些命令显示的是 **"用户-项目配对"** 粒度，不是跨项目的完整会话列表，也无法展示 CLI 会话的详细信息（标题、消息数、来源等）。

因此，cc-linker 通过 cc-connect 的 `[[commands]]` 机制注册 `/bridge` 命名空间的自定义命令，提供跨项目、跨用户的统一会话管理体验。

#### 注册方式

在 cc-connect 的 `config.toml` 中添加自定义命令，或在飞书中通过 `/commands` 动态添加：

```toml
# config.toml 中添加
[[commands]]
name = "bridge"
description = "跨平台会话管理（CLI + 飞书）/ Cross-platform session management"
exec = "cc-linker feishu-cmd --caller {{user}} {{args}}"
```

或者在飞书聊天中动态注册：

```
/commands addexec bridge cc-linker feishu-cmd --caller {{user}} {{args}}
```

用户发送 `/bridge list` 时，cc-connect 执行 `cc-linker feishu-cmd --caller <user> list`，cc-linker 读取 registry.json 后格式化输出，返回给飞书用户。

### 5.1 `/bridge list`

列出所有会话（包含 CLI 发起的）。

```
/bridge list [OPTIONS]
```

**权限模型（MVP）**：

cc-linker 通过命令行参数接收调用者标识（由 cc-connect 在 `[[commands]]` 中注入）：

```toml
# cc-connect config.toml
[[commands]]
name = "bridge"
exec = "cc-linker feishu-cmd --caller {{user}} {{args}}"
```

> **注意**：若 cc-connect 当前版本不支持 `{{user}}` 模板变量，MVP 采取\*\*失败关闭（fail closed）\*\*策略：飞书侧 `/bridge` 命令直接报错并提示管理员补充 `--caller` 注入，不默认放开全部会话可见性。

**默认可见性规则**：

| origin     | owner 取值                              | 飞书 list 默认 | 终端 list 默认 |
| ---------- | ------------------------------------- | ---------- | ---------- |
| cc-connect | `feishu:<user_id>` / `owner_user_key` | 仅 owner 可见 | 全部可见       |
| cli        | `terminal:<unix_user>`                | 全部可见（单机共享） | 全部可见       |

**过滤逻辑**：

```python
def filter_for_caller(sessions, caller):
    """caller 形如 'feishu:ou_xxx' 或 'terminal:wuyujun' 或 None"""
    if caller is None:
        raise CCLinkerError('E019', '缺少调用者身份，拒绝返回飞书会话列表')
    if caller.startswith('terminal:'):
        return sessions  # 终端调用看全部
    # 飞书调用：自己的 cc-connect 会话 + 全部 cli 会话 + 显式共享的会话
    return [s for s in sessions if (
        s['origin'] == 'cli'
        or s.get('owner_user_key') == caller
        or s.get('owner') == normalize_owner(caller)
        or s.get('visibility') == 'public'
        or caller in (s.get('shared_with') or [])
    )]

def normalize_owner(caller):
    """feishu:<chat_id>:<user_id> -> feishu:<user_id>"""
    parts = caller.split(":")
    if len(parts) >= 3:
        return f"{parts[0]}:{parts[-1]}"
    return caller
```

`--all` 选项保留为未来扩展（需要管理员权限验证，Phase 3+）。

**飞书消息输出**：

```
📋 我的会话（共 3 个）

`b21d6d04` API 认证模块设计
   💬 28 条消息 | 🕒 3 分钟前
   📂 Home | 📱 来自飞书
   最后: "好的，我来实现 JWT 认证中间件..."

`a3f8c1d2` 数据库迁移方案
   💬 15 条消息 | 🕒 1 小时前
   📂 backend | 💻 来自终端
   最后: "migration 脚本已经写好了..."

`93ab7c10` 前端组件重构
   💬 42 条消息 | 🕒 2 小时前
   📂 frontend | 📱 来自飞书
   最后: "组件拆分完成，需要调整样式..."

回复 /bridge switch <Ref> 切换到此会话
回复 /bridge resume <Ref> 在终端恢复此会话
```

**可选参数**：

- `/bridge list --active` — 只显示最近 2 小时内活跃的会话
- `/bridge list --origin cli` — 只显示终端发起的会话
- `/bridge list --project backend` — 只显示指定项目的会话

### 5.2 `/bridge switch <target>`

切换到指定会话（包含 CLI 发起的）。

```bash
/bridge switch b21d6d04
```

**MVP 行为**：对已存在 cc-connect 映射的会话执行即时切换；对尚未映射到 cc-connect 的 CLI 会话执行首次映射，并在用户确认后重启/重载 cc-connect 使其生效。

#### 场景 A：目标已有 `cc_connect_session_id`（支持，且不需要重启）

```
步骤 1: cc-linker 读取 registry.json，找到目标 UUID
        → 验证 JSONL 文件存在

步骤 2: 在 cc-connect session JSON 中查找该 UUID 对应的 cc_connect_session_id
        如 "s2"

步骤 3: 调用 bridge API 切换会话
        POST http://localhost:9810/bridge/sessions/switch
        Body: {
          "session_key": "<当前飞书用户 key>",
          "target": "s2"
        }
        Headers: Authorization: Bearer <bridge.token>

        内部逻辑: SessionManager.SwitchSession()
        → 自动更新 active_session[当前用户]
        → 自动原子写入 session JSON
        → 不需要重启 cc-connect
        → 不影响其他用户的活跃会话

步骤 4: 飞书回复确认（标注"无需重启"）
```

#### 场景 B：目标是 CLI 会话，尚无 cc-connect 映射（首次映射，需要确认）

```
步骤 1: cc-linker 读取 registry.json，找到目标 UUID
        → 验证 JSONL 文件存在

步骤 2: 确认该 UUID 在 cc-connect session JSON 中无映射
        → 需要新建映射

步骤 3: 检查其他活跃用户并发出确认提示
        读取 session JSON 中 active_session 的所有用户
        排除当前用户后，如有其他活跃用户：
          → 警告:
            "⚠️ 此操作需要重启/重载 cc-connect，将中断以下用户的当前会话:
             - <user1> (<project>)
             - <user2> (<project>)
             继续？[Y/n]"
        无其他活跃用户：
          → 提示:
            "⚠️ 首次切换此 CLI 会话需要创建 cc-connect 映射，并重启/重载 cc-connect。
             当前对话会短暂中断，但会话历史会保留。继续？[Y/n]"
        用户拒绝：退出，不做任何修改

步骤 4: 写入新的 session 条目到 ~/.cc-connect/sessions/*.json
        1. counter + 1 → 新 session ID（如 "s3"）
        2. 写入新 session 条目：
           sessions["s3"] = {
             "id": "s3",
             "name": "default",
             "agent_session_id": "<目标UUID>",
             "agent_type": "claudecode",
             "history": [],
             "created_at": <当前时间>,
             "updated_at": <当前时间>
           }
        3. user_sessions[当前用户].push("s3")
        4. active_session[当前用户] = "s3"

步骤 5: 乐观锁校验 + 原子写入
        1. 读取 session JSON 时记录 counter 值
        2. 写入前再次读取，校验 counter 是否变化
        3. 若变化（说明其他进程在此期间修改了文件），放弃写入，
           提示用户："会话文件已被修改，请重试 /bridge switch"
        4. 若未变化，写入临时文件 → rename（原子操作）

步骤 6: 重启/重载 cc-connect 使变更生效
        优先尝试: cc-connect daemon restart
        若 restart 不可用，再尝试:
        - kill -HUP <pid>（优雅重载）
        - 若 HUP 也不可用，提示用户手动重启 cc-connect

步骤 7: 飞书回复确认（标注"已重启/已重载"）
```

**飞书回复**：

场景 A（已有映射）：

```
✅ 已切换到「数据库迁移方案」(15 条消息)
💻 此会话来自终端，包含完整的开发历史
⚡ 无需重启，已即时生效
```

场景 B（首次映射成功）：

```
✅ 已切换到「数据库迁移方案」(15 条消息)
💻 此会话来自终端，已创建 cc-connect 映射
⚠️ cc-connect 已重启/重载，正在进行的对话可能短暂中断，但历史已保留
```

场景 B（用户取消）：

```
❌ 已取消，未创建映射，也未重启 cc-connect
```

### 5.3 `/bridge resume <id>`

在终端恢复此会话（提示用户在终端执行的命令）。

```bash
/bridge resume b21d6d04
```

**飞书回复**：

```
📱 请在终端执行以下命令恢复此会话：

cc-linker resume b21d6d04

或直接运行：
claude --resume b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec
```

### 5.4 `/bridge status`

查看桥接状态。

```
/bridge status
```

**飞书回复**：

```
🔗 cc-linker 状态
注册会话: 5
最近同步: 2 分钟前
来源: 3 个来自终端，2 个来自飞书
```

### 5.5 cc-connect 内置命令的关系

| 功能   | cc-connect 内置命令 | cc-linker `/bridge` 命令    | 区别                                                                 |
| ---- | --------------- | ------------------------- | ------------------------------------------------------------------ |
| 列出会话 | `/list`         | `/bridge list`            | cc-connect 只显示当前用户的会话；bridge 显示跨项目全部会话                             |
| 切换会话 | `/switch <id>`  | `/bridge switch <target>` | cc-connect 只切换已有映射；bridge 在 MVP 中也只切换已有映射，但能展示 CLI 会话并对未映射会话给出恢复指引 |
| 删除会话 | `/delete`       | —                         | 使用 cc-connect 内置即可                                                 |
| 查看状态 | `/status`       | `/bridge status`          | bridge status 包含 registry 信息和 CLI 会话统计                             |

> **建议**：用户日常使用 `/bridge` 命令（更完整的会话视图），`/list` 和 `/switch` 作为 cc-connect 原生快捷方式保留。

***

## 六、Scanner 设计

### 6.0 运行模型

cc-linker **不强制后台 daemon**。Scanner 是"扫描行为"，通过三层触发覆盖不同场景：

| 触发点                       | 时机                                    | 范围               | 默认开启                             |
| ------------------------- | ------------------------------------- | ---------------- | -------------------------------- |
| **Hook**（快路径）             | Claude Code 启动时                       | 单个 UUID 即时注册     | ✅（执行 `cc-linker hook install` 后） |
| **CLI 命令前**（默认）           | `cc-linker list/resume/show/sync` 执行前 | 全量增量扫描（基于 mtime） | ✅                                |
| **`cc-linker watch`**（可选） | filesystem watcher 实时检测               | 全量               | ❌（Phase 3）                       |

**实现要点**：

- 增量扫描结果缓存到 `~/.cc-linker/scan_cache.json`（记录每个文件的 mtime）
- 首次扫描：\~3 秒（700 个 JSONL）；后续增量：\~50 毫秒
- CLI 命令支持 `--no-sync` 跳过本次扫描（脚本批处理场景）
- Hook 与 CLI 触发的扫描互为补充：Hook 是即时的（零延迟注册）；CLI 命令前的扫描兜底任何遗漏（如 hook 未安装、Scanner 漏扫等）

**调用骨架**：

```python
class CLI:
    def list(self, no_sync=False):
        if not no_sync:
            self._sync_before_command()
        # ... 读取 registry 输出

    def _sync_before_command(self):
        cache = load_scan_cache()
        cc_connect_uuids, _ = CCConnectScanner(self.registry).scan()
        JSONLScanner(self.registry, cc_connect_uuids, cache).scan_incremental()
        save_scan_cache(cache)
```

### 6.1 cc-connect Scanner

扫描 `~/.cc-connect/sessions/*.json`，发现 cc-connect 会话并注册。**同时输出"权威 UUID 集合"和"权威 sid 集合"**，分别供 JSONL Scanner 判别 origin 与 Registry 做 stale 检测。

```python
class CCConnectScanner:
    """扫描 cc-connect 的 session JSON 文件"""

    def scan(self) -> tuple[set[str], set[str]]:
        """返回 (agent_session_id 集合, sid 集合)"""
        cc_connect_uuids = set()
        cc_connect_sids = set()
        sessions_dir = Path.home() / ".cc-connect" / "sessions"
        if not sessions_dir.exists():
            return cc_connect_uuids, cc_connect_sids

        for json_file in sessions_dir.glob("*.json"):
            data = json.loads(json_file.read_text())

            # 优先从 user_sessions 建立归属关系；active_session 只补充当前活跃会话
            sid_to_user = {}
            for user_key, sids in data.get("user_sessions", {}).items():
                for sid in sids:
                    sid_to_user.setdefault(sid, user_key)
            for user_key, sid in data.get("active_session", {}).items():
                sid_to_user.setdefault(sid, user_key)

            for sid, session in data["sessions"].items():
                agent_id = session.get("agent_session_id")
                if not agent_id:
                    continue

                cc_connect_uuids.add(agent_id)
                cc_connect_sids.add(sid)
                user_key = sid_to_user.get(sid)

                # 注册/更新到 registry
                self.registry.upsert(
                    uuid=agent_id,
                    origin="cc-connect",
                    source=user_key or sid,
                    owner=self._public_owner(user_key),
                    owner_user_key=user_key,
                    platform=self._detect_platform(json_file.name),
                    cc_connect_session_id=sid,
                    cc_connect_session_file=str(json_file),
                )

        # 清理 stale 的 cc_connect_session_id 映射
        # 用户可能在 cc-connect 中 /delete 了某个映射，
        # 但 registry 中仍保留了该 cc_connect_session_id，
        # 导致后续 /bridge switch 误判为"已有映射"（场景 A）
        self._clean_stale_cc_connect_mappings(cc_connect_sids)

        return cc_connect_uuids, cc_connect_sids

    def _clean_stale_cc_connect_mappings(self, cc_connect_sids: set[str]):
        """清理 registry 中已失效的 cc_connect_session_id 映射"""
        for session_entry in self.registry.sessions.values():
            sid = session_entry.get("cc_connect_session_id")
            if sid and sid not in cc_connect_sids:
                # 只按 sid 集合清理，不把 sid 和 UUID 混用比较
                del session_entry["cc_connect_session_id"]
                session_entry.pop("cc_connect_session_file", None)
                self.registry.save()

    def _public_owner(self, user_key: str | None) -> str | None:
        """把 cc-connect user_key 压缩成对用户友好的 owner 展示值"""
        if not user_key:
            return None
        parts = user_key.split(":")
        if len(parts) >= 3:
            return f"{parts[0]}:{parts[-1]}"
        return user_key

    def _detect_platform(self, filename: str) -> str | None:
        """从文件名推断平台（feishu/weixin/...）"""
        for p in ("feishu", "weixin", "dingtalk", "slack"):
            if p in filename.lower():
                return p
        return None
```

> **说明**：cc-connect 的 session 对象 `name` 字段（如 `"default"`）和 `history` 字段不再写入 registry —— 标题、消息预览统一由 JSONL Scanner 从 JSONL 文件提取（更准确，且支持 cli 会话）。

### 6.2 JSONL Scanner

定期扫描 `~/.claude/projects/` 下的新 JSONL 文件。

**性能优化**：

- **增量扫描**：只处理新增和修改的文件，避免重复解析
- **缓存修改时间**：记录文件的 mtime，跳过未变化的文件
- **部分解析**：对于修改过的文件，只解析末尾几行更新活跃信息
- **命令前触发**：默认在 `list/resume/show/sync` 前执行一次短扫描，不引入常驻后台线程

**性能数据**（实测）：

- 文件数量：\~700 个 JSONL 文件
- 总大小：\~350 MB
- 全量扫描：几秒钟
- 增量扫描：毫秒级

```python
class JSONLScanner:
    """扫描 Claude Code 原生 JSONL 文件（增量扫描）"""

    def __init__(self, registry: Registry, cc_connect_uuids: set[str] | None = None,
                 file_cache: dict | None = None):
        self.registry = registry
        # 来自 CCConnectScanner.scan() 的权威 UUID 集合，用作 origin 主判别
        self.cc_connect_uuids = cc_connect_uuids or set()
        # 文件路径 → 修改时间，跨次扫描复用（持久化到 ~/.cc-linker/scan_cache.json）
        self.file_cache = file_cache if file_cache is not None else {}

    def scan(self):
        """增量扫描：只处理新增和修改的文件"""
        projects_dir = Path.home() / ".claude" / "projects"
        for project_dir in projects_dir.iterdir():
            if not project_dir.is_dir():
                continue

            for jsonl_file in project_dir.glob("*.jsonl"):
                session_id = jsonl_file.stem
                mtime = jsonl_file.stat().st_mtime

                # 检查是否需要更新
                cached_mtime = self.file_cache.get(str(jsonl_file))
                if cached_mtime and mtime <= cached_mtime:
                    continue  # 未变化，跳过

                # 新文件：完整解析
                if not self.registry.has(session_id):
                    meta = self._parse_jsonl_full(jsonl_file)
                    self.registry.upsert(
                        uuid=session_id,
                        jsonl_path=str(jsonl_file),     # 直接记录绝对路径，不依赖推断
                        source="terminal",
                        **meta,
                    )
                else:
                    # 修改过的文件：只更新活跃信息
                    meta = self._parse_jsonl_tail(jsonl_file)
                    self.registry.update(session_id, meta)

                # 更新缓存
                self.file_cache[str(jsonl_file)] = mtime

    def _parse_jsonl_full(self, jsonl_path):
        """完整解析 JSONL 提取所有元数据（首次注册时调用）"""
        ai_title = None
        last_prompt = None
        last_active = None
        last_preview = ""
        message_count = 0
        cwd = None
        entrypoint = None  # 用于判别来源

        with open(jsonl_path) as f:
            for line in f:
                message_count += 1
                entry = json.loads(line)

                # 提取 entrypoint（取第一条有该字段的记录）
                if entrypoint is None and entry.get("entrypoint"):
                    entrypoint = entry["entrypoint"]

                # 提取标题
                if entry.get("type") == "ai-title" and not ai_title:
                    ai_title = entry.get("aiTitle", "")

                # 提取 cwd（取第一条有 cwd 字段的记录）
                if not cwd and entry.get("cwd"):
                    cwd = entry["cwd"]

                # 提取最后用户消息
                if entry.get("type") == "last-prompt":
                    last_prompt = entry.get("lastPrompt", "")

        # 从尾部提取 last_active 和 preview
        with open(jsonl_path) as f:
            lines = f.readlines()
            for line in reversed(lines[-10:]):
                entry = json.loads(line)
                if entry.get("type") == "assistant":
                    last_active = entry.get("timestamp")
                    for block in entry.get("message", {}).get("content", []):
                        if block.get("type") == "text":
                            last_preview = block["text"][:100]
                            break
                    if last_preview:
                        break
                elif entry.get("type") == "user" and not last_preview:
                    msg = entry.get("message", {}).get("content", "")
                    if isinstance(msg, str):
                        last_preview = msg[:100]

        # 判别来源（仅首次注册时执行，详见 7.3 节）
        # 主判别：UUID 是否在 cc-connect 权威集合中（确定）
        # 辅助判别：entrypoint=sdk-cli（兜底，应对其他 SDK 工具产生的会话）
        # 都不命中：归为 cli
        # 注意：已注册会话的 origin 不再因 entrypoint 变化而改变，
        # 只由主判别（cc-connect 权威集）决定是否修正
        if jsonl_path.stem in self.cc_connect_uuids:
            origin = "cc-connect"
        elif entrypoint == "sdk-cli":
            origin = "cc-connect"
        else:
            origin = "cli"

        # 标题生成（与 Claude Code /resume 行为一致）
        if ai_title:
            title = ai_title
        elif last_prompt:
            title = last_prompt[:50] + ("..." if len(last_prompt) > 50 else "")
        else:
            title = f"Untitled ({jsonl_path.stem[:8]})"

        # 项目名
        project_name = self._infer_project_name(cwd)

        return {
            "title": title,
            "message_count": message_count,
            "last_active": last_active,
            "last_message_preview": (
                last_preview
                or (last_prompt[:100] if last_prompt else "")
                or "[无内容]"
            ),
            "origin": origin,
            "cwd": cwd or str(Path.home()),
            "project_name": project_name,
        }

    def _parse_jsonl_tail(self, jsonl_path):
        """增量解析：只读尾部更新活跃信息（已注册会话变更时调用）

        相比 _parse_jsonl_full：
        - 不重新提取 title / cwd / origin（这些首次注册后通常不变）
        - 只更新 last_active / last_message_preview / message_count
        - 通过 seek 到接近文件末尾位置 + 读最后若干行实现，不读整个文件
        """
        # 实现略：行为同 _parse_jsonl_full 中"从尾部提取 last_active 和 preview" 一段
        ...

    def _infer_project_name(self, cwd):
        """从 cwd 推断人类可读的项目名"""
        if not cwd or cwd == str(Path.home()):
            return "Home"

        path = Path(cwd)
        # 尝试从项目文件中读取 name（格式处理规则见 3.3 节）
        for name_file in ["package.json", "go.mod", "Cargo.toml", "pyproject.toml"]:
            fp = path / name_file
            if fp.exists():
                name = self._extract_name_from_file(fp, name_file)
                if name:
                    return name

        # fallback: 目录名
        return path.name

    def _extract_name_from_file(self, file_path, file_type):
        """从不同项目格式文件中提取 name"""
        if file_type == "go.mod":
            # module github.com/user/repo → 取最后一段 "repo"
            for line in open(file_path):
                if line.startswith("module "):
                    return line.strip().split("/")[-1]
            return None
        elif file_type == "pyproject.toml":
            # 优先 [project].name，其次 [tool.poetry].name
            # ... 解析逻辑 ...
            pass
        # package.json / Cargo.toml 直接取 "name" 字段
        # ... 解析逻辑 ...
        return None
```

### 6.3 后台 Watcher（可选，Phase 3）

> **默认不启用**。MVP 默认通过 Hook + CLI 命令前扫描覆盖（详见 6.0 节）。Watcher 适合"长时间不开 CLI、希望飞书侧 list 始终最新"的场景。

可选的常驻进程，提供实时检测。

```bash
cc-linker watch
```

**行为**：

- 使用 filesystem watcher（inotify / FSEvents）监控目录
- `~/.cc-connect/sessions/` 文件变化 → 触发 cc-connect Scanner
- `~/.claude/projects/` 新 JSONL 文件 → 触发 JSONL Scanner
- 变化写入 registry

***

## 七、Claude Code Hook 设计

### 7.1 SessionStart Hook

在 Claude Code 每次启动新会话时触发。

**安装**：

```bash
cc-linker hook install
```

**配置写入** `~/.claude/settings.json`：

```json
{
  "hooks": {
    "SessionStart": "cc-linker hook session-start"
  }
}
```

**Hook 脚本行为** (`cc-linker hook session-start`):

```bash
#!/bin/bash
# Claude Code 在 Hook 执行时提供以下环境变量：
# 注意：环境变量名可能随 Claude Code 版本变化，采用多源探测
SESSION_ID="${CLAUDE_CODE_SESSION_ID:-${SESSION_ID:-${CLAUDE_SESSION_ID:-}}"}"
PROJECT_DIR="${PWD}"

# 注册到 registry（容错：任何字段缺失时只记日志，不阻塞 Claude Code 启动）
cc-linker register "${SESSION_ID}" \
  --origin cli \
  --cwd "${PROJECT_DIR}" \
  --source terminal 2>> ~/.cc-linker/hook.log
```

### 7.2 Hook 环境变量

Claude Code 调用 hook 时会注入若干环境变量，**具体名称需以实测为准**（Claude Code 版本可能调整字段名）。请勿在代码中硬编码字段名，应通过配置或运行时检测处理。

**实测验证方法**：

```bash
# 安装一个临时探针 hook
cat > /tmp/cc-linker-probe.sh <<'EOF'
#!/bin/bash
{
  echo "=== $(date -Iseconds) ==="
  echo "PWD=$PWD"
  echo "ARGV: $*"
  env | grep -i -E '(claude|session|hook|transcript)' | sort
  echo "STDIN:"
  cat
  echo "=== end ==="
} >> /tmp/cc-linker-probe.log 2>&1
EOF
chmod +x /tmp/cc-linker-probe.sh

# 临时配置 ~/.claude/settings.json：
#   { "hooks": { "SessionStart": "/tmp/cc-linker-probe.sh" } }
# 启动几个 Claude Code 会话，观察 /tmp/cc-linker-probe.log
```

**常见预期字段（需以实测确认）**：

| 来源           | 预期字段                                      | 用途              | 优先级                     |
| ------------ | ----------------------------------------- | --------------- | ----------------------- |
| 环境变量         | `CLAUDE_CODE_SESSION_ID` 或 `SESSION_ID` 类 | 当前会话 UUID       | 必需                      |
| 环境变量         | `PWD`                                     | 当前工作目录          | 必需（可从 `os.getcwd()` 兜底） |
| 环境变量 / stdin | `transcript_path`                         | 直接定位 JSONL，避免推断 | 可选（强烈推荐）                |
| 环境变量         | `CLAUDE_CODE_PROJECT` 类                   | 项目标识            | 可选                      |

**容错策略**：

- **多源探测**：Hook 内部按优先级尝试多个环境变量名获取 `SESSION_ID`（`CLAUDE_CODE_SESSION_ID` → `SESSION_ID` → `CLAUDE_SESSION_ID`），避免赌单个变量名
- **兜底扫描**：Hook 失败（任何关键字段缺失、registry 被锁等）时不报错退出，只记录到 `~/.cc-linker/hook.log`；由 CLI 命令前的兜底扫描发现该会话（最多 1 次扫描的延迟）
- **永不阻塞**：hook 内部捕获所有异常，**永不阻塞 Claude Code 启动**

### 7.3 来源自动判别

除了 Hook 注册外，Scanner 通过两层判别确定 `origin`：

| 优先级      | 判别条件                                                              | 结果                    | 说明                                   |
| -------- | ----------------------------------------------------------------- | --------------------- | ------------------------------------ |
| **主判别**  | UUID 出现在 `~/.cc-connect/sessions/*.json` 的 `agent_session_id` 集合中 | `origin="cc-connect"` | 确定的依据，由 cc-connect Scanner 提供权威集合    |
| **辅助判别** | JSONL 中 `entrypoint="sdk-cli"` 且未命中主判别                            | `origin="cc-connect"` | 兜底，应对 cc-connect 配置丢失或其他 SDK 工具产生的会话 |
| **兜底**   | 都不命中                                                              | `origin="cli"`        | Claude Code 原生 CLI 发起                |

> 主判别比 entrypoint 更可靠：cc-connect 的 session JSON 是"权威源"。即使 Claude Code 调整了 entrypoint 字段含义，也不影响 cc-linker 的判别结果。

**origin 判别时机**：

- **首次注册时**：通过主判别 + 辅助判别 + 兜底确定 origin，写入 registry
- **后续扫描时**：origin 不再因 entrypoint 变化而改变（避免用户用 `claude --resume` 恢复 cc-connect 会话时，新写入的 `entrypoint="cli"` 记录干扰判别）
- **例外**：若主判别发现该 UUID 出现在 cc-connect 权威集合中，则自动修正 origin 为 `cc-connect`（因为 cc-connect 的 session JSON 是权威源）

Hook 是"快速路径"（启动时即时注册，origin 暂记为 cli）；下一次扫描会自动用主判别修正为 cc-connect（如果该 UUID 出现在 cc-connect sessions 中）。两者互为补充，不互相依赖。

***

## 八、用户交互流程

### 8.1 流程 A：飞书开始 → 终端继续

```
时间线

09:00  用户在飞书发消息："帮我设计一个用户认证模块"
       │
       ▼
09:01  cc-connect 启动 Claude Code
       创建 session s1, agent_session_id = b21d6d04-...
       cwd = /Users/wuyujun（cc-connect 配置的工作目录）
       entrypoint = "sdk-cli"
       │
       ▼
09:01  Scanner 检测到新 session，注册到 registry
       记录: uuid=b21d6d04-..., origin=cc-connect,
             cwd=/Users/wuyujun, project_name=Home
       │
       ▼
09:30  飞书对话进行了 20 轮，讨论了 JWT + OAuth2 方案
       Scanner 持续更新 last_active
       │
       ▼
10:00  用户到工位，打开终端
       $ cc-linker resume

       可选会话：
       b21d6d04  用户认证模块设计 (🟢 飞书, Home, 20条, 30分钟前)

       输入 Ref: b21d6d04
       │
       ▼
10:01  cc-linker 检测到 cwd=/Users/wuyujun 与当前目录不同
       提示: "⚠️ 此会话在 /Users/wuyujun 中创建，
              将切换到该目录并恢复会话。继续？[Y/n]"
       用户确认 → 执行: cd /Users/wuyujun && claude --resume b21d6d04-...
       Claude Code 启动，加载完整 20 轮对话历史
       │
       ▼
10:02  用户: "继续，现在开始实现 JWT 中间件"
       Claude 接着飞书中的讨论继续工作
```

### 8.2 流程 B：终端开始 → 飞书继续

```
时间线

14:00  用户在终端执行:
       $ cd ~/projects/my-backend && claude
       │
       ▼
14:00  SessionStart hook 触发
       cc-linker 注册会话 a3f8c1d2-... 到 registry
       记录: cwd=~/projects/my-backend, project_name=my-backend
       │
       ▼
14:30  终端对话进行了 15 轮，完成数据库 schema 设计
       │
       ▼
15:00  用户通勤路上，打开飞书
       用户: /bridge list

       a3f8c1d2 数据库迁移方案 (💻 终端, my-backend, 15条, 30分钟前)
       b21d6d04 用户认证模块设计 (🟢 飞书, Home, 20条, 6小时前)

       用户: /bridge switch a3f8c1d2
       │
       ▼
15:01  cc-linker 发现该会话尚无 cc-connect 映射
       提示:
       "⚠️ 首次切换此 CLI 会话需要创建 cc-connect 映射，并重启/重载 cc-connect。
        当前对话会短暂中断，但会话历史会保留。继续？[Y/n]"
       │
       ▼
15:01  用户确认后，cc-linker:
       1. 写入新的 session 条目到 ~/.cc-connect/sessions/*.json
       2. 设置 active_session[当前用户] = "s3"
       3. 重启/重载 cc-connect
       │
       ▼
15:02  用户在飞书继续发消息
       cc-connect 使用 a3f8c1d2-... 作为 agent_session_id
       Claude Code 加载对应 JSONL 历史
```

### 8.3 流程 C：频繁切换同一会话

```
用户操作：

终端: cc-linker resume --search "认证"
      → 提示 CWD 变更，确认后恢复会话，继续开发代码
      → 关闭终端

飞书: /bridge switch b21d6d04
      → 切换会话，审查进度
      → "把中间件的单元测试补一下"

终端: cc-linker resume -L
      → 恢复最近会话（同一个）
      → 看到飞书中的新消息，开始写测试
```

**关键点**：两端操作的是同一个 JSONL 文件，所以消息天然合并，不需要额外的同步逻辑。

***

## 九、边界情况处理

### 9.1 同一会话在两端同时活跃

```
场景: 用户在飞书发了消息，同时也在终端发了消息

处理:
- JSONL 文件由 Claude Code 进程管理，不存在并发写入冲突
  （同一时刻只有一个 Claude Code 进程使用同一个 session ID）
- registry 以最后扫描到的 last_active 为准
- 列表中显示 "最后活跃" 时间
```

### 9.2 跨机器场景

```
场景: cc-connect 运行在远程服务器，用户在本地笔记本用终端

当前限制:
- cc-linker 是本地工具，假设 cc-connect 和 CLI 在同一台机器
- JSONL 文件和 registry 都在本地

未来扩展:
- cc-linker sync --remote <server-url> 通过 SSH/HTTP 拉取远端 registry
- 远端 JSONL 文件按需下载到本地临时目录
- 或者只同步元数据，resume 时在远端执行
```

### 9.3 cc-connect 的 reset\_on\_idle\_mins

```
场景: cc-connect 因空闲超过 reset_on_idle_mins，
      自动创建了新的 session（新 cc_connect_session_id + 新 agent_session_id）

处理（MVP 不在 Scanner 反向推断"两个 UUID 是否同一逻辑会话"，
      改为 resume 时实时检测并提示）:

- 每个 agent_session_id 在 registry 中独立存在，list 列表平等显示
  （旧 UUID 不会被自动隐藏；用户可用 cc-linker clean --older-than 30 清理）

- 用户 resume 时，若目标是 origin=cc-connect:
  1. 反查 cc-connect session JSON 中目标 UUID 对应的 cc_connect_session_id (sid_old)
  2. 找到 sid_old 的 user_key（优先从 user_sessions 反查，active_session 只作补充）
  3. 查 user_key 当前的 active_session sid_new 及其 agent_session_id (uuid_new)
  4. 若 uuid_new != 目标 UUID（说明已被 reset_on_idle 替代），交互提示:
     "⚠️ 此会话已被新会话替代（标题：<uuid_new 的 title>）。恢复哪个？
        1) 旧会话（完整历史保留在 JSONL 中）
        2) 最新会话
        [1/2]"
  5. 用户选 1 → 恢复 target_uuid（独立分支，不影响 cc-connect 当前 active）
     用户选 2 → 改为恢复 uuid_new

- JSONL 文件本身不会被 cc-connect 删除，所以 resume 旧 UUID 永远是合法操作
- 不维护 past_uuids 字段，避免 Scanner 误判带来的数据污染
```

> **设计权衡**：放弃自动归并 = 容忍 list 中出现"看起来重复"的会话条目（同一聊天的 reset 前后 UUID 都会显示）。代价是 list 略显冗长，但避免了启发式判别误把两个独立会话错误合并的风险（后者破坏数据完整性，更难修复）。

### 9.4 JSONL 文件被清理

```
场景: Claude Code 清理了旧的 JSONL 文件

处理:
- Scanner 检测时标记 status = "corrupted"
- cc-linker list 默认不显示 corrupted 会话
- cc-linker list --archived 可查看
- 无法恢复，提示用户
```

### 9.5 Hook 执行失败

```
场景: SessionStart hook 执行出错

处理:
- Hook 失败不影响 Claude Code 正常启动
- cc-linker hook status 显示最后执行结果
- 日志输出到 ~/.cc-linker/hook.log
- 下次 sync 时 JSONL Scanner 仍会发现该会话（兜底机制）
```

### 9.6 Registry 文件损坏

```
场景: registry.json 被意外写入损坏

处理:
- 启动时校验 version 字段
- 损坏时自动从最近备份恢复 (~/.cc-linker/registry.json.bak)
  （保留最近 3 个备份版本）
- 无法恢复时提示用户执行 cc-linker init 重建
```

***

## 十、安装与配置

### 10.0 配置管理

cc-linker 使用 `~/.cc-linker/config.toml` 进行配置，支持多层覆盖：默认值 < 配置文件 < 环境变量。

**配置文件示例**：

```toml
[general]
# Registry 文件路径
registry_path = "~/.cc-linker/registry.json"
# 日志级别：debug | info | warn | error
log_level = "info"
# 日志文件路径（可选，不设置则输出到 stderr）
log_path = "~/.cc-linker/cc-linker.log"

[scanner]
# cc-connect 扫描间隔（秒）
cc_connect_interval = 30
# JSONL 扫描间隔（秒）
jsonl_interval = 60
# 最大文件大小（字节），超过此大小的 JSONL 文件跳过解析
max_file_size = 104857600  # 100MB
# 是否启用增量扫描
incremental = true

[bridge]
# cc-connect bridge API 地址
api_url = "http://localhost:9810"
# bridge API token（建议从环境变量读取：CC_LINKER_TOKEN）
token = ""
# API 请求超时（秒）
timeout = 30
# 重启 cc-connect 前等待时间（秒）
restart_delay = 5

[hook]
# Hook 日志文件路径
log_path = "~/.cc-linker/hook.log"
# Hook 执行超时（秒）
timeout = 10

[export]
# 默认导出格式：markdown | text | json
default_format = "markdown"
# 默认输出目录
output_dir = "."
# 是否包含 thinking block
include_thinking = false
# 是否包含工具调用
include_tools = false
# 单条消息最大长度（字节）
max_message_size = 1048576  # 1MB

[feishu]
# 飞书侧命令前缀
command_prefix = "/bridge"
# 是否显示其他用户的会话（需要权限控制）
show_all_sessions = false
# 默认会话列表排序
default_sort = "last_active"
```

**配置优先级**（高 → 低）：

```
命令行参数  >  环境变量  >  配置文件  >  默认值
```

**环境变量覆盖**：

| 环境变量                      | 配置项                     | 说明                                                            |
| ------------------------- | ----------------------- | ------------------------------------------------------------- |
| `CC_LINKER_CONFIG_PATH`   | —                       | 配置文件路径（默认 `~/.cc-linker/config.toml`）                         |
| `CC_LINKER_REGISTRY_PATH` | `general.registry_path` | Registry 文件路径                                                 |
| `CC_LINKER_LOG_LEVEL`     | `general.log_level`     | 日志级别                                                          |
| `CC_LINKER_LOG_PATH`      | `general.log_path`      | 日志文件路径                                                        |
| `CC_LINKER_TOKEN`         | `bridge.token`          | bridge API token                                              |
| `CC_LINKER_API_URL`       | `bridge.api_url`        | bridge API 地址                                                 |
| `CC_LINKER_CALLER_USER`   | —                       | 调用者标识（飞书调用时可由 cc-connect 通过 `--caller` 参数或本环境变量传入；CLI 调用时可不设） |

**配置加载逻辑**：

```python
class Config:
    def __init__(self, config_path: Path = None):
        self.config_path = config_path or Path.home() / '.cc-linker' / 'config.toml'
        self.data = self._load_defaults()

        if self.config_path.exists():
            self._load_file()

        # 环境变量覆盖
        self._load_env()

    def _load_defaults(self) -> dict:
        """加载默认配置"""
        return {
            'general': {
                'registry_path': '~/.cc-linker/registry.json',
                'log_level': 'info',
                'log_path': None
            },
            'scanner': {
                'cc_connect_interval': 30,
                'jsonl_interval': 60,
                'max_file_size': 100 * 1024 * 1024,
                'incremental': True
            },
            'bridge': {
                'api_url': 'http://localhost:9810',
                'token': '',
                'timeout': 30,
                'restart_delay': 5
            },
            'hook': {
                'log_path': '~/.cc-linker/hook.log',
                'timeout': 10
            },
            'export': {
                'default_format': 'markdown',
                'output_dir': '.',
                'include_thinking': False,
                'include_tools': False,
                'max_message_size': 1024 * 1024
            },
            'feishu': {
                'command_prefix': '/bridge',
                'show_all_sessions': False,
                'default_sort': 'last_active'
            }
        }

    def _load_env(self):
        """从环境变量加载配置"""
        env_mappings = {
            'CC_LINKER_REGISTRY_PATH': ('general', 'registry_path'),
            'CC_LINKER_LOG_LEVEL': ('general', 'log_level'),
            'CC_LINKER_TOKEN': ('bridge', 'token'),
            'CC_LINKER_API_URL': ('bridge', 'api_url'),
        }

        for env_key, config_path in env_mappings.items():
            value = os.environ.get(env_key)
            if value:
                section, key = config_path
                self.data[section][key] = value
```

### 10.1 安装

```bash
# Homebrew
brew install cc-linker

# pip
pip install cc-linker

# Go
go install github.com/xxx/cc-linker@latest

# 直接下载二进制
curl -L https://github.com/xxx/cc-linker/releases/latest/download/cc-linker-$(uname -s)-$(uname -m).tar.gz \
  | tar xz -C /usr/local/bin
```

### 10.2 初始化

```bash
cc-linker init
```

### 10.3 安装 Hook

```bash
cc-linker hook install
```

### 10.4 与 cc-connect 的交互方式

cc-connect 已内置 bridge API（默认端口 9810），提供以下端点：

| 端点                        | 方法     | 功能                                  |
| ------------------------- | ------ | ----------------------------------- |
| `/bridge/sessions`        | GET    | 查询会话信息（需要 `?session_key` 参数）        |
| `/bridge/sessions`        | POST   | 创建新会话（cc-connect 分配 session ID）     |
| `/bridge/sessions/switch` | POST   | 切换活跃会话（需要 `session_key` + `target`） |
| `/bridge/sessions/<id>`   | GET    | 查询指定会话详情                            |
| `/bridge/sessions/<id>`   | DELETE | 删除指定会话                              |

**MVP 阶段的交互方案**：

- **已有映射的场景**：调用 `POST /bridge/sessions/switch` 即可
  - 内部通过 `SessionManager.SwitchSession()` 执行
  - 自动原子写入 session JSON，不需要重启
  - 不影响其他用户的活跃会话
- **未映射的 CLI 会话**：
  1. `cc-linker` 直接修改 `~/.cc-connect/sessions/*.json` 创建首次映射
  2. 写入前做乐观锁校验，写入时使用临时文件 + rename
  3. 写入后执行 `cc-connect daemon restart` 或优雅重载使其生效
  4. 执行前必须提示用户确认，并展示可能受影响的活跃用户

**飞书侧** **`/bridge`** **命令注册**：

cc-connect 支持通过 `[[commands]]` 配置段注册自定义斜杠命令。cc-linker 的飞书命令通过此机制接入：

```toml
# 在 cc-connect config.toml 中添加
[[commands]]
name = "bridge"
description = "跨平台会话管理（CLI + 飞书）/ Cross-platform session management"
exec = "cc-linker feishu-cmd --caller {{user}} {{args}}"
```

用户发送 `/bridge list` 时，cc-connect 执行 `cc-linker feishu-cmd --caller <user> list`，cc-linker 读取 registry.json 后格式化输出，返回给飞书用户。

也可在飞书聊天中动态注册（无需修改配置文件）：

```
/commands addexec bridge cc-linker feishu-cmd --caller {{user}} {{args}}
```

**后续优化方向**：

- 推动 cc-connect 上游增加 `POST /bridge/sessions` 支持可选的 `agent_session_id` 字段，使新建映射也不需重启
- 或增加 `POST /bridge/sessions/switch-by-agent-id`，通过 UUID 直接切换（cc-connect 内部已有 `SwitchToAgentSession` 方法，但未通过 API 暴露）
- 实现完全无重启热切换

> **注意**：cc-connect 当前仅在启动时加载 session JSON（日志确认：`session: loaded from disk`），运行中不监听文件变化。因此一期的“首次映射 CLI 会话”必须依赖受控重启/重载；后续应优先推动公开 API，逐步替代这条工程接入路径。

### 10.5 后台运行（可选）

```bash
# 启动 watcher
cc-linker watch &

# 或使用 systemd (Linux)
cc-linker service install
cc-linker service start

# 或使用 launchd (macOS)
cc-linker service install
cc-linker service start
```

***

## 十一、错误码

| 错误码    | 说明                        | 解决方式                                                                   |
| ------ | ------------------------- | ---------------------------------------------------------------------- |
| `E001` | Registry 文件不存在            | 执行 `cc-linker init`                                                    |
| `E002` | JSONL 文件不存在               | 会话已被清理，无法恢复                                                            |
| `E003` | Hook 安装失败                 | 检查 `~/.claude/settings.json` 权限                                        |
| `E004` | cc-connect sessions 目录不存在 | 未安装或未运行 cc-connect                                                     |
| `E005` | UUID 格式无效                 | 检查输入                                                                   |
| `E006` | 多个匹配结果                    | 使用更精确的筛选条件                                                             |
| `E007` | 注册表被锁                     | 等待其他进程完成，或手动删除 `.lock` 文件                                              |
| `E008` | cwd 目录不存在                 | 会话创建目录已被删除，无法恢复                                                        |
| `E009` | cc-connect 重启失败           | 检查 `cc-connect daemon status`                                          |
| `E010` | 磁盘空间不足                    | 清理磁盘空间，或移动 registry 到其他磁盘                                              |
| `E011` | 文件权限不足                    | 检查文件权限：`ls -l ~/.cc-linker/`，运行 `chmod 600 ~/.cc-linker/registry.json` |
| `E012` | JSON 解析错误                 | 检查 JSONL 文件格式，可能已损坏                                                    |
| `E013` | 网络请求超时                    | 检查 cc-connect 是否运行，API 地址是否正确                                          |
| `E014` | bridge API 返回错误           | 检查 API 认证 token，查看 cc-connect 日志                                       |
| `E015` | 备份文件损坏                    | 执行 `cc-linker init` 重建 registry                                        |
| `E016` | 配置文件格式错误                  | 检查 `~/.cc-linker/config.toml` 语法                                       |
| `E017` | 会话已归档                     | 使用 `cc-linker list --archived` 查看                                      |
| `E018` | 会话已损坏                     | 无法恢复，标记为 corrupted                                                     |
| `E019` | 缺少调用者身份                   | 检查 cc-connect `[[commands]]` 是否注入 `--caller {{user}}`                  |
| `E020` | 版本不兼容                     | 升级 cc-linker 或重建 registry                                              |
| `E021` | cc-connect 会话文件冲突         | 会话文件在写入前已被其他进程修改，请重试 `/bridge switch`                                  |

**错误诊断**：

每个错误都提供详细的诊断信息和修复建议：

```python
class CCLinkerError(Exception):
    def __init__(self, code: str, message: str, details: dict = None):
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(f"[{code}] {message}")

# 错误处理和用户提示
def handle_error(error: CCLinkerError):
    """根据错误码提供详细的诊断信息和修复建议"""
    suggestions = {
        'E001': ['运行 cc-linker init 初始化 registry'],
        'E002': ['会话已被清理，无法恢复', '检查 Claude Code 是否清理了旧会话'],
        'E007': ['等待其他进程完成', '或手动删除 ~/.cc-linker/registry.json.lock'],
        'E010': ['清理磁盘空间', '或移动 registry 到其他磁盘'],
        'E011': ['检查文件权限：ls -l ~/.cc-linker/', '运行 chmod 600 ~/.cc-linker/registry.json'],
    }

    print(f"错误 [{error.code}]: {error.message}")
    if error.details:
        print(f"详情: {error.details}")
    if error.code in suggestions:
        print("建议:")
        for suggestion in suggestions[error.code]:
            print(f"  - {suggestion}")
```

***

## 十二、安全考虑

### 12.1 本地数据

- Registry 和 JSONL 文件均存储在本地，不上传任何数据
- 不包含 API Key 或凭证信息
- 会话元数据（标题、预览）可能包含代码片段，用户应了解这是本地文件

### 12.2 文件权限

- `~/.cc-linker/registry.json` 权限应为 `600`
- Hook 脚本权限应为 `755`

### 12.3 飞书隐私

- 飞书侧命令要求 cc-connect 注入 `--caller {{user}}`
- 缺少 `caller` 时默认拒绝返回会话列表（fail closed）
- `/bridge list` 只显示当前用户可见的会话
- 不暴露其他飞书用户的会话内容

***

## 十三、实现路线图

### Phase 1: MVP（2-3 人天）

| 功能                       | 说明                             |
| ------------------------ | ------------------------------ |
| `cc-linker init`         | 初始化 + 首次扫描                     |
| `cc-linker list`         | 列出所有会话（稳定使用 UUID/短前缀，不使用跨命令编号） |
| `cc-linker resume`       | 恢复会话到终端（自动处理 CWD 切换）           |
| `/bridge list`           | 飞书侧统一会话视图（要求 caller 注入）        |
| `/bridge resume`         | 飞书侧返回终端恢复命令                    |
| `/bridge switch`         | 飞书侧切换会话；未映射 CLI 会话支持首次创建映射     |
| `cc-linker hook install` | 安装 SessionStart hook           |
| `cc-linker sync`         | 手动同步                           |
| Registry 读写              | 含文件锁 + 备份                      |
| cc-connect Scanner       | 定期扫描                           |
| JSONL Scanner            | 扫描原生 JSONL（含标题/预览/来源自动判别）      |

> **注意**：Phase 1 即支持“首次映射 CLI 会话到 cc-connect”，但必须带确认提示、并发用户告警、原子写入和失败回退。

### Phase 2: 双向切换（3-4 人天）

| 功能                   | 说明                           |
| -------------------- | ---------------------------- |
| `/bridge switch`（飞书） | 补强确认体验、卡片化交互与更清晰的重启/回退提示     |
| `cc-linker show`     | 会话详情                         |
| `cc-linker search`   | 搜索会话                         |
| 卡片化交互                | 在飞书消息中携带稳定 UUID/Ref，避免人工复制错误 |

### Phase 3: 增强体验（3-5 人天）

| 功能                 | 说明                                                               |
| ------------------ | ---------------------------------------------------------------- |
| 后台 Watcher         | filesystem watcher 实时检测                                          |
| `cc-linker export` | 导出为 markdown                                                     |
| `cc-linker status` | 状态面板                                                             |
| `cc-linker clean`  | 清理无效记录                                                           |
| `cc-linker watch`  | 常驻进程                                                             |
| 项目自动检测             | 从 package.json/go.mod 等读取项目名                                     |
| Bridge API 扩展      | 推动 cc-connect 上游支持按 `agent_session_id` 建立/切换映射，使 CLI 会话可直接在飞书热切换 |

### Phase 4: 跨机器与团队（后续）

| 功能            | 说明              |
| ------------- | --------------- |
| 远程同步          | SSH/HTTP 拉取远端会话 |
| 团队共享          | 多用户共享 registry  |
| Web Dashboard | 浏览器查看所有会话       |

***

## 十三点五、Phase 1 已知已知差异（Code Review 参考清单）

以下功能在 Phase 1 spec 中**已定义**，但一期实现**暂不保证**完整。Code Review 如发现这些项，请直接标记为"已确认延期"，不要重复报告。

### 13.5.1 Phase 2 延期（详见 Phase 2 路线图）

| # | 功能 / spec 位置 | 当前实现状态 | 原因 |
|---|---|---|---|
| 1 | `cc-linker show`（4.4 节）: 显示最近消息内容 | 已实现元数据展示，**不展示最近消息** | Phase 2 功能 |
| 2 | `cc-linker search`（4.9 节）: `--in-content` 始终搜索 JSONL | `--in-content` 仅在标题/预览无结果时搜索 | Phase 2 功能 |
| 3 | `/bridge switch`（5.2 节）: 卡片化交互 | 使用 Markdown 文本输出 | Phase 2 功能 |

### 13.5.2 Phase 3 延期（详见 Phase 3 路线图）

| # | 功能 / spec 位置 | 当前实现状态 | 原因 |
|---|---|---|---|
| 4 | `cc-linker export`（4.8 节）: `writeStream.cork()/uncork()` 批处理 | 每 100 条 `write('')` 刷新缓冲区，未配对 `cork()` | Phase 3 将实现完整的 `cork()/uncork()` 批处理 |
| 5 | `cc-linker status`（4.6 节）: 显示 CLI 版本号 + 真实 last sync 时间 | 显示文件 mtime，不显示版本号 | Phase 3 功能 |
| 6 | `cc-linker clean`（4.10 节） | 已实现基本功能，但无集成测试 | Phase 3 功能 |

### 13.5.3 已评估的工程决策（不修复项）

以下问题经 Code Review 评估后决定**当前不修复**，各有明确技术理由。Code Review 如发现这些项，请直接关闭，无需进一步处理。

| # | 问题 / spec 位置 | 当前实现 | 不修复理由 |
|---|---|---|---|
| 7 | `cc-linker resume`（4.3 节）: 应使用 `execvp` 替换进程 | 使用 `Bun.spawnSync` 启动 `claude --resume` | `spawnSync` 功能正确、保留退出码、体验等同直接执行。Bun 运行时无原生 `execve` 系统调用，改造为进程替换需要 `syscall` 绑定或 Go 重写，收益低风险高。 |
| 8 | `/bridge switch` 场景 A（5.2 节）: Bridge API 失败时应区分成功/失败输出 | API 失败时打印警告提示，不抛异常 | 当前行为符合文档设计：降级提示是给飞书用户的有效信息，cc-connect 按 stdout 输出发送给用户。API 不可用时用户仍能看到降级指引。 |
| 9 | `JSONLScanner.parseFull`（6.2 节）: 全量 `readFileSync` 存在内存风险 | 使用 `readFileSync` 读取完整文件 | 已有 100MB 文件大小阈值跳过保护，MVP 场景足够。全量流式解析在 Phase 3 优化，当前文件数量 (~700) 下实际峰值可控。 |
| 10 | `/bridge switch` 飞书确认流程（5.2 节场景 B 步骤3）: 交互式 Y/n 确认 | 使用 `--confirm` 命令行参数代替交互式确认 | 飞书命令由 cc-connect 通过 `exec` 调用，不支持交互式 stdin。`--confirm` 参数是唯一可行的确认方式，与文档中"用户确认后执行"的精神一致。 |

### 13.5.4 测试覆盖度

| # | 说明 |
|---|---|
| ~~11~~ | ✅ 已解决：`resume`、`show`、`export`、`search`、`clean`、`feishu-cmd`、`hook` 集成测试已补齐（91 个测试全通过，含 registry upsert 字段保留、source 覆盖防护、origin 判定、created_at/project_dir 提取等单元测试） |

> **使用方式**：此清单用于 Code Review 时的"白名单"判断。若 review 报告指出上述已知差异，Reviewer 可直接关闭该 report，无需进一步处理。

***

## 十四、与现有工具的对比

| 维度     | cc-connect 原生   | Claude Code 原生 | cc-linker                  |
| ------ | --------------- | -------------- | -------------------------- |
| 会话可见性  | 只看 cc-connect 的 | 只看本地的          | 两端都看                       |
| 恢复方式   | `/switch`       | `--resume`     | `cc-linker resume`         |
| 数据格式   | JSON (简化历史)     | JSONL (完整历史)   | Registry (索引)              |
| 双向切换   | ❌               | ❌              | ✅（未映射 CLI 会话首次切换需确认并重启/重载） |
| 上下文完整性 | 完整              | 完整             | 完整（不做转换）                   |

***

## 十五、FAQ

**Q: cc-linker 会修改我的对话数据吗？**

A: 不会修改 JSONL 对话内容。cc-linker 会维护自己的 registry；在一期中，为了让飞书继续 CLI 会话，`/bridge switch` 在首次映射时会改写 cc-connect 的 session JSON 映射关系，但不会改写对话历史本身。

**Q: 如果我删除了 registry.json，会话会丢失吗？**

A: 不会。JSONL 文件仍在，执行 `cc-linker init` 会重新扫描并重建 registry。

**Q: cc-linker 支持远程 cc-connect 吗？**

A: MVP 版本不支持。当前设计假设 cc-connect 和 CLI 在同一台机器。跨机器同步在 Phase 4 规划中。

**Q: 安装 Hook 会影响 Claude Code 的性能吗？**

A: 不会。Hook 在 Claude Code 启动完成后异步执行，不阻塞主进程。

**Q: 如果 cc-connect 的 session JSON 和 JSONL 不一致怎么办？**

A: 以 JSONL 为准。cc-linker 的 resume 直接基于 JSONL 文件，不依赖 cc-connect 的简化历史。

**Q: 支持微信、钉钉等其他平台吗？**

A: 支持。Scanner 自动检测所有 `~/.cc-connect/sessions/*.json` 文件，不限于飞书。

**Q:** **`/bridge switch`** **会重启 cc-connect，这会导致正在进行的对话中断吗？**

A: 会，但只发生在**首次把 CLI 会话映射进 cc-connect**时。此时 `/bridge switch` 会先提示确认，并列出可能受影响的活跃用户；用户确认后才会写入 session JSON 并执行重启/重载。对于已经映射过的会话，仍然走 bridge API，无需重启。

***

## 十六、附录

### 16.1 cc-connect Session JSON 示例

```json
{
  "sessions": {
    "s1": {
      "id": "s1",
      "name": "default",
      "agent_session_id": "028037a3-a7c1-4d07-85c1-28b31af19284",
      "agent_type": "claudecode",
      "history": [
        {"role": "user", "content": "hi", "timestamp": "..."},
        {"role": "assistant", "content": "你好...", "timestamp": "..."}
      ],
      "created_at": "2026-05-03T16:55:23.275844+08:00",
      "updated_at": "2026-05-03T16:55:23.275844+08:00"
    },
    "s2": {
      "id": "s2",
      "name": "default",
      "agent_session_id": "b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec",
      "agent_type": "claudecode",
      "history": [
        {"role": "user", "content": "hi", "timestamp": "..."},
        {"role": "assistant", "content": "你好...", "timestamp": "..."}
      ],
      "created_at": "2026-05-03T17:17:32.418541+08:00",
      "updated_at": "2026-05-03T17:52:52.117522+08:00"
    }
  },
  "active_session": {
    "feishu:oc_31630504ca5a54b74c43f25b2924cf90:ou_c0f15da0a159e5a2c83f52d95a209a0f": "s2",
    "feishu:oc_d57c52f3a2ac2a26bed07559959fe1fc:ou_fc2e2242165d30fd4e623bf936f700f4": "s1"
  },
  "user_sessions": {
    "feishu:oc_31630504ca5a54b74c43f25b2924cf90:ou_c0f15da0a159e5a2c83f52d95a209a0f": ["s2"],
    "feishu:oc_d57c52f3a2ac2a26bed07559959fe1fc:ou_fc2e2242165d30fd4e623bf936f700f4": ["s1"]
  },
  "counter": 2,
  "user_meta": {
    "feishu:oc_31630504ca5a54b74c43f25b2924cf90:ou_c0f15da0a159e5a2c83f52d95a209a0f": {
      "user_name": "ou_c0f15da0a159e5a2c83f52d95a209a0f",
      "chat_name": "oc_31630504ca5a54b74c43f25b2924cf90"
    },
    "feishu:oc_d57c52f3a2ac2a26bed07559959fe1fc:ou_fc2e2242165d30fd4e623bf936f700f4": {
      "user_name": "武玉军",
      "chat_name": "oc_d57c52f3a2ac2a26bed07559959fe1fc"
    }
  },
  "past_id_tracking": true,
  "version": 1
}
```

### 16.2 Claude Code JSONL 示例

```
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-05-03T09:17:34.969Z","sessionId":"b21d6d04-...","content":"hi"}
{"parentUuid":null,"isSidechain":false,"attachment":{"type":"hook_success","hookName":"SessionStart:startup",...},"type":"attachment","timestamp":"2026-05-03T09:17:32.910Z","entrypoint":"sdk-cli","cwd":"/Users/wuyujun","sessionId":"b21d6d04-..."}
{"parentUuid":"...","isSidechain":false,"promptId":"...","type":"user","message":{"role":"user","content":"hi"},"uuid":"...","timestamp":"2026-05-03T09:17:34.973Z","entrypoint":"sdk-cli","cwd":"/Users/wuyujun","sessionId":"b21d6d04-..."}
{"parentUuid":"...","isSidechain":false,"message":{"role":"assistant","content":[{"type":"text","text":"你好！"}]},"type":"assistant","uuid":"...","timestamp":"2026-05-03T09:17:38.970Z","entrypoint":"sdk-cli","cwd":"/Users/wuyujun","sessionId":"b21d6d04-..."}
{"type":"last-prompt","lastPrompt":"请你直接进入到Git这个目录","leafUuid":"...","sessionId":"b21d6d04-..."}
{"type":"ai-title","aiTitle":"API 认证模块设计","sessionId":"b21d6d04-..."}
```

**JSONL 关键字段说明**：

- `entrypoint`: `"cli"`（本地 CLI）或 `"sdk-cli"`（cc-connect 启动）
- `cwd`: 会话创建时的工作目录
- `timestamp`: ISO 8601 格式的时间戳
- `type`: 记录类型，包括 `queue-operation`, `user`, `assistant`, `ai-title`, `last-prompt` 等

### 16.3 项目目录结构

```
~/.cc-linker/
├── registry.json          # 会话注册表
├── registry.json.bak      # 软链接，指向最新备份
├── registry.json.lock     # 文件锁
├── backups/               # 备份目录（独立目录，便于管理）
│   ├── registry.20260503_153000.json  # 带时间戳的备份
│   ├── registry.20260503_160000.json
│   └── registry.20260503_163000.json
├── hook.log              # Hook 执行日志
├── cc-linker.log         # 主程序日志（可选）
└── config.toml           # 可选配置
```

### 16.4 cc-linker 与 cc-connect 的 Bridge API

cc-connect 提供的 bridge API 端点：

```
GET  /bridge/sessions?session_key=<key>   查询指定用户的所有会话
POST /bridge/sessions                      创建新会话（cc-connect 分配 session ID）
POST /bridge/sessions/switch               切换活跃会话（session_key + target）
GET  /bridge/sessions/<id>                 查询指定会话详情
DELETE /bridge/sessions/<id>               删除指定会话

认证方式: Authorization: Bearer <bridge.token>
配置: config.toml 中的 [bridge] 段
```

cc-linker 的 `/bridge switch` 在当前文档中覆盖两条路径：

- **已有映射**：`POST /bridge/sessions/switch` → 无需重启
- **未映射 CLI 会话**：直接写入 session JSON 创建映射，并在用户确认后重启/重载 cc-connect

后续仍与 cc-connect 上游协作，让 `POST /bridge/sessions` 支持可选的 `agent_session_id` 字段，使新建映射也不再需要重启。

### 16.5 cc-linker 与 cc-connect 的 Commands 机制

cc-connect 支持 `[[commands]]` 配置注册自定义斜杠命令，cc-linker 的飞书侧命令通过此机制接入：

```toml
[[commands]]
name = "bridge"
description = "跨平台会话管理（CLI + 飞书）"
exec = "cc-linker feishu-cmd --caller {{user}} {{args}}"
```

**执行流程**：

```
用户在飞书中发送: /bridge list
  │
  ▼
cc-connect 解析命令，匹配到 "bridge"
  │
  ▼
cc-connect 执行: cc-linker feishu-cmd --caller <user> list
  │
  ▼
cc-linker 读取 ~/.cc-linker/registry.json
  │
  ▼
cc-linker 格式化输出（Markdown 文本或飞书卡片）
  │
  ▼
cc-connect 捕获 stdout 输出，作为机器人回复发送给飞书用户
```

**exec 命令的输出规则**：

- cc-connect 捕获命令的 stdout 输出
- 支持 Markdown 格式（飞书会自动渲染）
- 非零退出码视为错误，不发送消息给用户

**动态注册方式**（无需修改配置文件）：

```
/commands addexec bridge cc-linker feishu-cmd --caller {{user}} {{args}}
```

***

## 快速开始

### 安装

```bash
# 从 npm 安装（发布后）
npm install -g cc-linker

# 从源码安装
git clone https://github.com/xxx/cc-linker.git
cd cc-linker
bun install
bun run build
```

### 初始化

```bash
cc-linker init
```

### 常用命令

```bash
# 列出所有会话
cc-linker list

# 恢复指定会话
cc-linker resume <UUID前缀>

# 查看会话详情
cc-linker show <UUID前缀>

# 手动同步
cc-linker sync

# 查看状态
cc-linker status

# 安装 Hook（自动注册新会话）
cc-linker hook install
```

### 飞书集成

在 cc-connect 的 `config.toml` 中添加：

```toml
[[commands]]
name = "bridge"
description = "跨平台会话管理（CLI + 飞书）"
exec = "cc-linker feishu-cmd --caller {{user}} {{args}}"
```

然后在飞书中使用：

- `/bridge list` — 列出所有会话
- `/bridge switch <Ref>` — 切换到指定会话
- `/bridge resume <Ref>` — 获取终端恢复命令
- `/bridge status` — 查看桥接状态


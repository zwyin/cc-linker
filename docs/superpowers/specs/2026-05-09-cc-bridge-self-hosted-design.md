# cc-linker 自建方案 Phase 1 实现设计

> 版本：v1.2
> 日期：2026-05-09
> 基于：产品设计文档 v2.2
> 状态：已确认

---

## 概述

将 cc-linker 从 cc-connect 方案迁移到自建飞书 Bot 方案，删除 cc-connect 依赖，在同一进程内实现完整的飞书 ↔ Claude Code 桥接能力。

**约束**：Phase 1 仅支持单用户私有部署（1 开发者 + 1 机器 + 1 飞书私聊 Bot）。

---

## 方案选择

采用 **6 轮递进实现**，每轮有明确边界和验证标准，不跨越范围。

---

## 第 1 轮：基础设施重构

### 删除模块

| 文件 | 原因 |
|------|------|
| `src/scanner/cc-connect.ts` + 测试 | 不再扫描 cc-connect session 文件 |
| `src/bridge/client.ts` + 测试 | 不再调用 cc-connect Bridge API |
| `src/cli/commands/feishu-cmd.ts` | 飞书命令改由 Bot 进程内处理 |

### 重构 `src/registry/types.ts`

- 移除字段：`source`、`platform`、`owner`、`cc_connect_session_id`、`visibility`、`shared_with`
- 新增字段：`project_dir`、`jsonl_path`、`pending_jsonl_resolve`、`last_error`、`feishu_session_id`、`feishu_user_id`
- 新增状态枚举：`'provisioning' | 'active' | 'archived' | 'degraded' | 'corrupted'`
- 更新 Zod schema 匹配新类型
- 旧 `registry.json` 迁移策略：Schema 对未知旧字段使用 `.strip()` 或 `.passthrough()` 平滑兼容，避免旧文件加载失败

### 重构 `src/utils/config.ts`

- 移除 `[bridge]` 段
- 新增段：`[feishu_bot]`、`[runtime]`、`[security]`、`[queue]`、`[cli_proxy]`
- 环境变量覆盖：`CC_LINKER_FEISHU_APP_ID` 等

### 重构 `src/utils/paths.ts`

- 新增：`USER_MAPPING_PATH`、`LIST_SNAPSHOT_PATH`
- 新增：`RUNTIME_OWNER_LOCK_PATH`、`RUNTIME_SESSION_EVENTS_DIR`
- 新增：`SPOOL_DIR` 及子目录常量
- 移除：`CC_CONNECT_SESSIONS_PATH`

### 更新 `src/hook/session-start.ts`

- 不再直接写 `registry.json`
- 改为写 `runtime/session-events/` 发现事件

### 更新 CLI 命令

- `resume.ts`：第 1 轮仅实现**状态检测 + 友好提示**，不触发真正的 repair
  - `active/archived` → 允许恢复
  - `provisioning` → 提示"会话仍在创建中，请稍后重试"
  - `degraded` → 提示"会话处于降级状态，原因: xxx"
  - `corrupted` → 拒绝恢复
- `resume.ts`：真正的 repair 逻辑留到第 5 轮 Reconciler / Repair 能力就绪后再接入；若检测到 `owner.lock` 且 repair 会写状态，则拒绝离线直写
- `init.ts` / `sync.ts` / `clean.ts`：检测 owner.lock，运行时拒绝写入
- `repair.ts`（如实现）：检测 owner.lock，运行时拒绝写入
- `scanner/index.ts`：移除 cc-connect 扫描
- `registry.ts`：更新 merge 调用链，移除对 cc-connect scanner 的依赖

### 完成标准

- `bun test` 全绿
- `cc-linker init/list/show/search/export/clean/status` 命令正常工作

---

## 第 2 轮：Claude Session Manager

**新文件**：`src/proxy/session.ts`

### 核心接口

```typescript
interface SessionManager {
  sendMessage(sessionId: string | null, text: string, cwd: string, isNew?: boolean): Promise<SendMessageResult>;
  listSessions(): ClaudeSession[];
  cleanupIdleSessions(idleTimeoutMs: number): void;
}
```

> `listSessions()` 仅表示 Session Manager **当前在内存中跟踪的活跃进程/活跃会话**，用于进程管理与调试；它**不替代** Registry 的全量会话查询。`/bridge status`、`/bridge list` 这类用户可见统计应直接读取 Registry。

### 实现要点

- 每次飞书消息 spawn 新 `claude -p "..." --output-format json` 进程
- 新会话不带 `--resume`；已有会话带 `--resume <id>`
- `~` 路径展开为绝对路径
- 超时：STALE_TIMEOUT（5 分钟无输出）+ HARD_TIMEOUT（30 分钟兜底）
- 进程组回收（SIGTERM → SIGKILL）
- per-session 锁 + 全局并发上限（默认 2）
- jsonl_path 补齐：短轮询 `~/.claude/projects/*/<sessionId>.jsonl`
- 启动时清理孤儿子进程

### 完成标准

- 单元测试通过（mock spawn）
- 集成测试验证真实 `claude -p` JSON 解析

---

## 第 3 轮：User Mapping + List Snapshot

### `src/feishu/mapping.ts`

- 加载/保存 `~/.cc-linker/user-mapping.json`
- 三种 entry 类型：session、pending_new_session、pending_new_session_claimed
- `compareAndSwap(openId, expectedEntry, newEntry)` — 原子 CAS 抢占
- CAS 必须在独占文件锁内执行，基于 `mapping.version + entry.type + claimedByMessageId` 判定
- CAS 成功后递增 `mapping.version`，防止 ABA / 丢更新
- owner 校验（配置指定 vs 自动绑定）
- pending_new_session_claimed 超时回滚

### `src/feishu/list-snapshot.ts`

- 保存最近一次 `/bridge list` 序号映射
- TTL 10 分钟过期清理
- 序号 → UUID 解析（`/bridge switch 1`）

### 完成标准

- 单元测试通过，重点验证 CAS 原子性和超时回滚

---

## 第 4 轮：Feishu Bot + Spool Queue

### `src/queue/spool.ts`

- 消息原子写入：write(temp) → rename()
- 状态流转：pending → processing → replied → done/failed
- 入站幂等：receipts/<messageId>.json
- 出站幂等：deliveries/<messageId>.json（sending/sent + stable requestUuid）
- Target Snapshot：入队时固化目标
- Snapshot 枚举至少包括：`session`、`new_session_claim`、`new_session_creating`、`no_target`
- 串行键：session_uuid / new:<open_id>
- claim 键：`claim:<open_id>`，用于将 `pending_new_session` 原子切换到 `pending_new_session_claimed`
- 队列上限 100，超限拒绝
- 归档清理：done 24h/1000条、failed 7d/200条

### `src/feishu/bot.ts`

- WSClient 长连接接收 im.message.receive_v1
- Client 发送回复（im.v1.message.create）
- WSClient 回调：私聊校验 + owner 校验 + 幂等 + spool 落盘（<100ms）
- `im.v1.message.create` 必须带稳定 `uuid`；建议 `sha256(messageId + ":" + chunkIndex)`
- Dispatcher：扫描 spool → 按并发调度 → handleCommand / handleChat → 回复 → finalize
- 当 mapping 已为 `pending_new_session_claimed` 时，普通文本应生成 `new_session_creating` 快照并返回“新会话正在创建”提示
- 命令处理：/bridge help/list/new/switch/resume/status
- `/bridge new` 解析完 `cwd` 后，必须执行 `security.allowed_roots` / `security.denied_roots` 校验
- 命中高风险目录时，按 `security.confirm_risky_actions` 执行二次确认或直接拒绝
- 错误兜底、超长回复分片

### 完成标准

- 集成测试验证飞书消息全链路（mock WSClient + API）

---

## 第 5 轮：Runtime Coordinator + Startup Reconciler

### `src/runtime/state-coordinator.ts`

- owner.lock 获取/释放
- 运行中只有主进程可写状态文件
- CLI 写命令检测 lock → 拒绝
- 写命令范围包括：`init/sync/clean/resume(带 repair)/repair`

### `src/runtime/reconciler.ts`

- processing → pending 恢复
- replied + delivery=sent → done
- provisioning/degraded 重试 jsonl_path
- Mapping 与 Registry 一致性校验
- 卡住的 pending_new_session_claimed 回滚
- session-events 归并
- 过期文件清理

### `cc-linker start` 命令

- 获取 owner.lock → startupReconcile → 启动 WSClient → 启动 Dispatcher
- SIGINT/SIGTERM 优雅停机

### 完成标准

- 模拟崩溃恢复测试

---

## 第 6 轮：端到端测试 + 故障注入

| 场景 | 验证内容 |
|------|----------|
| 正常链路 | 飞书→spool→Claude→飞书回复 |
| 竞态 | /bridge switch 后排队消息正确路由 |
| 连续消息 | 两条普通文本不创建两个新会话 |
| 崩溃恢复 | 回复成功后 kill → 重启不重复回复 |
| 出站幂等 | 飞书发送超时但服务端可能已收 → 重试不重复回复 |
| 锁冲突 | 服务运行时执行 init/sync/clean/resume-repair → 被 owner.lock 拒绝 |
| jsonl_path 延迟 | 新会话 provisioning → 后台补齐 |
| 列表快照过期 | 10 分钟后序号参数 → 提示重新 list |
| 超时 | Claude 5 分钟无输出 → kill → 飞书提示 |

---

## 架构隔离

```
src/proxy/        — Claude 进程管理（纯 CLI 能力，不依赖飞书）
src/feishu/       — 飞书 Bot 入口（消息收发、命令路由）
src/queue/        — 可靠消息队列（spool + Dispatcher）
src/runtime/      — 运行态协调器（owner.lock + reconciler）
src/registry/     — 会话索引（共享模块）
src/scanner/      — JSONL 扫描（共享模块）
src/cli/          — CLI 命令（共享模块）
src/utils/        — 工具函数（共享模块）
```

模块依赖关系：
- `src/feishu/bot.ts` → `src/queue/spool.ts` → `src/proxy/session.ts` → Claude CLI
- `src/feishu/bot.ts` → `src/feishu/mapping.ts` → `src/feishu/list-snapshot.ts`
- `src/runtime/reconciler.ts` → `src/registry/` + `src/feishu/mapping.ts` + `src/queue/spool.ts`

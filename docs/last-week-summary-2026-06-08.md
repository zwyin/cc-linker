# cc-linker 上周需求总结（2026/06/01 - 2026/06/08）

> **版本演进**：`0.3.4` → `0.4.0` → `0.4.1`
> **提交总数**：~160 commits
> **测试覆盖**：720+ tests passing
> **前置要求**：Claude Code ≥ 2.1.139 + daemon 运行中（`~/.claude/daemon/roster.json` 存在）

---

## 一、核心新功能：飞书 Agent View（完整稳定）

### 1.1 功能概述

Agent View 是这一周的核心交付，让飞书端可以**查看、监控、接管**终端侧 Claude Code 的 background sessions。用户在手机上就能：

- 查看所有后台 session 的运行状态（busy / waiting / idle / completed）
- Peek 查看 session 的最新对话内容
- 向等待中的 session 发送消息
- 停止活跃 session
- 接管 session 继续对话

**前置条件**：Claude Code 版本 ≥ 2.1.139，且 daemon 正在运行。不满足条件时 `/agents` 会提示具体原因。

### 1.2 `/agents` 命令

在飞书中发送 `/agents`，展示当前所有 background session 的交互卡片：

- **状态分组**：按 busy（✽ 处理中）/ waiting（✋ 等待输入）/ idle（⏹ 空闲）/ completed（⏹ 已完成）四组展示
- **名称展示**：优先从 JSONL 提取第一条有意义的 user prompt 作为名称（如 `Print date every five seconds`），而非无意义的 short hash。过滤掉 `继续`/`ok`/`yes` 等无意义短回复
- **每个 session 显示**：状态 emoji + 名称 + 已运行时间 + 工作目录
- **操作按钮**：
  - 所有 session：`[Peek]`（查看详情）+ `[Attach]`（接管）
  - waiting 状态额外显示：`[Reply]`（回复消息）
  - busy 状态额外显示：`[Stop]`（停止，红色危险按钮）
- **列表底部**：`[🔄 Refresh]` 刷新按钮，2s 防抖
- **溢出折叠**：超过 **10 个** session 时显示 "… N more（用 claude agents --cwd <path> 缩小范围）"
- **自动过滤**：过滤 Task tool 派生的 subagent sessions（通过 JSONL 中 `isSidechain` 字段识别），与 Agent View 的 `source='spare'` 过滤保持一致
- **25KB 安全降级**：卡片超过 25KB 时自动退化为简洁文本消息，避免飞书 API 报错

**配置**：通过 `~/.cc-linker/config.toml` 的 `[agent_view]` 段控制，完整配置项：

| 配置键 | 默认值 | 环境变量覆盖 | 说明 |
|--------|--------|-------------|------|
| `enabled` | `true` | `CC_LINKER_AGENT_VIEW_ENABLED` | 是否启用 Agent View |
| `refresh_min_interval_ms` | `2000` | `CC_LINKER_AGENT_VIEW_REFRESH_MIN_INTERVAL_MS` | Refresh 按钮防抖间隔 |
| `peek_lines` | `30` | `CC_LINKER_AGENT_VIEW_PEEK_LINES` | Peek 最大显示行数 |
| `peek_max_bytes` | `2048` | `CC_LINKER_AGENT_VIEW_PEEK_MAX_BYTES` | Peek 最大字节数 |
| `expected_reply_timeout_ms` | `300000` | `CC_LINKER_AGENT_VIEW_EXPECTED_REPLY_TIMEOUT_MS` | Reply 等待超时（5 分钟） |
| `background_only` | `true` | `CC_LINKER_AGENT_VIEW_BACKGROUND_ONLY` | 仅展示 background sessions |
| `stop_requires_confirm` | `true` | `CC_LINKER_AGENT_VIEW_STOP_REQUIRES_CONFIRM` | 停止需要二次确认 |
| `min_claude_version` | `'2.1.139'` | —（无环境变量覆盖） | 最低 Claude Code 版本要求 |
| `reply_throttle_ms` | `500` | `CC_LINKER_AGENT_VIEW_REPLY_THROTTLE_MS` | Reply 消息发送节流 |

### 1.3 Peek（查看 session 内容）

点击 session 卡片的 `[Peek]` 按钮进入详情视图：

- **JSONL 倒序扫描**：直接读 JSONL 文件的最后一条 assistant 文本，避免终端 box-drawing 字符渲染成方块（之前用 `claude logs` 的屏幕 buffer，飞书 monospace 字体渲染成 □）
- **大文件优化**：JSONL > 2MB 时只读最后 256KB，避免全量读取
- **智能截断**：优先按段落边界截断（`\n\n`），其次按行边界，最后硬切。截断后追加 `…(已截断)`
- **实时刷新**：`[🔄 Refresh]` 按钮刷新内容，2s 防抖。如果 session 已消失，自动 patch 为错误卡 "会话已不存在 / 已自动刷新列表"
- **状态信息**：显示 Status、CWD、PID、启动时间、等待原因（waiting 状态）

### 1.4 Reply（向等待中的 session 发消息）

对 waiting 状态的 session 发送消息，点击 `[Reply]` 按钮：

- **两步流程**：
  1. 点击 `[Reply]` → 卡片变为黄色等待卡 `✍️ 等待输入回复`，提示 "请直接发送文字消息作为回复（5 分钟内有效）"
  2. 直接发送文字 → 消息通过 `runChatSDK` 投递到目标 session
- **CAS 保护**：`pending_agent_reply` 状态使用 Compare-and-Swap 保护，防止并发竞争
- **5 分钟超时**：超时自动清理，防止死锁。Bot 重启时自动恢复未过期的等待状态
- **取消**：点击 `[取消等待]` 按钮或发送 `/agents` 返回列表

### 1.5 Stop / StopConfirm（停止 session）

两步确认停止活跃 session，点击 `[Stop]` 按钮：

- **Step 1**：弹出红色确认卡 `🔴 确认停止?`，提示 "该 session 正在处理任务，停止后无法撤销"
- **Step 2**：点击 `[✅ 确认停止]` 或 `[← 取消]`
- **Fire-and-forget**：确认后立即 patch 卡片为 "正在停止..."，后台执行 `claude stop <shortId>`（5s 超时），避免飞书 card action 3s 超时
- **完成反馈**：成功 → "✅ 已停止 {shortId}" + 自动返回列表；失败 → "❌ Stop 失败:{error}"

### 1.6 Attach（接管 session）

点击 `[Attach]` 按钮，将飞书当前会话切换到目标 session：

- **Short ↔ Full UUID 兼容**：自动展开 short hash 为 full UUID（通过 `JsonlIndex` 查找 JSONL 文件路径），避免 `claude -p --resume <short>` 被 SDK 拒绝
- **Guard 检查**：接管前重新 fetch snapshot 验证 session 仍存在，防止 click→action 期间的 status flip
- **Live Worker 警示**：如果 `roster.workers[short]` 存在（daemon bg worker 仍在跑），追加提示 "⚠️ 该 session 仍有 bg worker 在跑。直接发消息会被阻拦"，让用户对接下来的 bg-conflict 拒绝卡有预期
- **CAS 状态切换**：通过 UserManager CAS 更新用户状态，保留 `defaultProvider` 字段

### 1.7 Bg-Conflict 拒绝卡（安全修复）

**这是这一波最关键的安全修复**。当用户 Attach 到活跃 bg session 后发消息时：

- **触发条件**：`sessionUuid` 在 `roster.workers` 中（daemon worker 仍在跑）
- **默认拒绝并发**：弹出黄色警告卡 `⚠️ bg worker 仍在运行`，展示用户要发送的消息预览（截断到 100 字符）
- **三个恢复路径**：
  - 🛑 **`[停 bg 后继续发送]`**（primary 按钮）：立即 patch 卡片为 "🛑 bg worker 已停止 / 正在发送你的消息..."（<1s，不触发飞书 3s 超时），后台执行 `claude stop <shortId>` → 等 1s → fallback 到 parent session → 发送消息
  - 🌿 **`[开新会话发送]`**：patch 卡片为 "🌿 开新会话中..."，创建全新 session 发送消息
  - ❌ **`[取消]`**：patch 卡片为 "❌ 已取消 / 消息未发送，bg worker 不受影响"
- **为什么这样改**：之前 v2.2.10 默默 swap 到 parent JSONL，让两个 claude 进程共享同一个 cwd，改文件会互相覆盖，导致工作丢失。**安全 > 便利**。
- **Parent Fallback**：🛑 路径总是 fallback 到 parent session（从 `roster.launch.sessionId` pre-compute），不继承 worker 增量内存，避免脏状态

### 1.8 Completed Sessions（已结束 session）

列表中也会展示已完成的 background sessions（来自 daemon.log 最近 24h）：

- **daemon.log 推断 source**：解析 `[bg] bg claimed-spare <short>` 事件，补出 source（spare/slash/fleet），过滤掉 spare 子 agent
- **Name Fallback**：优先从 JSONL 第一条 user prompt 提取名称；没有 JSONL 时从 `claude agents --json` 的 `dispatch.seed.name` 派生；都没有则显示 short hash
- **Name Cache**：活跃 session 的名称缓存到 `~/.cc-linker/agent-names-cache.json`（TTL 48h），completed session 可复用。JSONL 派生名称始终优先于缓存，防止缓存污染

---

## 二、Scanner 预览质量优化

### 2.1 问题背景

飞书 `/list` 命令和 session 概览卡中的预览文本之前质量很差：包含大量 markdown 噪声（`##`、`**`、`` ` ``），被粗暴按字符截断（可能在词中间断开），看着像乱码。

### 2.2 解决方案

#### cleanAssistantText（240 字符 cleaned 输出）

从 assistant 回复中提取干净的 final-answer：

- **逆向遍历**：从最新消息向前扫描，跳过含 `tool_use` 的条目，只取纯文本块
- **stripMarkdownNoise**：清理 `##`（标题标记）、`**`（加粗）、`` ` ``（行内代码/代码围栏）
- **truncateByLine**：240 字符预算，预留 3 字符给 `...`。优先在行边界截断（>50% 预算处有换行），否则硬切
- **全空白检测**：全空白 text 块返回 null

#### parseTail / parseFull 走 cleaned 路径

- **parseTail**（增量扫描）：读 JSONL 最后 4KB，提取 `lastUser`（≤80 字符）和 `lastAssistant`（≤100 字符），取更近的一个。如果 4KB 内没找到且文件 > 4KB → 全量重读 fallback
- **parseFull**（全量扫描）：正向提取 cwd/title/firstUser，反向提取 lastUser/lastAssistant，用 `cleanAssistantText(…, 240)` 生成预览
- **性能优化**：parseTail 用 push+reverse 替代 unshift，消除 O(n²) 复杂度
- **非消息类型排除**：`ai-title`、`last-prompt`、`queue-operation`、`activity_marker` 等 8 种类型不计入 message_count

#### Registry Schema v3→v4

新增两个预览字段：

| 字段 | 类型 | 上限 | 说明 |
|------|------|------|------|
| `last_user_preview` | string | 80 字符 | 最后一条 user prompt（cleaned） |
| `last_assistant_preview` | string | 240 字符 | 最后一条 assistant 回复（markdown 噪声已清理） |

- **幂等迁移**：`migrateV3toV4` 支持重复调用，load()/reload() 时自动迁移并写盘
- **scan_cache schemaVersion**：缓存版本号不匹配时自动失效重扫，确保 preview 字段正确填充
- **老 entry 兼容**：`is_subagent`（v0.4.1 新增）等可选字段使用 z.object non-strict，老 entry 自动通过验证

### 2.3 用户可感知的效果

- `/list` 卡片中每个 session 现在显示**干净的最后对话摘要**，而不是 markdown 乱码
- Overview 卡片显示**最后提问**（引用格式）和**最后回复**（引用格式）
- 标题优先用 AI 生成的 title，fallback 到最后一条 user prompt，最长 50 字符 + `...`
- 智能按行截断，不会在词中间断开

---

## 三、飞书 Live Progress Card（实时进度卡）

### 3.1 功能概述

当 session 正在运行时（通过 `/switch` 切换到一个处理中的 session），飞书侧的卡片会**实时更新**，让用户无需反复查询就能看到进度：

- **10s 轮询**：每 10 秒更新一次卡片内容
- **~133min 最大时长**：800 ticks × 10s ≈ 133 分钟，防止死循环
- **3 次 patch 失败自动停止**：连续 3 次飞书 API patch 失败后自动停止 watcher
- **运行时间显示**：`⏱️ 已运行 Xm Ys`，超过 30s 无新输出时追加 `⏳ Xm 未收到新输出`
- **自动检测结束**：每轮 tick 检查 session 是否仍在处理，结束后发送最终卡片（`isRunning=false`）并停止

### 3.2 用户场景

1. 用户在终端跑了 `claude --bg "重构认证模块"`
2. 在飞书 `/switch` 到这个 session → 看到橙色概览卡 `🔄 处理中会话`
3. 卡片每 10 秒自动刷新：最新 assistant 输出、已运行时间、距上次输出的间隔
4. session 完成后 → 卡片自动变为 `🔄 已切换会话`（蓝色），显示最终摘要
5. 用户直接发消息即可继续对话

### 3.3 LiveProgressWatcher 实现

- **JSONL 尾部读取**：每轮 tick 调用 `parseTailForPreview` 读最后 4KB 提取最新 assistant 文本
- **触发启动**：`doSwitch` 检测到 session 正在处理时自动创建并启动
- **停止时机**（4 种）：
  - `session_gone`：session 在 registry 中不存在
  - `patch_failed`：连续 3 次飞书 API 失败
  - `max_ticks`：达到 800 tick 上限
  - `idle`：session 不再处理（正常结束）
  - `user_new_message`：用户发新消息
  - `new_switch`：用户切换到其他 session
  - `user_stop`：用户执行 `/stop`
  - 优雅关闭：bot shutdown 时停止所有 watcher

### 3.4 卡片样式

- **处理中**（橙色模板 `🔄 处理中会话`）：
  - `🔴 处理中 · {title}` + `_(实时)_` 标记
  - `⏱️ 已运行 Xm Ys` + `⏳ Zm 未收到新输出`（>30s 时）
  - `💬 最后提问：` > 引用
  - `🤖 最后回复：` > 引用（或 `⏳ 正在处理中，请稍候...`）
  - `📊 {message_count} 条消息 · {timeAgo} · {origin/status}`
  - `💡 直接发送消息即可继续此会话`
  - `[📖 恢复指引]` 按钮
- **已切换**（蓝色模板 `🔄 已切换会话`）：同上但去掉运行时间/实时标记

---

## 四、Session Activity Sync（会话活动同步）

### 4.1 问题背景

CLI 侧跑的 session（非 SDK 模式），飞书侧无法感知其活动状态，导致：

- 用户从飞书发消息到 CLI 正在用的 session，没有提示，两端并行操作同一个 JSONL 可能冲突
- 无法判断 session 是否活跃

### 4.2 用户场景

1. 用户在终端用 `claude` 跑一个长任务（非 SDK 模式）
2. 在飞书发消息到同一个 session → bot 检测到 CLI 正在使用
3. 飞书弹出黄色警告卡 `⚠️ CLI 侧会话处理中`，显示检测依据和风险提示
4. 用户可以选择：
   - 等 CLI 处理完再发
   - 点击 `⚠️ 我了解风险，仍要发送` → 消息立即发送（跳过活动检查）
   - 发一条新消息 → 自动覆盖之前的强发请求
   - 60s 无操作 → 自动按强发处理（孤儿超时机制）

### 4.3 Session Activity 模块

#### 检测信号（优先级从高到低）

| 信号 | 检测方式 | 置信度 |
|------|---------|--------|
| Activity marker | 读 sidecar 文件最后一条 marker，`action=end` → 不活跃 | 高/中/低（按时间衰减：<3min 高，<10min 中，<30min 低） |
| 进程检测 | 按 cwd 找 claude 进程 → 查子进程（深度 3）→ 采样 CPU 1s | >10% 高，>2% 中 |
| JSONL mtime | 500ms 双采样，检查文件大小/修改时间是否变化 | 中 |

- **检测超时**：3s（不缓存超时结果，避免假阴性）
- **缓存 TTL**：10s（同一 session 10s 内只检测一次）
- **跨平台**：Linux 用 `/proc` 文件系统，macOS 用 `lsof` + `ps` 命令

#### Sidecar 文件

- **路径**：`~/.cc-linker/activity/<sessionUuid>.log`
- **格式**：每行一条 JSON marker（`{type, platform, action, timestamp, pid, version}`）
- **读取方式**：只读最后 4KB，倒序找最后一条 marker
- **自动轮转**：文件 > 64KB 且距上次轮转 ≥ 30s → 保留后 50%（32KB）
- **24h 清理**：自动清理 24 小时前的旧文件，`warnedSessionUuids` 上限 500

### 4.4 Activity Hook

新增 `activity-hook` CLI 子命令，供 Claude Code hooks 集成（在 `config.toml` 的 `[hooks]` 段配置）：

```bash
# Claude Code session 启动时
cc-linker activity-hook --platform cli --action start --session <uuid>

# Claude Code session 结束时
cc-linker activity-hook --platform cli --action end --session <uuid>

# 心跳（默认动作）
cc-linker activity-hook --platform cli --action heartbeat --session <uuid>
```

参数说明：
- `--platform`：`cli` 或 `feishu`（默认 `cli`）
- `--action`：`start`、`end` 或 `heartbeat`（默认 `heartbeat`）
- `--session`：session UUID（默认读 `$CLAUDE_SESSION_ID` 环境变量）

### 4.5 CLI Busy 卡片 + 强制发送

当用户从飞书发消息到 CLI 正在用的 session 时的完整流程：

1. **检测**：`isSessionActive(entry, cache, 'feishu-detects-cli')` 返回 `isProcessing=true && confidence !== 'low'`
2. **弹卡片**：黄色 `⚠️ CLI 侧会话处理中`，显示：
   - 会话标题
   - 检测依据（如 "Activity marker: 2 分钟前启动"）
   - 风险提示："点击下方按钮不会中断 CLI 任务，而是让飞书侧同时处理。JSONL 写入可能冲突"
   - 按钮：`⚠️ 我了解风险，仍要发送`（danger 样式）
3. **消息暂存**：消息留在 `processing/` 目录，标记 `awaitingForceSend: true` + `busySinceAt` 时间戳
4. **用户点击按钮** → `handleForceSendCardAction`：
   - 设 `skipActivityCheck: true, awaitingForceSend: false`
   - `requeueFromProcessing()` 移回 `pending/`
   - 下一个 dispatch 周期自动 claim 并处理
5. **孤儿超时**：60s 无操作 → worker 自动按强发处理（防止用户忘记）
6. **新消息覆盖**：用户发新消息时，自动将旧的 `awaitingForceSend` 消息标记为 done
7. **错误处理**：
   - 会话不存在 → `❌ 错误 / 会话不存在`
   - 消息已被处理 → `ℹ️ 消息已被处理`

---

## 五、并发命令 + Session Overview Card

### 5.1 并发命令场景

之前 `/list`、`/switch` 等命令消息和普通聊天消息共享同一个 serialKey（`sessionUuid`），导致长命令（如 `/switch` 触发 session 切换 + 状态检测）阻塞后续聊天消息入队。

**修复**：command messages 使用独立的 `cmd:{openId}:{msgId}` serialKey，与普通聊天的 `{sessionUuid}` serialKey 互不干扰。同时 dispatch 循环增加 poll tick，长任务执行期间仍然可以 claim 新消息（之前 /list 可能卡 60s 等 long worker）。

### 5.2 Session Overview Card

`/switch` 命令现在返回一张**交互式概览卡**（替代之前的纯文本回复）：

- **处理中**（橙色模板）：显示 `🔴 处理中 · {title}`、运行时间、最后提问/回复、消息数、来源
- **非处理中**（蓝色模板）：同上但去掉运行时间
- **自动启动 Live Watcher**：如果 session 正在处理，自动创建 LiveProgressWatcher 开始 10s 轮询
- **所有用户可控字段过 esc()**：防止 markdown 注入
- **底部提示**：`💡 直接发送消息即可继续此会话` + `[📖 恢复指引]` 按钮

---

## 六、安全与稳定性修复

### 6.1 Markdown 转义

- **esc() 共享模块**：提取到 `src/feishu/markdown-escape.ts`
- **全字段覆盖**：list/overview/model/dir 卡片的所有用户可控字段都过 esc()
- **1-based numbering**：list 卡片序号从 1 开始，末尾不输出 `<hr>`

### 6.2 Message ID 校验

- **白名单校验**：messageId 只允许 `/^[a-zA-Z0-9_-]+$/`
- **SAFE_ID_REGEX**：提取到共享 util，cap 改为 `{1,80}`
- **入口校验**：handleCardAction 入口即校验，防止注入

### 6.3 Registry v3→v4 Migration

- **幂等迁移**：`migrateV3toV4` 支持重复调用
- **持久化**：load()/reload() 时自动迁移并写盘
- **死锁修复**：reload() 释放读锁后再获取写锁

### 6.4 Scanner 修复

- **try/finally fd 清理**：文件描述符泄漏修复
- **4KB 边界测试**：确保 4KB 边界处理正确
- **非消息类型排除**：parseTail/parseFull 排除 tool_use、tool_result 等非消息类型

### 6.5 其他修复

- **dispatch poll tick**：长任务不阻塞 claim（之前 /list 会卡 60s 等 long worker）
- **孤儿消息循环**：busy 卡片 replyMessageId 缺失修复
- **强制发送状态**：keep message in processing/ so 强制发送 button works
- **daemon 关闭**：await bot.shutdown() + 优雅停止 live watchers

---

## 七、基础设施与工具

### 7.1 部署脚本

- **deploy-local.js**：build + global install + restart 一键部署
- **reload-daemon.js**：build + restart daemon 一键重启

### 7.2 配置扩展

- **[agent_view] 配置段**：9 个配置项（详见 1.2 节表格），8 个支持 `CC_LINKER_` 环境变量覆盖
- **[feishu_bot.live_progress]**：3 个配置项（`interval_ms`=10000, `max_ticks`=800, `max_patch_failures`=3）
- **[runtime]**：4 个 session activity 相关配置（`activity_cache_ttl_ms`=10000, `activity_marker_ttl_ms`=1800000, `cli_process_detection_enabled`=true, `jsonl_mtime_detection_enabled`=true）
- **Runtime Override**：`setRuntimeOverride` 支持瞬态运行时覆盖（不写盘，重启失效）

### 7.3 测试覆盖

- **720+ tests passing**：覆盖所有新功能
- **并发测试**：场景 A/C/E 覆盖并发命令 + 长任务
- **集成测试**：live progress card 场景 A/B/C/D
- **回归测试**：V1（in-flight watcher + /switch B identity check）、C7 fix

---

## 八、已知限制（deferred to 0.4.1+）

1. **Interactive TUI sessions 不展示**：`background_only` 默认 `true`，只展示 `kind === 'background'` 的 session。TUI 交互模式的 session 被过滤掉。如需查看可设 `background_only = false`
2. **空 JSONL 的 bg session**：parent 派发后 worker 没有用户输入（如 `print-date` 一次性任务），JSONL 为空，名称退化到 short hash
3. **Reply 活 worker 不可用**：飞书 SDK 走 `claude -p --resume` 不能投递到正在运行的 daemon worker（daemon IPC 不暴露），只能等 worker 变为 waiting 状态后才能 Reply
4. **Peek 大文件限制**：JSONL > 2MB 时只读最后 256KB，极端情况下可能错过较早的 assistant 输出
5. **daemon.log 24h 窗口**：completed sessions 只从最近 24h 的 daemon.log 中读取，更早的已完成 session 不展示

---

## 九、用户操作速查

| 我想做什么 | 在飞书怎么做 |
|-----------|------------|
| 查看所有后台 session | `/agents` |
| 查看某个 session 的最新输出 | 点 `[Peek]` |
| 给等待中的 session 发消息 | 点 `[Reply]` → 直接发文字 |
| 停止一个正在跑的 session | 点 `[Stop]` → `[✅ 确认停止]` |
| 接管一个 session 继续聊 | 点 `[Attach]` |
| 切换到一个 session | `/switch <name或uuid>` |
| 查看 session 实时进度 | `/switch` 到处理中的 session，自动 10s 刷新 |
| 发消息但 CLI 正在用 | 弹警告卡 → 点 `⚠️ 我了解风险，仍要发送` |
| Attach 到活跃 bg worker 后发消息 | 弹 bg-conflict 卡 → 选 🛑/🌿/❌ |

---

## 十、总结

这一周的核心交付是 **飞书 Agent View 从"能跑"到"能用"**，22 个 commit 修复了大量边界问题。最关键的安全修复是 **bg-conflict 拒绝卡**：当 daemon worker 仍在运行时，阻止用户从飞书直接发消息导致文件系统冲突，提供三个安全的恢复路径。

其他重要交付：
- **Scanner 预览质量优化**：markdown 噪声清理 + 智能截断，`/list` 和概览卡的预览文本从乱码变为可读摘要
- **Live Progress Card**：`/switch` 到处理中的 session 后，卡片每 10s 自动刷新，用户无需反复查询
- **Session Activity Sync**：CLI 正在用的 session，飞书侧会弹警告卡提示冲突风险，支持一键强发

**版本**：0.3.4 → 0.4.0 → 0.4.1 | **测试**：720+ passing | **提交**：~160 commits

**下一步**（0.4.2+）：
- Interactive TUI sessions 支持（`background_only` 开关放开后的展示问题）
- 空 JSONL 的 bg session name fallback（从 parent JSONL 找原始 `/background` 命令）
- Reply 活 worker 的 daemon IPC 支持

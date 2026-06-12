# Changelog

All notable changes to cc-linker are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/), version numbers follow
[Semantic Versioning](https://semver.org/).

## [0.6.0] - 2026-06-13

Agent View 在这个版本完成两次大改造:

1. **数据源切到 `~/.claude/jobs/<short>/state.json`**(v2.3 系列): CLI 的 background
   session 状态机由 `state.json` 落盘, `/agents` 列表、Peek、状态名都从这里读;
   `claude agents --json` 在 v2.1.163 起 `status` 始终为 `idle`, 仅保留为
   smoke test。
2. **Rendezvous Reply GA**(v2.4): 飞书侧给 background waiting session 回复时,
   不再 spawn 新 `claude` 进程, 而是通过 JSON-RPC 直接把 reply 喂回正在等待
   的 daemon, 完整流式 reply 实时 patch 到分层 Feishu 卡片。
   `[agent_view].rendezvous_enabled` 默认开启。

### Added

#### Agent View — state.json 数据源 (v2.3)

- **`job-state.ts`** — 新模块, 包含 `readJobState` / `readAllJobStates` /
  `jobStateToSession` 三个主入口, 把 `~/.claude/jobs/<short>/state.json` envelope
  映射为 `AgentSession`(waiting / busy / idle / completed, 🛑 / ✅ 前缀)。
- **`CLAUDE_JOBS_DIR`** 路径常量(`src/utils/paths.ts`)。
- **`snapshot-fetcher` 流水线**: VersionGuard → DaemonProbe → `claude agents --json`
  smoke test(返回值丢弃) → `readAllJobStates()` 为主数据源 → `roster.json` +
  `daemon.log` 兜底 `dispatch.source` → `deriveNameFromJsonl` 仅做 cold-path
  fallback。
- **Card v2.3** — `buildListCard` 改为 waiting-first 排序, detail 行作为副标题,
  footer 注明 "data: state.json"。
- **Peek 优先用 `state.json.linkScanPath`**(Tier 1a), 比 JSONL index 更准。

#### Agent View — Rendezvous Reply (v2.4)

- **`RendezvousClient`**(`src/agent-view/rendezvous-client.ts`): JSON-RPC over UDS,
  发 `reply` 给 daemon, 拉 state patch 流, 把流式 chunk 透传给 CardUpdater。
- **`readLastAssistantTurn`**: 从 JSONL 抽取上一轮 assistant 输出, 灌入
  Reply 卡片的 "AI 最近输出" 区。
- **`checkRendezvousEligibility`**: 判断当前 session 是否满足 rendezvous reply
  前置条件(bg waiting / daemon alive / linkScanPath 可达)。
- **`runChatSDK` 改造**: rendezvous-first 路径, 不命中再 fall back 到 spawn
  `claude -p`; reply 路径补 `markSent` (M1) + `messageId` 透传 + 空文本防御 (M7)
  + 条件化完成消息。
- **`[agent_view].rendezvous_enabled` 配置项**(默认 `true`) + `timeout_ms`
  (默认 30000)。
- **流式 reply 分层卡片** — header(状态 / 名称) + 流式 body(thinking + text) +
  分组 action(Refresh / Reply / Stop / Cancel), CardUpdater 按 `stream.throttle_ms`
  节流 patch。
- **`/cancel` 命令** — 撤回当前 pending reply slot, 区分 `/stop` (杀 session)。

### Changed

- **Agent View 状态名优先级**: `state.json.name` > JSONL derive (cold fallback);
  `name-cache.ts` 已退役。
- **Completed session 限额 5 条**(v2.3.2), 老 settle session 不再塞满 list。
- **`jobStateToSession` 状态合并**: `running` / `working` 且有 `needs` →
  waiting, 简化前端分组。
- **Reply UX**(v2.3.4 - v2.3.13):
  - 独立 reply 消息 + 持续 reply, 不再原地改 list 卡;
  - 抛弃自动持续 reply, 让 `expectedReply` 自然走 5min timeout;
  - Reply prompt 升级到交互卡, 内嵌 AI 最近输出;
  - Reply 智能 CAS 放宽 — 仅 `pending_new_session_claimed` 才拒, 自动清 transient entry;
  - Reply 路径自动 stop bg, 用 pre-step 模式而不是递归 SDK。
- **`handleChat` reply 路径**补 `markReplied` + `markDone` 释放 spool 锁(v2.3.11),
  防 worker 卡死。
- **`bot.handleChat` busy 路径**(v0.5.0 起): 检测到 bg worker 时升级发 3 按钮
  bg-conflict 卡。
- **README**(`README.md` + `README_en.md`): 用户视角重写, 把 "rendezvous" /
  "spool" 等内部术语外翻为 "回到正在等待的 session" / "消息队列"。

### Fixed

- **state.json torn write 抢读**: 文件原子写中途读到不完整 JSON → 自动 retry,
  日志 warn 但不抛(v2.3.1)。
- **Reply 智能 CAS race**: user-mapping 残留 transient entry 不再 throw,
  允许同 session 转换(v2.3.3 + v2.3.3 修订)。
- **handleReply markSent + messageId 透传**(M1): rendezvous 流式 reply 启动后
  立刻 mark sent, 防 watcher 重复发卡。
- **rendezvous 空文本防御**(M7): assistant 输出空 chunk 不触发 patch。
- **Code review round 1 — 6 issues**(commit `f25e53d`): 鉴权日志 / 错误码统一 /
  patch 失败兜底 / linkScanPath 校验 / config default / 状态名 fallback。
- **Code review round 2 — JSDoc drift + wait only on success**(commit `71fa35f`):
  注释和实现同步, rendezvous 流只在 daemon 真返回 success 时 await。
- **handleReplyRequest 文案与 v2.3.9 一致化**(v2.3.10)。

### Tests

- **15 real + 3 negative state.json fixtures**(`tests/fixtures/agent-view/job-states/`)。
- **Job-state hooks**: `_jobStateHooks.daemonLogReader` / `daemonProbe` 改为可变
  hook, 避免跨文件 mock 污染。
- **Integration canary**: waiting → Reply button 的端到端用例。
- **Rendezvous regression**: 接入不影响 `/agents` 既有路径(`890b67c`)。
- **QA E2E v2.4 rendezvous 6 场景**(`docs/qa/`)。

### Docs

- `CLAUDE.md`: Agent View 数据源段落改写为 "state.json 主, `agents --json`
  smoke, `daemon.log` 兜底, JSONL 仅 cold fallback"。
- `docs/spec/` + `docs/plan/`: rendezvous reply 完整 spec + plan + 两轮 review
  修复(共 25 处 review 落地)。
- `/cancel` 命令文档补完, 明确和 `/stop` 的区别。
- v2.4 GA 状态描述同步: state emoji 顺序 / 名称来源 / 溢出折叠。

## [0.5.1] - 2026-06-09

### Fix: Completed session 的 Peek/Attach 按钮报"未知操作"

`/agents` 列表里已 settle 的 background session(`daemon.log` 兜底渲染,
非 `claude agents --json` 实时输出)点击 Peek / Attach 都会收到
"未知操作: agent_view_peek/attach"。

#### Root cause

`snapshot-fetcher.ts:enrichCompletedSessions` 给 completed session 写死
`cwd: ''`,导致 `card.ts:46-71` 渲染的按钮 value 缺 `cwd` 字段,
`agent-view/action.ts:isAgentViewValue` guard 要求 `str('cwd')` 非空
→ guard 拒 → dispatcher 落 `bot.ts:639` legacy switch default
报"未知操作"。

#### Fix

从 JSONL 路径反推 cwd。CLI 编码规则:`cwd.split('/').join('-')`,
例 `/Users/wuyujun` → `-Users-wuyujun`。`~/.claude/projects/<encoded>/<uuid>.jsonl`
的 `<encoded>` 段反向 decode(naive `-` → `/`)拿回 best-effort cwd,
Peek 按钮 value 完整,guard 通过。Peek 内容读取走 `JsonlIndex.lookup(shortId)`
不依赖 cwd,所以即使 decode 有损(原路径含 hyphen 时丢 hyphen)也不影响 Peek 功能。

#### Changed
- `src/agent-view/snapshot-fetcher.ts`:加 `_jsonlIndexHooks.lookupPath` 测试 hook
  + `decodeCwdFromJsonlPath()` 工具 + `enrichCompletedSessions` 在造 session 时
  调用二者把 cwd 补上

#### Tests
- `tests/unit/agent-view/snapshot-fetcher.test.ts`:3 个新 case
  - single-segment decode(`/Users/wuyujun`)
  - multi-segment lossy decode(`/Git/cc-linker` → `/Git/cc/linker`)
  - JSONL 缺失时 cwd 仍为 `''`(graceful fallback)

## [0.5.0] - 2026-06-09

### 飞书 Attach 后自动刷新内容卡 (Agent View 增强)

Attach 成功后,飞书侧紧跟一条可交互内容卡,每 10s 自动 patch 该 session
的 status + recentOutput,user 不用切回 CLI 就能"挂着看"。

#### Added
- **`buildAttachedCard`** 渲染器(`src/agent-view/card.ts`):reuse `buildPeekCard` 骨架,
  header title `📡 Watching · \`name\``(蓝色),按钮组
  `[Refresh] [Stop Watching] [Reply] [Stop session]`
- **25KB 智能截断**(`truncateRecentForCard`):recentOutput 优先 2048 → 1024 → 512 → 256
  字符,任一档 build 后 ≤25KB 即用,全超则降级为 warning 文字。watch 永不停
- **`AttachedCardWatcher`** 类(`src/agent-view/attached-card-watcher.ts`):
  setInterval / inFlightTick mutex / patchFailureCount / maxTicks 镜像
  `LiveProgressWatcher` 设计
- **`AttachedWatchers`** 管理器:per openId 单 watch,supersede 静默 stop
  旧 watcher 并清 map
- **5 个 stop reasons** (per-reason header title):
  `idle_settled` → ✅ 已结束 / `user_chat` → 🔌 Watch stopped · 收到新消息 /
  `user_stop` → 🔌 Watch stopped / `max_ticks` → ⏱ Watch stopped (timeout) /
  `session_gone` → ❌ Session 已结束 / `superseded` → 🔄 Watch replaced
- **`agentView.handleStopWatching`**:[Stop Watching] 按钮 handler
- **busy 路径升级**:`bot.handleChat` busy 路径(`bot.ts:988`)先 check `roster.workers`
  有无 bg worker,有则升级发 3 按钮 bg-conflict 卡,无则维持原 1 按钮 busy 卡
- **`handleChat` 入口 hook**:user 发任何文本立即 fire-and-forget 停 watch
  (reason='user_chat'),不阻碍 chat 路由
- **`handleCardAction` 新 case** `agent_view_stop_watching`:派发到
  `handleStopWatching`
- **`FeishuBot.shutdown` 集成** `attachedWatchers.stopAll()`:SIGTERM 干净收尾

#### Fixed (since 0.4.2)
- **C3**:final patch 失败时 watcher 也要 stop(防无限重试到 max_ticks=2.2h)
- **B1**:max_ticks 触发时也要 patch final 卡(header `⏱ Watch stopped (timeout)`)
- **B2**:per-reason header title 通过 `FINAL_HEADER_TITLES` map + `patchFinalCard` helper
- **修 3**:**AttachedWatchers 缓存 no-op patchFn 引用 bug**(用户报"卡片没刷新"根因)
  `start.ts:234` 初始化 `let patchFn = async () => null` no-op stub,后续 `line 417`
  才赋真值;`AttachedWatchers` 构造时缓存了 no-op 引用,后续替换看不到。修:用 getter
  `() => deps.patchFn` 每次取最新
- **patchFn 默认 1200ms 延迟**:`patch.ts:56` 旧值 `delayMs=1200`,跟 JSDoc
  + `start.ts:408` 注释说"默认 0"不一致。改 0ms,attach 后 patch 立刻发出
- **superseded 静默 stop UX bug**:用户 re-attach 时老卡没指示,容易被误以为
  "没刷新"。修:supersede 时 PATCH 老卡显示 `🔄 Watch replaced`
- **bg-conflict 路径不标 degraded**:`runChatSDK:1495` 之前硬标
  `sessionStatus: 'degraded'`,触发 `/switch` 阻断 + "自动修复"误导。改 `'active'`,
  清掉 `error` 字段(避免 `last_error: 'bg_worker_conflict'` 误导信号)
- **`_doStopAndSend` 等 1s → 3s**:治 stop bg 后新 worker 太快 respawn 触发
  `runChatSDK` 又检测到 bg worker 又弹冲突卡的 race
- **AgentSnapshotFetcher.fetch mock 泄漏**:`mock.module` 不能跨文件撤销,
  改 `(AgentSnapshotFetcher as any).fetch = mock(...)` + `afterEach` 恢复 pattern
- **handleStopAndSend 错误恢复**:`_doStopAndSend` 内 `claude stop` 报"No job matching"
  视为成功(worker 已自然 settle),不冒泡
- **sessionUuid 短 hash 展开**:`runChatSDK` 防御性 short→full 转换 + CAS 回写
  UserManager(防 SDK 拒短 hash)
- **JSDoc 过期引用**:`renderAttachedCardJson` JSDoc 删过时 "Task 3" 引用
- **test name 笔误**:"shows 4 buttons" → "shows 3 buttons"

#### Tests
- 16 new tests covering buildAttachedCard rendering (10), 25KB truncation cascade (3),
  AttachedCardWatcher lifecycle (3), tick behavior (9:happy/snapshot-fail/session-gone/
  idle+completed/active-idle/JSONL-miss/1-fail/3-fail/max_ticks), AttachedWatchers manager
  (6:start/super-sede/stop/missing-openId/identity-check/inFlightTick-mutex),
  manager integration (4:start-watch/super-sede/stop/no-op), bot cardAction dispatch (1),
  bot handleChat hook (3:has-watch/no-watch/with-cancel), AgentSnapshotFetcher mock fix (6)
- **789 pass / 0 fail / 11844 expect() calls / 74 files**

#### Deploys Since 0.4.2
- 5 deploys covering the full feature rollout + 4 critical bug fixes
- PID updates: 19013 → 75481 → 47808 → 85665 → 86163 → 82603 → 58849 → 59177 → (current)

## [0.4.2] - 2026-06-08

### Background

Patch release of 0.4.1 — bumped version to push 0.4.1 changes through deploy.

## [0.4.1] - 2026-06-08

### 飞书 /list 过滤 Task tool 派生的 subagent sessions

飞书 `/list` 命令之前会展示 Task tool 派生的 subagent sessions,跟 Agent View
已经做的 `source='spare'` 过滤不一致。这一波让两边行为对齐。

#### Added
- **scanner 检测 subagent**:扫 JSONL 时检查任何条目 `isSidechain === true`(Claude
  内部约定:Task tool 派生的 subagent 所有对话条目都标这个),命中就设
  `is_subagent: true` 到 SessionEntry
- **`is_subagent` 字段**:SessionEntrySchema 加可选 `is_subagent: z.boolean().optional()`。
  z.object 默认 non-strict,老 entry 自动通过验证,无需 schema version bump
- **/list 过滤**:`doCardList` 加 `.filter(([_, e]) => e.is_subagent !== true)`,
  === true 才过滤(=== false / undefined 保留,跟 Agent View 的 `source !== 'spare'`
  模式对齐)

#### Why isSidechain, not roster
- `dispatch.source` 只在 `roster.json` 里跟踪活跃 bg worker,settled 后 roster
  可能就清掉了,没法用于历史 sessions
- `isSidechain` 是 claude 自己写到 JSONL 每个 user/assistant 条目的字段,
  Task tool 派生的 subagent 全部 `true`,顶层 session 始终 `false`/缺失。
  这是 claude 内部约定,**最可靠**
- 扫一次 JSONL 就够,不依赖外部状态

#### Tests
- +2 v0.4.1 case:有 / 无 `isSidechain:true` 条目时的 is_subagent 设置
- 720 pass / 0 fail

## [0.4.0] - 2026-06-08

### 飞书 Agent View — 完整稳定

0.3.4 之后这个 feature 几乎没法用,这一波 22 个 commit 把飞书端 Agent View
修到能稳定托管活跃/已结束 bg session。

#### Changed
- 飞书列表卡显示的 session 名称之前会被错填(JSONL 没内容时退化到 short hash,看着就是
  `d78c8339` 这种),现在一律展示原始 user prompt(`Print date every five seconds`)或
  parent session 派发的任务描述
- 飞书列表 / 详情 / Attach 按钮发出来的 sessionId 统一升级到 full UUID,SDK 调用不再被
  claude 拒(`Provided value ... is not a UUID`)
- 飞书活跃 session 列表新增 bg-conflict 预警:Attach 时如果探测到 daemon worker 仍在跑,会
  显式提示"直接发消息会被阻拦"
- 飞书侧 Agent View 整体与终端 TUI 行为对齐
- `bot.deps.replyFn` 在 daemon 启动时被正确同步到 AgentViewManager(之前是 stub,
  导致 Attach / Stop / Reply 卡回调全部静默失效)

#### Fixed
- **`bgJsonlHasConversation` 误判**:v2.2.12 早期版本对"bg session 是否有对话"做检测,
  但实际 post-stop resume 即使 JSONL 有内容也可能报 "No conversation found"
- **name-cache 污染**:snapshot-fetcher 的 name 缓存被错误条目污染后无法自我修复,
  v2.2.16/v2.2.17 让 JSONL 派生优先于缓存,污染条目下次 fetch 即覆盖
- **sessionId 短 hash bug**:旧 snapshot-fetcher 路径上,`sessionId` 字段可能存 8 字符
  short,导致 `claude -p --resume <short>` 失败,handleAttach 与 runChatSDK 都有
  short→full 兜底展开
- **bg worker 并发覆盖风险**:用户从飞书 Attach 到活跃 bg session 后发消息,
  bot 之前默默 swap 到 parent JSONL 继续跑,**filesystem 副作用不隔离**,
  bg worker 和飞书 SDK 同时改 cwd 文件会互相覆盖
- **拒绝卡 fire-and-forget**:`handleStopAndSend` 之前 `return await` 整个 stop+wait+SDK 链,
  飞书 card action callback 3s 超时 → 报"目标回调服务超时未响应",改为立刻 ack + 后台实际工作
- **handleAttach guard short↔full 兼容**:card 发 short、snapshot 存 full(或反之)
  的边界情况下不再误报"会话已不存在"
- **handleList live-guard 误伤**:之前在 bg worker 仍跑时,snapshot 会带上 worker
  持有的 session 同时也带上 daemon.log 中的 completed 副本,导致同 session 出现两次;
  activeShorts 去重 + readCompletedSessions merge 后列表干净
- **completed session 源推断**:`roster.workers[short]` 查不到时 fallback 读
  `~/.claude/daemon.log` 中的 `bg claimed-spare` 事件,补出 source(spare/slash/fleet),
  避免把 spare 子 agent 误展示
- **Peek raw 终端 buffer 渲染 tofu**:之前 Peek 把 `claude logs` 的屏幕 buffer
  塞 code-block,box-drawing 字符在飞书 monospace 字体里渲染成 □;v2.2.8 改读 JSONL
  倒序找最后一条 assistant 文本直接 markdown 渲染,与 TUI 视觉对齐
- **completed session name fallback**:v2.2.7 起,对没有 JSONL 内容、只有 metadata 的
  completed bg session 也能给出 user prompt 作为 name(从 `claude agents --json` 的
  `dispatch.seed.name` 派生)

#### Added
- **bg-conflict 拒绝卡**(`buildBgConflictCard`):飞书侧活跃 bg session 直接发消息时,
  bot 默认拒绝并发并弹卡询问 [🛑 停 bg 后继续发送] / [🌿 开新会话发送] / [❌ 取消],
  三个一键恢复路径,safe-by-default
- **stop-and-send parent fallback**:点 🛑 后,bot 跑 `claude stop <short>` 释放 worker,
  然后**总是 fallback 到 parent session**(从 `roster.launch.sessionId` pre-compute + stashed
  到 button value 避免 race)继续发消息,放弃继承 worker 内存里跑出来的增量
- **live bg worker 警示文案**:`handleAttach` 在 attach 到活跃 bg session 时追加
  "该 session 仍有 bg worker 在跑" 提示,让用户对接下来要发生的拒绝卡有预期
- **v2.2.16 起的 name-cache 自我修复**:`deriveNameFromJsonl` 总是从 JSONL 派生
  full UUID,即使缓存命中也会重新写回,污染条目下次 fetch 即覆盖
- **runChatSDK `bgConflictHooks` 注入点**:为测试方便把 roster / lookupResumeFromPath
  抽到 `_bgConflictHooks` mutable 对象,绕开 bun `mock.module` 跨文件不可撤销
- **runChatSDK `bg-conflict` 拒绝分支**:sessionUuid 在 roster.workers 中时
  short-circuit 拒绝 + 弹拒绝卡,不让 SDK 直发
- **Peek / Run 工具集**:`jsonl-peek.ts`(assistant 文本倒序扫描 + 段落截断)、
  `jsonl-name.ts`(first user prompt 提取 + name-cache)、
  `bg-conflict card`、`bg-conflict cancel` handler

#### Security
- 拒绝让用户从飞书直接接管活跃 bg worker 后立即发消息:这是这一波最关键的安全修复。
  之前 v2.2.10 silent swap-to-parent 看起来"work"但实际上让两个 claude 进程共享同一个
  cwd,改文件可能互相覆盖,导致工作丢失。这一波改"先弹卡让用户选"——安全 > 便利。

### Deployment
- 22 个 commit 从 `84192c2`(v0.3.4 部署)到 `fe82566`(v2.2.18 fire-and-forget)
- 全量测试 718 pass / 0 fail,`bun run typecheck` 干净
- 实际端到端实测:飞书侧 Attach / Peek / 拒绝卡 / 🛑 恢复 / 🌿 新会话 / 文本消息 6 个
  核心交互全部跑通,跟 TUI 视觉/行为对齐

### Known Limitations (deferred to 0.4.1+)
- interactive TUI sessions 在飞书侧**不展示**(`kind !== 'background'` 过滤掉);
  设计上仅托管 bg session,跟"看所有 session 历史"诉求冲突,等用户决策后做
- 空 JSONL 的 bg session(parent 派发后 worker 没用户输入,例如 print-date 一次性任务)
  仍显示 short hash 作为 name;要 fallback 到 parent JSONL 找原始 `/background` 命令文本
  需要 v2.2.18+ 的"parent 派生"逻辑
- Reply(等待中 bg session 输入):飞书 SDK 走 `claude -p --resume` 不能投递到活的
  worker(daemon IPC 不暴露),改路径需要 TUI `claude attach <short>`

## [0.3.4] - 2026-06-01
飞书 Agent View 早期接入(v0.3.0)的部分功能首次 ship:`/agents` 列表、`Peek`、基础
`Attach`、等待中 session 的 `Reply`。但很多边界没处理好,0.4.0 才开始真正可用。

[0.3.3] - 2026-05-31
[0.3.2] - 2026-05-31
[0.3.1] - 2026-05-31
[0.3.0] - 2026-05-29
[0.2.2] - 2026-05-29
[0.2.1] - 2026-05-24
[0.2.0] - 2026-05-24
[0.1.0] - 2026-05-24
[0.0.4] - 2026-05-24

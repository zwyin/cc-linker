# Changelog

All notable changes to cc-linker are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/), version numbers follow
[Semantic Versioning](https://semver.org/).

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

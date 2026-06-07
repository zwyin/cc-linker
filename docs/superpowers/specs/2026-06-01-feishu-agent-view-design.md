# cc-linker 飞书侧 Claude Code Agent View 支持设计

**日期：** 2026-06-06(v2 / v2.1 / v2.2 均为 2026-06-06 同日 review 迭代;v2.2.1 / v2.2.2 / v2.2.3 / v2.2.4 / v2.2.5 / v2.2.6 / v2.2.7 为 2026-06-07 hotfix)
**版本：** v2.2.7
**状态：** v2.2.7 已批准(JSONL 兜底真名)
**作者：** Claude Code

## 修订记录

| 版本 | 日期 | 关键变更 |
|---|---|---|
| v1 | 2026-06-01 | 初版,基于文档脑补(6 态、PR 字段、SDK 用法) |
| v2 | 2026-06-06 | 1) `claude agents --json` 真实输出核对:`status` 只有 `busy` / `idle` 两态(非 6 态);`kind` 字段 `background` / `interactive` 必须过滤<br>2) Reply 状态守卫改写为 `kind=background AND status=idle AND roster 实时复查` 三重条件<br>3) Peek 路径必须过 ANSI strip(spec 之前漏掉)<br>4) PR 编号从 G2 移除(JSON 无此字段,涉及 git+gh 网络调用)<br>5) Reply "等待输入" 卡新增 `[取消]` 按钮(不再只靠 `/cancel` 文本)<br>6) `[Stop]` 加二次确认(防止手机端误点)<br>7) expectedReply 状态持久化到 user-mapping.json(bot 重启可恢复)<br>8) 与 `/bridge` / `/switch` 交互明确:任何非 reply 文本命令自动清标记<br>9) G8(并发串行化) / G9(Activity Marker) 标记为"免费"——sendSDKMessage 已自带<br>10) 新增"daemon 未运行" 错误卡(区分"空 session"和"daemon 没跑")<br>11) 新增 R7 风险:同 openId 多飞书客户端并发 |
| v2.1 | 2026-06-06 | v2 self-review 后修订(P0 修复 + P1 选定):<br>1) **§3.2 状态机修内部矛盾** — busy 表行 "✅" → ✅ 二次确认;idle 表行 "❌(已停止)" → ❌ 按钮隐藏(不显示,不触发);删除"busy 是已停止的瞬态"那段自相矛盾的描述<br>2) **§5.3 reply 加 CAS token 机制** — handleReply / handleCancelReply 走 optimistic lock,避免 [取消] + 文本 race<br>3) **§5.3 reply 加 Step B 二次状态守卫** — 发文本那一刻再查 `claude agents --json`,busy 直接拒绝 + patch 卡<br>4) **§5.4 Stop 二次确认改独立新卡** — 不再 patch 列表卡(避免取消后列表丢失),改为发新确认卡<br>5) **§6.4 [Refresh] tag 拆 2 个** — `agent_view_refresh_list` / `agent_view_refresh_peek`;等待输入卡的 [Refresh] 删掉(没意义)<br>6) **§6.2 删假倒计时** — 飞书卡片 patch 有 throttle,"剩余 4:32"做不到实时,改为静态文案<br>7) **§5.3 expectedReply 持久化字段名明确** — `{ type: 'pending_agent_reply', shortId, sessionId, cwd, startedAt, timeoutMs }`,UserManager CAS 走 `proper-lockfile`<br>8) **§5.1 list cardMessageId 持久化字段名明确** — `{ type: 'last_agent_list_card', cardMessageId, updatedAt }`,与 expectedReply 并列<br>9) **§6.1 空状态卡 [💬 回到普通聊天] 补 handler** — 点后发文本消息"已退出 Agent View"<br>10) **§5.3 `/` 命令白名单** — `/help` `/status` `/whoami` 不清 expectedReply(只读);其他清<br>11) **§7 配置去掉 v1/v2 标注** — 整个 spec 是 v2.1,标注冗余;删 `reply_lock_timeout_ms` 复用 `runtime.session_lock_timeout_ms`<br>12) **§8/§9/§10/§11** — 错误表加 race / 二次守卫 / 列表被覆盖等新场景;R1 重写"已实测 idle resume 正常";test fixtures 加 kind-race;DoD 加新验收项 |
| v2.2 | 2026-06-06 | Final review 后系统性修正:<br>1) **§3.1 修正 `status` 字段** — 官方文档确认存在 `waiting` 态(带 `waitingFor`),原"只有 busy/idle"假设错误;类型定义、状态机、守卫条件全部修正<br>2) **§3.2 状态分组改为 3 组** — `busy`(处理中) / `waiting`(等待输入) / `idle`(已完成/空闲);Reply 只允许 `waiting`;Stop 只允许 `busy`<br>3) **§5.5 新增 Attach 操作** — 列表卡/Peek 卡增加 [Attach] 按钮,绕过 registry 直接 CAS 绑定 UserManager,复用现有消息路由<br>4) **§1 删除 PR 编号** — 与 N8 非目标矛盾<br>5) **§6.1/§6.2 `waitingFor` 透传** — Peek 卡/Reply 等待卡显示 `waitingFor`(如 `input needed` / `permission prompt`)<br>6) **§9 R1 补充 `waiting` resume 风险** — idle 实测正常,waiting 未实测<br>7) **§10/§11 增加 `waiting` 相关测试 fixture 和 DoD 验收项** |
| v2.2.1 | 2026-06-07 | 漏 session 修复(A+C):<br>1) **§3.1 增 `roster.json` 关联** — `AgentSession` 新增 `source: 'slash' \| 'spare' \| 'fleet' \| 'unknown'` 字段;snapshot-fetcher 在 parse 之后读 `~/.claude/daemon/roster.json`,通过 shortId(8 字符)匹配 worker,把 `dispatch.source` 注入 session<br>2) **§5.1 增 sub-agent 过滤** — `filterUserDispatched` 在 attachRosterSources 之后调用,丢弃 `source === 'spare'` 和 `source === 'fleet'` 的 session(对应 TUI 隐藏的 sub-agent);`source === 'unknown'` 保留(daemon 没跑时不能误清空,graceful degradation)<br>3) **§6.1 列表卡新增 tooltip** — 在 elements 头部插入一行 `ℹ️ 状态由 \`claude agents --json\` 提供,可能与终端 TUI 有数秒延迟`,解释为什么 status 偶尔滞后<br>4) 新增 `src/agent-view/roster-source.ts` 模块;`snapshot.ts` 新增 `attachRosterSources` / `filterUserDispatched`<br>5) 测试覆盖 16 个新 case(620 pass / 0 fail) |
| v2.2.2 | 2026-06-07 | fleet 误过滤修正:<br>1) **§3.1 / §5.1 修正 sub-agent 过滤规则** — v2.2.1 把 `source === 'fleet'` 一并过滤掉是错的;实测 TUI 也展示 fleet session(显示为 Completed,例如"timer command response" 这类已完成内部任务),Agent View 必须跟 TUI 对齐;`filterUserDispatched` 改为 `source !== 'spare'`,只过滤真正的 sub-agent,保留 `slash` / `fleet` / `unknown`<br>2) 注释同步更新;`AgentSessionSource` 类型 / `RosterDispatchSource` 类型 / 三种 source 的语义保持不变,仅谓词修改<br>3) 单元测试翻转(v2.2.1 描述块 → v2.2.2 描述块),新增 fleet 保留断言;集成测试 v2.2.1 用例 → v2.2.2 用例 |
| v2.2.3 | 2026-06-07 | Card action value dispatch 修复(AgentView 按钮全员"未知操作"):<br>1) **根因** — `src/cli/commands/start.ts:457-490` 在把 `card.action.trigger` 包成 `FeishuBotCardAction` 时,用 `ACTION_TYPES_WITH_OBJECT_VALUE` 白名单(只覆盖 `permission_approve` / `permission_deny` / `cli_force_send`)决定 `actionPayload` 是否传对象;Agent View 9 个 tag(`agent_view_peek` / `attach` / `stop` / `refresh_list` / ...)不在白名单,落到 else 分支被 stringify 成 `sessionId`,但 Agent View 按钮的 value 把标识放在 `value.shortId` / `value.tag`,顶层没有 `sessionId`,结果 `actionPayload` 变成 `''`<br>2) **链路后果** — `bot.handleCardAction` 收到 `value=''` 后 `valueObj` 为 null → `isAgentViewValue` 短路 false → switch 落到 default → "未知操作: agent_view_peek"<br>3) **修复** — `start.ts` 取消白名单,只要 `actionValue` 是对象就整对象往下传;`tag` 用 `value.type ?? value.tag ?? ''` 双 fallback 兼容 permission 与 Agent View 两种 schema<br>4) **bot.ts handleCardAction 联动** — 原来对 `switch` / `resume` / `select_dir` 用 `value as string` 取 sessionId,现在 value 是对象,改成 `valueObj ? valueObj.sessionId ?? valueObj.value ?? '' : (value as string)`,保留对老式 string-value 测试路径的兼容<br>5) **bot.ts 防御纵深** — `handleCardAction` 入口对 `typeof value === 'string' && value.startsWith('{')` 做一次 `JSON.parse` fallback + WARN 日志,捕获未来上游 regression<br>6) **测试** — 新增 `bot-cardaction-start-wiring.test.ts`(start.ts buildCardAction 行为契约 + e2e)+ `bot.test.ts` 增加 JSON.parse 防御纵深用例;630 pass / 0 fail |
| v2.2.4 | 2026-06-07 | Completed sessions 兜底显示(Option B):<br>1) **根因** — `claude agents --json` 只报 active 的 background sessions;一旦 session settled(完成),它就从 --json 输出消失;TUI 内部有 in-memory cache 能继续展示"Completed"组,Agent View 没有这个 cache,导致比 TUI 少行<br>2) **修复** — 新增 `src/agent-view/daemon-log-reader.ts` 解析 `~/.claude/daemon.log` 中的 `bg settled <short> (done\|killed)` 行(最近 24h);snapshot-fetcher 在 `--json` 之外,叠加 done sessions(过滤掉仍在 active 的 shortId,避免 race condition;过滤掉 `killed`,与 TUI "Completed" 区域对齐)<br>3) **name 拿取** — 对每个 done session 调 `claude logs <short>`(3s 超时)拿用户 prompt 首行作 name;失败时 graceful 用 short hash 兜底<br>4) **类型扩展** — `AgentSession` 新增可选 `completed: boolean` 字段,`AgentSessionGroup` 新增 `completed: AgentSession[]` 第四组(谓词:`status === 'idle' && completed === true`);`buildListCard` 渲染顺序 busy → waiting → idle → completed,新 section 标题"已完成 (N)"(区别于 idle 的"空闲")<br>5) **新 prefix** — completed session 的 `name` 加 `✅ ` 前缀,一望即知"这是 settled 的"而不是"active idle"<br>6) **测试** — 新增 `daemon-log-reader.test.ts`(7 case)+ `snapshot-fetcher.test.ts` 加 2 case(merge + skip killed)+ `card.test.ts` 加 2 case(新 section + 隔离于 idle)+ `snapshot.test.ts` 加 3 case(groupByStatus 新分支);644 pass / 0 fail |
| v2.2.5 | 2026-06-07 | Completed sessions 精确过滤 + name fallback:<br>1) **根因 A(spare 没被过滤)** — completed sessions 已不在 `roster.json` 里(daemon 把 settled 的 worker 已清掉),所以 `attachRosterSources` 给它们打的 source 都是 `'unknown'`;`filterUserDispatched` 的谓词是 `source !== 'spare'`,unknown 一律放行 → completed 的 spare(子 agent)被错误展示出来,跟 TUI 不一致<br>2) **根因 B(name 全是 short hash)** — `claude logs <short>` 对 settled session 会直接报 `No job matching '<short>'`(daemon 已清 worker),v2.2.4 的 fallback 把 short hash 当 name,UI 显示"✅ 273a5566"这种,完全不知道这条会话在干嘛<br>3) **修复 A** — `daemon-log-reader.ts` 增 `readClaimedSources(withinHours=24)`,解析 `~/.claude/daemon.log` 中 `bg claimed-spare <short> (spare\|slash\|fleet)` 行,返回 `Map<short, AgentSessionSource>`(同 short 多次 reclaim 取最新);`enrichCompletedSessions` 的 source 决策改成三级优先级:**roster(仍在飞)→ daemon.log claimed 事件 → 'unknown'**;`snapshot-fetcher.fetch` 把 `filterUserDispatched` 调用从"merge 之前"挪到"merge 之后",这样从 daemon.log 推断到 `source='spare'` 的 completed session 也会被正确丢掉<br>4) **修复 B** — `enrichCompletedSessions` 的 name fallback 从"裸 short hash"改成 `<short> (logs unavailable)`,UI 仍然显示 short hash 用于 debug,同时明确告诉用户"为什么没有 name(logs 拿不到)"<br>5) **`claude logs` 仍工作时不退化** — 只在 `execFileP` 抛错(timeout / "No job matching")时才走 fallback;短时间被 re-dispatch 的 session 仍能正常拿到 prompt 首行<br>6) **测试** — `daemon-log-reader.test.ts` 加 6 case(readClaimedSources:空 / 三种 source 解析 / cutoff / last-wins / 忽略非 claimed-spare 行)+ `snapshot-fetcher.test.ts` 加 3 case(completed spare 被过滤、name fallback 文案、daemon.log source 兜底);652 pass / 0 fail |
| v2.2.6 | 2026-06-07 | name-cache 接管 completed name 显示:<br>1) **根因** — v2.2.5 的 `<short> (logs unavailable)` 文案几乎 100% 命中(daemon 一 settle 立刻清 worker,`claude logs` 必失败),反而成了 UI 噪音 —— 用户看到的还是一排 hash,只是多了个无用后缀;唯一权威的 name 来源是 `roster.json[short].dispatch.seed.name`,但 session 一 settled 就被清掉,事后无法回查<br>2) **修复** — 新增 `src/agent-view/name-cache.ts`,把 active `claude agents --json` 看到的 `{shortId → name}` 持久化到 `~/.cc-linker/agent-names-cache.json`(TTL 48h,>48h 自动 prune,atomic write 走 `.tmp + rename`);`snapshot-fetcher.fetch` 在每次 parse 完 active sessions 后调 `captureNames(sessions)` 写入<br>3) **enrich 走 cache 兜底** — `enrichCompletedSessions` 的 name 解析改成 `cache hit → claude logs → short hash` 三级优先级;cache 命中直接 short-circuit `claude logs` 调用,settled 后 UI 直接显示 "✅ timer command response" 而非 hash;`(logs unavailable)` 后缀彻底移除<br>4) **不为缓存而缓存** — `name === 'unnamed'`(parseAgentsJson 的兜底值)显式 skip,避免覆盖真名;cache 文件落在 `~/.cc-linker/` 而非 `~/.claude/`,与 cc-linker 自身状态合并管理<br>5) **测试解耦设计** — `snapshot-fetcher.ts` 暴露 `_nameCacheHooks = { captureNames, lookupName }` 普通对象,绕开 bun `mock.module` 跨文件不可撤销的已知限制;测试 swap 字段就能拦截,不污染 `name-cache.test.ts`<br>6) **测试** — 新增 `name-cache.test.ts`(8 case:capture/overwrite/skip-unnamed/prune-48h/no-op-empty/lookup-hit-miss-corrupt)+ `snapshot-fetcher.test.ts` 更新 1 case(去 `(logs unavailable)` 后缀)+ 新增 2 case(cache-hit 短路 / captureNames 被调用)；662 pass / 0 fail |
| v2.2.7 | 2026-06-07 | JSONL 兜底真名(覆盖 bot 部署前就 settled 的 session):<br>1) **根因** — v2.2.6 部署后实测发现:bot 启动**之前**就 settled 的 session 没机会进 name-cache(active 期没被 observe),仍然显示 `✅ 3a41fe73` 这种短 hash;`claude logs <short>` 这条 v2.2.4 老兜底对 settled session **100% 失败**(daemon 清 worker),只贡献 3s timeout 没成功案例,纯属死代码<br>2) **新数据源** — `~/.claude/projects/<encoded-cwd>/<full-UUID>.jsonl` 是用户原始 prompt 的唯一稳定本地来源(实测 3a41fe73 文件 L8 = `你的当前模型是？`,098639ad 文件 L7 = `sleep 30 && echo done`);用户机器实测 393 个 JSONL,`readdirSync` 两层扫 ~10ms<br>3) **修复** — 新增 `src/agent-view/jsonl-name.ts`:`JsonlIndex`(lazy build `Map<short8, fullPath[]>`,用所有 .jsonl 的 max mtime 做 invalidation,多 short 命中取最新 mtime)+ `extractFirstUserPrompt`(line-by-line 扫,过滤 `isMeta` / `attachment` / `tool_result` block / command output / 短回复 + 黑名单 `继续`/`continue`/`ok` 等 / 长度 <3)+ `deriveNameFromJsonl` 组合两者并 normalize 到 60 字符单行<br>4) **enrich 解析链改造** — `enrichCompletedSessions` 改成 `cache → JSONL → short hash` 三级;**整段移除 v2.2.4 的 `claude logs` 子句**(dynamic import / promisify / 3s timeout 全删);JSONL 命中后 sessionId 升级为 full UUID 并立刻 `captureNames` 写回 cache,下次同一 short 走 hot path<br>5) **现有 helper 复用** — `isCommandOutput` 从 `src/utils/jsonl-repair.ts:28` 改 export(单字 export,无 API 变更);`CLAUDE_PROJECTS_DIR` / `AGENT_NAMES_CACHE_PATH` 路径常量复用;`_nameCacheHooks` 测试模式扩展第三字段 `deriveNameFromJsonl`<br>6) **大文件保护** — JSONL > 1MB 走 `openSync` + `readSync` 头部 64KB(第一条 user message 几乎永远在文件头);< 1MB 直接 `readFileSync`<br>7) **测试** — 新增 `jsonl-name.test.ts`(19 case:extract 9 case 覆盖各种 entry 形态/过滤路径;JsonlIndex 5 case 含碰撞与重建;derive 4 case 含截断)+ `snapshot-fetcher.test.ts` 加 2 v2.2.7 case(JSONL 命中并写回 / `claude logs` tripwire 不被调用)+ 更新 3 个老 case(去掉 `claude logs` mock,cache 短路断言扩展到 JSONL 也不调);683 pass / 0 fail |

## 1. 问题陈述

Claude Code 在 v2.1.139+ 引入 `claude agents` 命令,提供「Agent View」——一个全屏 TUI 仪表板,统一管理多个并行运行的后台 Claude Code 会话(后文简称 *background session*)。用户可以在一屏内看到所有 background session 的状态、当前活动、并能 Peek 最近输出、Reply 输入新消息、Stop 终止会话。

> **v2.1 注**:Claude Code 当前不暴露 PR / 进度字段给 `claude agents --json`,本方案不展示 PR(详见 §3.1)。

目前 cc-linker 在飞书侧只支持**单会话**交互(一个飞书用户 ↔ 一个 active session),无法让用户在手机端管理 background session。本设计让 cc-linker 把 Agent View 能力桥接到飞书侧,用户可以在飞书里:

1. 列出所有 background session(状态分组、目录、耗时)
2. Peek 任意 session 的最近输出
3. Reply 给指定 session(通过 SDK resume 注入消息)
4. Stop 正在运行的 session
5. Attach 到指定 session(将后续消息直接注入该 session)

不引入:派发新会话、删除会话、Worktree 管理、Filter/Pin/Rename 等 TUI-only 操作。详细范围见 §2。

## 2. 目标与非目标

### 2.1 目标(本版必须支持)

| # | 目标 | 优先级 |
|---|------|--------|
| G1 | 飞书 `/agents` 命令列出所有 `kind: "background"` session,按状态分组(`busy` / `waiting` / `idle`) | P0 |
| G2 | 列表显示名称、状态、耗时、cwd 摘要(PR 编号本版不显示,见 N8) | P0 |
| G3 | 列表卡 [Refresh] 按钮即时重拉 | P0 |
| G4 | [Peek] 抓取 `claude logs <id>` 最近 N 行,过 ANSI strip,渲染 peek 卡 | P0 |
| G5 | [Reply] 在 `status: "waiting"` + `kind: "background"` + daemon roster 实时复查 三重条件通过时可发起 reply,流式输出 | P0 |
| G6 | [Reply] 在 `status: "busy"` / `status: "idle"` / `kind: "interactive"` / session 已不在 roster 时被守卫拒绝 | P0 |
| G7 | [Stop] 调用 `claude stop <id>`,完成后自动刷新列表 | P0 |
| G8 | 同 session 的并发 reply 走 `sessionLocks` 串行化 | P0 |
| G9 | Activity Marker 写入(复用 session-activity-sync 设计) | P1 |
| G10 | Claude 版本 < 2.1.139 时降级提示 | P0 |
| G11 | 卡片 body 不超 25KB(沿用 `stream.max_card_bytes` 默认值,见 §7),触顶走文本 fallback | P0 |
| G12 | 单测 + 集成测试 + 手动验收 | P0 |
| G13 | [Attach] 将 background session 绑定为当前活跃 session,后续普通消息直接注入 | P0 |

### 2.2 非目标(本版不做)

| # | 不做 | 原因 |
|---|------|------|
| N1 | 派发新 background session(`claude --bg`) | 用户在终端更直接;UI 复杂度高 |
| N2 | 删除 session(`claude rm`) | 双确认交互在 IM 难做;破坏性操作 |
| N3 | Worktree 路径展示 / 清理 | 状态已经够,操作交给 CLI |
| N4 | Filter `a:<name>` / `s:<state>` / `#<PR>` | 分组已覆盖常见需求 |
| N5 | Pin / Rename | TUI-only 心智模型 |
| N6 | 「当前活动」AI 摘要(Haiku 生成的那行) | 需读 `state.json`,本版不读 |
| N7 | 列表排序(Shift+↑↓) | 状态分组已足够 |
| N8 | PR 编号显示(推迟到下个版本) | `claude agents --json` 无 PR 字段,需 git+gh 网络调用,本版不做 |
| N9 | Subagent 单独列 | Agent View 本身不把 subagent 列为独立行 |
| N10 | 跨 cc-linker 实例同步 | 单机场景 |
| N11 | 多飞书用户隔离 | 假设单用户部署(`feishu_bot.owner_open_id` 白名单),但同 openId 多端并发 R7 仍需处理 |
| N12 | 派发 `!` shell 命令 | 派发不在本版范围 |

### 2.3 飞书 ↔ 终端并发 reply

本版不解决,但 spec 需诚实标注:R6 风险。详见 §9。

**关键设计选择(v2.2 明确)**:`expectedReply` 状态是 per-`openId`,**不区分飞书客户端实例**(同 openId 下手机 + PC 共用一份状态)。后果:
- 同一 openId 多端中,先点 [Reply] 的客户端"占住"expectedReply 状态
- 另一端再点 [Reply] 被 CAS 拒绝(§5.3),提示用户去对方客户端取消
- 多端 UI 不会实时同步(下版本候选,见 R7)

## 3. 背景:Claude Code Agent View

参考 https://code.claude.com/docs/en/agent-view。

### 3.1 真实接口验证(2026-06-06 实地抓取)

以下是对照本地 Claude Code 2.1.163 实测的接口事实,**与 v1 文档假设多处不符,以本节为准**(v2.1 保留作为修订历史):

**进程模型**
- 载体:`claude agents` 命令,需要在终端 v2.1.139+ 运行
- 后端:每个 background session 由 `claude daemon` supervisor 进程托管,会话状态存于 `~/.claude/jobs/<id>/state.json`,运行列表存于 `~/.claude/daemon/roster.json`,supervisor 日志在 `~/.claude/daemon.log`

**`claude agents --json` 实际输出**(实跑 2.1.163):
```json
[
  {
    "pid": 33348,
    "cwd": "/Users/wuyujun/Git/cc-linker",
    "kind": "background",
    "startedAt": 1780728421046,
    "sessionId": "92664deb-f4b6-48d3-9cdd-85cf8eea6dfc",
    "name": "Design cross-model AI review tool",
    "status": "idle"
  },
  {
    "pid": 95189,
    "cwd": "/Users/wuyujun/Git/cc-linker",
    "kind": "interactive",
    "startedAt": 1780680484539,
    "sessionId": "e1d757b1-4480-4f54-a69d-823b9c83a6bf",
    "status": "busy"
  }
]
```

> **v2.2 修正**: 官方文档明确 `status` 还可能为 `"waiting"`（含 `waitingFor` 字段），见下方说明。

**JSON 字段定义(实测 7 个基础字段 + `waitingFor`)**
| 字段 | 类型 | 含义 |
|---|---|---|
| `pid` | number | supervisor 拉起的子进程 OS PID |
| `cwd` | string | session 启动时的工作目录 |
| `kind` | `"background"` \| `"interactive"` | 派发方式,见 §3.2 |
| `startedAt` | number(epoch ms) | 启动时间戳 |
| `sessionId` | string(UUID) | Claude 会话 ID,**可直接作为 `query({ resume })` 的 key** |
| `name` | string | 用户派发时给的名字(`claude --bg "..."` 第一行) |
| `status` | `"busy"` \| `"idle"` \| `"waiting"` | 当前活动状态,见 §3.2 |
| `waitingFor` | string(可选) | 仅当 `status === "waiting"` 时存在,如 `input needed` / `permission prompt` |

**`status` 有 3 个值**(v2.1 之前误以为只有 2 个)
- `busy`:Claude 正在执行(工具调用、思考、生成文本中)
- `waiting`:Claude **被阻塞**,等待用户输入或权限确认(官方文档明确存在,含 `waitingFor`)
- `idle`:Claude 已停止,无事可做(包含已完成、已失败、已停止、真正空闲等终端态)
- **TUI 的 6 态**(Working / Needs input / Idle / Completed / Failed / Stopped)是界面分组,不直接对应 JSON 的 `status` 字段

**`kind` 字段是 v1 完全漏掉的关键过滤器**
- `background`:`claude --bg "<prompt>"` 派发,可以在 Agent View 看到
- `interactive`:用户在终端 `claude` 启动的主会话,**不应出现在 Agent View**
- 不加 `kind` 过滤会导致 /agents 把用户所有主会话也列出来

**v2.2.1 增补:roster.json 关联 + sub-agent 过滤(v2.2.2 修正 fleet 谓词)**

`claude agents --json` 的输出无法区分"用户派发" vs "sub-agent",但 `~/.claude/daemon/roster.json` 里的 `dispatch.source` 字段有明确答案:

| `dispatch.source` | 含义 | TUI 显示 | 飞书 Agent View |
|---|---|---|---|
| `slash` | 用户派发(`claude --bg` 或 TUI `/agents`) | 显示 | **显示** |
| `spare` | sub-agent(被另一个 session 派发) | 隐藏 | **过滤掉** |
| `fleet` | daemon 内部任务 | 显示为 "Completed" | **显示**(v2.2.2 修正) |
| (无 roster 记录) | daemon 没跑 / session 不在 roster 中 | — | 保留(graceful) |

实现细节:每个 worker 的 `workers[shortId].dispatch.source` 会被压成 `Map<shortId, source>`,`attachRosterSources` 用 sessionId 前 8 字符查这个 Map 给 session 打 `source` 标签;`filterUserDispatched` 在它之后跑,丢弃 `source === 'spare'`(只过滤真正的 sub-agent),保留 `slash` / `fleet` / `unknown`。spec §5.1 详细步骤。

**管理命令(实跑 2.1.163)**
```
$ claude logs --help
Usage: claude logs <id>
  Print the background session's recent terminal output.

$ claude stop --help
Usage: claude stop <id>
  Stop a background session. Its conversation is kept; resume it later with `claude attach <id>`.

$ claude attach --help
Usage: claude attach <id>
  Open the background session in this terminal. Detach with Ctrl+Z; the session keeps running.
```

**关键限制**(实测确认)
- `id` 参数接受 short hash(如 `92664deb`)或完整 sessionId(实测两种都接受)
- `claude logs <id>` 输出含 **ANSI 转义码**(CSI 序列 + 颜色码),飞书 markdown 渲染会乱,**必须过 ANSI strip**
- background session 与 supervisor 私有 IPC 通信,公开 API 只暴露 `attach` (TTY 抢断) 和 `logs` (只读),没有"远程 reply" 通道
- `claude agents --json` 不返回 PR / 描述 / 进度 / 子 agent 等元信息

### 3.2 状态机

`status` 有 3 个值,对应飞书侧 3 个分组:

| 状态 | 含义 | 允许 [Reply] | 允许 [Stop] | 允许 [Attach] | 说明 |
|---|---|---|---|---|---|
| `busy` | Claude 正在执行(工具调用 / 思考 / 生成) | ❌ 守卫拒绝 | ✅ 二次确认后 | ✅ | busy 时 stop 会杀掉正在跑的长任务,需要二次确认 |
| `waiting` | Claude **被阻塞**,等待输入或权限(`waitingFor` 说明具体等什么) | ✅ | ❌ 按钮隐藏 | ✅ | 这是真正"需要输入"的状态;`waitingFor` 透传给用户 |
| `idle` | Claude 已停止,无事可做(含已完成/已失败/已停止/真正空闲) | ❌ 按钮隐藏 | ❌ 按钮隐藏 | ✅ | idle 不是"等待输入",不要再混淆;Stop 无意义 |

**实现要点**:
- **Reply 只允许 `waiting`**:`idle` 不是"需要输入",`busy` 正在执行不能插嘴(§5.3 三重条件)
- **Stop 只允许 `busy`**:waiting/idle 状态 Stop 无意义;按钮**不显示**(不是渲染了禁用)
- **Attach 所有状态都允许**:终端里 completed/failed/stopped 也能 `claude attach`
- §5.4 二次确认只对 `currentStatus === "busy"` 生效;waiting/idle 是死分支(代码不写)

**状态转换关系**:
```
        ┌─────────────┐
        ▼             │
      busy  ──────► waiting  ◄── 用户 reply / 解除阻塞
        │    完成      │  需要输入
        │             │
        └─────► idle ◄─┘  停止/完成/失败
```

**关于 v2.1 "idle = 等待输入"的修正**:
- v2.1 错误地把 `idle` 解释为"等待新输入"(等价于 needs input)
- **v2.2 正确理解**:官方文档确认 `waiting` 才是"needs input"状态;`idle` 是终端态(已完成/失败/停止/空闲)
- 实测 2.1.163 时可能恰好没遇到 `waiting` 状态的 session,导致抽样偏差

## 4. 架构设计

### 4.1 数据流总览

```
┌─────────────────────────────────────────────────────────────┐
│  Feishu 飞书用户              cc-linker daemon              │
│                                                              │
│  /agents  ──►  bot.handleCommand()                           │
│                       │                                      │
│                       ▼                                      │
│             AgentViewManager.handleList()                    │
│                  │        │                                 │
│        ┌─────────┘        └────────┐                        │
│        ▼                          ▼                        │
│  VersionGuard              AgentSnapshotFetcher                │
│  (claude --version          (poll `claude agents --json`     │
│   ≥ 2.1.139?)                on demand / Refresh)            │
│        │                          │                        │
│        ▼                          ▼                        │
│  ┌──────────────────────────────────────┐                  │
│  │  Snapshot cache (last JSON result)    │  ← 过滤 kind=bg │
│  └──────────────────────────────────────┘                  │
│        │                                                    │
│        ▼                                                    │
│  AgentListCard  ──create──►  Feishu                         │
│       │                                                     │
│       └──[Refresh]──► handleList (再 patch 同一卡片)         │
│                                                              │
│  [Peek]   ──►  handlePeek() ──► claude logs <id>            │
│                                    │                        │
│                                    ▼                        │
│                              ansi-strip  ─► PeekCard        │
│                                                              │
│  [Reply]  ──►  handleReplyRequest()                         │
│       │  (设置 expectedReply 持久化标记)                     │
│       ▼                                                     │
│  handleReply()  ──►  sendSDKMessage(sessionId, ...)         │
│       │                  │                                 │
│       │                  ├─ activity marker: 自动(已实现)    │
│       │                  ├─ session lock: 自动(已实现)       │
│       │                  └─ 流式回调: 复用 CardUpdater       │
│       ▼                                                     │
│  流式卡(独立新消息)                                           │
│                                                              │
│  [Attach] ──►  handleAttach() ──► CAS 更新 UserManager       │
│       │         (清 expectedReply)                          │
│       │                  │                                 │
│       │                  └─ 绑定 sessionUuid + cwd          │
│       ▼                                                     │
│  发确认文本(后续消息走 resolveChatTarget → sendSDKMessage)   │
│                                                              │
│  [Stop]   ──►  handleStop() ──► claude stop <id>            │
│                          │                                  │
│                          └─ busy 时: 二次确认卡 → 才执行     │
│                                                              │
│  [取消]   ──►  handleCancel() ──► 清 expectedReply + patch  │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 模块切分

新增 `src/agent-view/` 目录,与 `src/feishu/`、`src/registry/` 平级:

| 文件 | 职责 |
|------|------|
| `index.ts` | 公共类型导出 |
| `manager.ts` | `AgentViewManager` 顶层协调,被 `FeishuBot` 调用 |
| `snapshot.ts` | **纯解析**:`parseAgentsJson(raw: string): AgentSession[]`,定义 `AgentSession` / `AgentSessionStatus` / `AgentSessionGroup` 类型,做 `kind: "background"` 过滤、状态分组、unknown status 兜底;**不**调 execFile |
| `snapshot-fetcher.ts` | `AgentSnapshotFetcher` 按需执行 `claude agents --json`(本版不做后台轮询,只 Refresh 触发;v2.2 改名,原 `BackgroundPoller` 命名误导);内部调 `snapshot.parseAgentsJson` 把 raw string 转成 `AgentSession[]` |
| `version-guard.ts` | **v2.2 新增(原 §4.2 没说清位置)**:`VersionGuard.check()` 通过 `claude --version` 校验 ≥ 2.1.139,与 `snapshot-fetcher.ts` 平级(不嵌进 snapshot.ts,因版本检查不依赖 JSON 解析) |
| `daemon-probe.ts` | **v2.2 新增**:`DaemonProbe.check()` 通过 `existsSync('~/.claude/daemon/roster.json')` 判定 daemon 是否在跑,与 `snapshot-fetcher.ts` 平级 |
| `ansi-strip.ts` | **新增**:`claude logs` 输出含 ANSI 转义码,必须 strip 后再渲染飞书卡片 |
| `card.ts` | **静态卡构建**——列表卡 / peek 卡 / 错误卡 / 空状态卡 / 等待输入卡 / 停止确认卡。**reply 流式卡复用 `src/feishu/card-updater.ts`,不在此文件** |
| `action.ts` | 飞书 `card.action.trigger` 回调路由,处理 9 种 action(v2.2 增加 `attach`) |
| `expected-reply-state.ts` | **新增**:`openId → expectedReply 状态`,持久化到 `user-mapping.json` 共用 CAS,bot 重启可恢复 |
| `mapping-ext.ts` | **新增**:扩展 `src/feishu/mapping.ts` 的 `MappingEntryType` 联合类型和 `MappingEntry` 接口,新增 2 种 type(v2.2 必做,见下文) |

**为什么用 `user-mapping.json` 而不是新建独立文件**(v2.2 补):
- expectedReply 状态跟其他 user-level 状态(当前活跃 session、pending_new_session 等)共享 `UserManager` 入口,`compareAndSwap` 已经走 `proper-lockfile` 跨进程锁,避免引入第二套并发原语
- 跟 `ListSnapshotManager`(独立 `~/.cc-linker/list_snapshot.json`)模式不同,但 ListSnapshotManager 存的是"registry 索引快照"(供"恢复 2"用),**不是同类数据**;Agent View 存的是"飞书卡片 messageId"和"等待输入状态",**不能复用**
- 唯一关联:列表卡 `last_agent_list_card.cardMessageId` 跟 expectedReply 互斥(同一 openId 同一时刻只可能是其中一种 entry,见 §5.1),互斥通过 `UserManager.compareAndSwap` 的 type 比较自动保证

**复用现有基础设施**(避免重写,见 §9 R1 风险讨论):
- 流式卡片 → `CardUpdater`(`src/feishu/card-updater.ts`),不重写
- 权限确认 → `CardUpdater.createPermissionCard()`,reply 中如需权限确认走原流程
- session lock → `ClaudeSessionManager.acquireSessionLock()`,reply 不重写
- activity marker → `writeActivityMarker()`(sendSDKMessage 内部已调),reply 不重写
- 命令分发:**两个入口**(v2.2 明确,容易遗漏)
  - **文本命令 `/agents`** → `bot.handleCommand()`(`src/feishu/bot.ts:738-787`)的 switch 加 `case 'agents': await agentView.handleList(openId, msg.messageId)`,调用方传 `msg.messageId` 走 spool 关闭路径
  - **卡片 action** → `bot.handleCardAction()`(`src/feishu/bot.ts:438-525`)的 switch 加 9 个 `case`(v2.2:attach + refresh 拆 2 + peek + reply_request + cancel_reply + stop + stop_confirm + back_to_chat)
- **patch 现有卡片** → 直接用 `this.feishuClient.im.v1.message.patch`(`src/cli/commands/start.ts:340-372` 现有 `cardReplyFn` **只支持 create**,Refresh 走 patch 必须新加路径)
- **新外部命令**(v2.2 明确,**不是**复用现有):
  - `claude agents --json` — 通过 `execFile` 调用,5 秒超时,parse 失败兜底
  - `claude logs <shortId>` — 通过 `execFile` 调用,3 秒超时,输出经 ANSI strip
  - `claude stop <shortId>` — 通过 `execFile` 调用,5 秒超时(实跑确认 supervisor 收尾时间);**与现有 `FeishuBot.doStop` 不冲突**(后者只清 cc-linker 自己的进程)
  - `claude --version` — 简单 `execFileSync`,版本守卫用
  - 全部走 `Bun.spawn` / `node:child_process.execFile`,不引入新依赖

## 5. 各操作数据流

### 5.1 列表(`/agents`)

```
bot.handleCommand('agents', openId)
   ↓
AgentViewManager.handleList(openId, cardMessageId?)
   ↓
1. VersionGuard.check()  →  < 2.1.139? 错误卡 return
   ↓
2. DaemonProbe.check()  →  ~/.claude/daemon/roster.json 存在?
   ├─ 不存在 → "daemon 未运行" 错误卡 return(不与"空 session" 混淆)
   └─ 存在 ↓
   ↓
3. SnapshotFetcher.fetch() → exec `claude agents --json` 解析为 AgentSession[]
   ↓
4. snapshot.filter(kind === "background")  // 关键过滤:不漏掉 kind=interactive
   ↓
5. (v2.2.1, v2.2.2 修正过滤谓词) SnapshotFetcher 内部读 `~/.claude/daemon/roster.json` → `attachRosterSources` 给每个 session 打 `source` 标签 → `filterUserDispatched` 丢弃 `source === 'spare'` 的 session(只过滤真正的 sub-agent);`slash` / `fleet` / `unknown` 都保留(`fleet` 修正见 v2.2.2;TUI 也展示 fleet,Agent View 必须跟 TUI 对齐;`unknown` 保留是 daemon 没跑时不能误清空,graceful degradation)
   ↓
6. groupByStatus(snapshot) → { busy: AgentSession[], waiting: AgentSession[], idle: AgentSession[] }
   ↓
7. CardBuilder.buildListCard(groups) → 飞书列表卡 JSON
   ↓
   (v2.2.1) 列表卡头部插入 tooltip:`ℹ️ 状态由 \`claude agents --json\` 提供,可能与终端 TUI 有数秒延迟`
   ↓
8. client.im.v1.message.{create | patch}(...) 发送(v2.2 明确 patch 路径)
   ├─ cardMessageId 未传 → `this.feishuClient.im.v1.message.create` 发新卡
   │   原因:现有 `cardReplyFn`(`src/cli/commands/start.ts:340-372`)只支持 create
   └─ cardMessageId 传(用户点了 [Refresh])→ `this.feishuClient.im.v1.message.patch`
       payload: { message_id, content: JSON.stringify(card) }
       失败回退(飞书归档/超过 24h patch 窗口)→ 发新列表卡覆盖原 cardMessageId 记录
   ↓
9. 保存 cardMessageId 到 user-mapping.json(v2.1 明确字段名,两个独立 entry):
   ```
   // Entry 1: expectedReply 状态(与 §5.3 Step A 共享)
   { type: 'pending_agent_reply', shortId, sessionId, cwd, startedAt, timeoutMs }

   // Entry 2: 最新列表卡(独立 entry,v2.1 新增,用于 Refresh patch 定位)
   { type: 'last_agent_list_card', cardMessageId, updatedAt }
   ```
   - 同一 openId 下,两种 entry **互斥**:`pending_agent_reply` 表示用户正在等 reply 输入,此时不应该有 `last_agent_list_card`(列表卡 patch 后被"等待输入"卡覆盖)
   - 列表卡创建时写 entry 2,patch / Refresh 时读 entry 2 定位 cardMessageId
   - **文件锁**:读写 user-mapping.json 走 `proper-lockfile`(`src/utils/lock.ts` 已实现),避免多 client / 异步操作并发写入损文件
```

**M1. MappingEntry 扩展定义(v2.2 必做,实现时第一件事)**

`src/feishu/mapping.ts:8` 的 `MappingEntryType` 当前是 3 种:
```typescript
export type MappingEntryType = 'session' | 'pending_new_session' | 'pending_new_session_claimed';
```

需要扩展为 5 种:
```typescript
export type MappingEntryType =
  | 'session'                     // 已有
  | 'pending_new_session'         // 已有
  | 'pending_new_session_claimed' // 已有
  | 'pending_agent_reply'         // 新增 — Agent View reply 等待输入
  | 'last_agent_list_card';       // 新增 — Agent View 最新列表卡
```

`MappingEntry` 接口(`src/feishu/mapping.ts:10-20`)扩展字段:
```typescript
export interface MappingEntry {
  type: MappingEntryType;
  sessionUuid: string | null;
  createdAt: string;
  casToken?: string;
  cwd?: string;
  lastActiveAt?: string;
  claimedByMessageId?: string;
  claimedAt?: string;
  defaultProvider?: string;
  // ===== Agent View 新增字段 =====
  shortId?: string;          // pending_agent_reply:background session short hash
  startedAt?: string;        // pending_agent_reply:ISO 启动时间
  timeoutMs?: number;        // pending_agent_reply:超时毫秒
  cardMessageId?: string;    // last_agent_list_card:飞书卡片 message_id
  updatedAt?: string;        // last_agent_list_card:ISO 更新时间
}
```

**关键不变量**:
- `pending_agent_reply` 必有:`shortId, sessionId(=sessionUuid), cwd, startedAt, timeoutMs, casToken`
- `last_agent_list_card` 必有:`cardMessageId, updatedAt, casToken`;`sessionUuid` 必为 `null`
- `entriesMatch`(`src/feishu/mapping.ts:299-319`)对两种新 type 行为:
  - `pending_agent_reply`: 比较 `type / sessionUuid / cwd / casToken`(短 ID / startedAt / timeoutMs 不参与 CAS,只用于 UI)
  - `last_agent_list_card`: 比较 `type / sessionUuid(=null) / cwd(=null) / casToken`
- 不需要 `claimedByMessageId` 字段(不是 claim 流程),`entriesMatch` 不会误命中
- **v2.2 不动 `pending_new_session` / `pending_new_session_claimed` 路径**,避免回归

**M2. 5 种 type 互斥整体说明(v2.2 必读,易遗漏)**

`user-mapping.json` 的 schema 是 `entries: Record<openId, MappingEntry>`,**一个 openId 同一时刻只对应一种 MappingEntry**(因为 Record 是 map 结构,一个 key 只能存一个 value)。扩展到 5 种 type 后:

| 5 种 type | 触发场景 | 同一 openId 互斥? |
|---|---|---|
| `session` | /new /bridge 完成 / Attach 绑定 background | 跟下面 4 种全部互斥 |
| `pending_new_session` | /new 等待下一条消息 | 跟下面 4 种全部互斥 |
| `pending_new_session_claimed` | /new 消息已入队,SDK 启动中 | 跟下面 4 种全部互斥 |
| `pending_agent_reply` | Agent View 点 [Reply] 等待文本 | 跟上面 3 种 + 下面 1 种互斥 |
| `last_agent_list_card` | Agent View 列表卡 patch 定位 | 跟上面 4 种互斥 |

**互斥由 `UserManager.compareAndSwap` 的 `type` 比较自动保证**(`entriesMatch` 比较 type,见 §5.1 M1):
- 从 `pending_agent_reply` CAS 写 `last_agent_list_card` → type 不等 → 失败
- 从 `session` CAS 写 `pending_agent_reply` → type 不等 → 失败
- 同 type 的 entry 互转(如同 type 'session' 改 `sessionUuid`)→ type 相等 + casToken 校验 → 由调用方逻辑保证

**所有写 user-mapping 的操作**(`/new`、`/bridge`、Attach、Agent View reply、Agent View list、Agent View refresh 等)**都通过 `UserManager.compareAndSwap` 串行化**,不会出现"一个 openId 同时有两种 type"。

**测试覆盖**(`tests/agent-view/mapping-ext.test.ts`):
- 同 openId 连续 CAS 写不同 type,只最后一个 type 生效,前一个 entry 完全消失
- 旧 type 写新 type:spread 旧 entry 改 type 必然 CAS 失败(应分两步:先 null 再 newType)
- bot 重启后遍历 user-mapping.entries,5 种 type 的 entry 数量统计正确

**轮询策略**:**不**做后台推送。`/agents` 首次拉一次,后续 [Refresh] 按钮拉。考虑未来加"打开期间每 30s 自动 patch",但本版不做。

**为什么持久化 cardMessageId 到 user-mapping.json**:bot 重启时还能定位"用户的列表卡",避免在飞书消息流里出现"孤卡"(其他用户看不见的卡)。R7 同 openId 多端时,两端都能 patch 同一卡。

### 5.2 Peek

```
bot.handleCardAction({ tag: 'agent_view_peek', value: { shortId, sessionId, cwd } })
   ↓
AgentViewManager.handlePeek(openId, shortId, sessionId, cwd)
   ↓
1. execFile('claude', ['logs', shortId]) 拿最近 TTY 输出
   ↓
2. ansi-strip(stripped)  ← 关键步骤(实测 `claude logs` 含 ANSI)
   ↓
3. truncateBytes(stripped, peek_max_bytes) 截断到 peek_max_bytes(默认 2KB)
   ↓
4. CardBuilder.buildPeekCard({ name, status, cwd, pid, startedAt, recentOutput })
   ↓
5. client.im.v1.message.create 发送新 peek 卡(不 patch 列表卡)
```

**`claude logs <id>` 输出处理流水线**(必加):
```
claude logs <id>  →  raw bytes
                    ↓
              ansi-strip(strip CSI / OSC 序列)
                    ↓
              按 \n split,取末尾 N 行(N = peek_lines,默认 30)
                    ↓
              truncateBytes(总长 ≤ peek_max_bytes,默认 2KB)
                    ↓
              飞书 markdown ``` ``` 包裹 → 飞书 card
```

`ansi-strip.ts` 实现要点:
- 匹配 `\x1b\[[0-9;]*[a-zA-Z]` (CSI 序列:颜色、光标)
- 匹配 `\x1b\][^\x07]*\x07` (OSC 序列:终端标题)
- 匹配 `\x1b\][^\x1b]*\x1b\\` (OSC 序列以 ST 终止)
- 配套单测:覆盖普通文字、彩色文字、进度条、clear screen、box drawing 重绘

### 5.3 Reply(关键路径,两步式文本消息模式)

**为什么不直接用飞书卡片表单弹窗**:飞书卡片是否原生支持 `tag: 'input'` 等模态组件在不同客户端表现不一致,且 cc-linker 现有交互走的是"用户直接发文本"模式(例如 `/switch <id>` 后接下一条消息),两步式更稳。

**Reply 状态守卫(v2.1 强化)**——三重条件 AND:
```
1. 查 in-memory + user-mapping.json 的 expectedReply 状态(via proper-lockfile)
   → 不是预期的 reply 调用(例如用户点 [Reply] 后没发文本)→ 走正常 chat
   
2. 实时调 `claude agents --json`,过滤 kind === "background"
   → 找不到对应 sessionId → 错误卡"会话已不存在",自动 refresh 列表
   
3. 状态字段检查:
   ├─ status === "busy"  → 错误卡"Claude 正在处理,请稍候",提供 [Refresh] 让用户重试
   ├─ status === "idle"  → 错误卡"该 session 已停止,无需回复",自动 refresh
   └─ status === "waiting" → 继续
```

**CAS Token 机制(v2.1 新增,解决 [取消] + 文本 race)**:
```
   handleReply 入口:
   1. read user-mapping via lock → 拿到 { ..., casToken: T0 }
   2. write { ..., casToken: T1 = uuid() } via lock,条件:原 casToken === T0
      ├─ CAS 失败(被 [取消] 抢先)→ patch 等待输入卡为"已取消",不调 sendSDKMessage
      └─ CAS 成功 → 调 sendSDKMessage(用 T1 作为 marker 关联)
   
   handleCancelReply 入口:
   1. read user-mapping via lock → 拿到 { ..., casToken: T0 }
   2. write { type: 'session' | (清空) } via lock,条件:原 casToken === T0
      ├─ CAS 失败(被 reply 抢先)→ 不做事(reply 已经在跑,R1 已知风险)
      └─ CAS 成功 → patch 等待输入卡为"已取消",发独立文本
```

**Step B 二次状态守卫(v2.1 新增,解决 busy→waiting 转换 race)**:
```
   用户发文本时,sendSDKMessage 之前(v2.2 修正:删 5s 死缓存):
   1. 重新调 `claude agents --json`(v2.2:每次必查,无缓存)
      v2.1 写的 "5s 缓存" 是死代码——`AgentSnapshotFetcher` 本版不做后台轮询
      (`§4.2`),缓存来源未定义;实测一次 `claude agents --json` 仅 ~50ms,
      5s 缓存收益微薄但增加代码复杂度,直接删
   2. session 不在 roster → 错误卡"会话已不存在",自动 refresh
   3. status === "busy" → 错误卡"Claude 已切换到 busy,无法 reply",
      同时 patch 等待输入卡为"⏱ 等待输入已自动取消(busy)",不调 sendSDKMessage
   4. status === "idle" → 错误卡"该 session 已停止,无法 reply",
      同时 patch 等待输入卡为"⏱ 等待输入已自动取消(idle)",不调 sendSDKMessage
   5. status === "waiting" → 继续(走 sendSDKMessage)
   ```
   - 这次重查有 ~50ms 延迟,用户几乎无感
   - 但避免了"用户发文本时 Claude 刚好从 waiting 转 busy"导致 R1 风险场景

**数据流**(Step A 和 Step B 分离,v2.1 加 CAS + 二次守卫 + / 命令白名单):

```
Step A — 用户在 list / peek 卡上点 [Reply] 按钮
   ↓
按钮 value: { tag: 'agent_view_reply_request', shortId, sessionId, cwd }
   ↓
bot.handleCardAction(...)
   ↓
AgentViewManager.handleReplyRequest(openId, shortId, sessionId, cwd)
   ↓
1. 状态守卫(三重条件,见上) → 不通过 → 错误卡 return
   ↓
2. 持久化 expectedReply 标记到 user-mapping.json(走 proper-lockfile,见 §4.2):
   openId → { type: 'pending_agent_reply', shortId, sessionId, cwd, startedAt, timeoutMs, casToken: T0 }
   ↓
3. 设置 in-memory 镜像
   ↓
4. **patch 触发的 list/peek 卡**(v2.2 措辞修正,避免跟"reply 不 patch"段混淆):
   - 触发 [Reply] 按钮的那张卡(可能是列表卡或 peek 卡)被 patch 为「✍️ 等待输入回复 · <name>」卡
   - **这是"卡状态转变":同一张飞书消息从"列表卡/peek 卡"变成"等待输入卡"**,内容布局完全改变
   - **不是**把"列表卡/peek 卡"变成"reply 卡"——reply 流式卡是另一条新消息(见 Step B 步骤 7-8)
   - patch 后 list/peek 卡的 [Reply] / [Peek] / [Stop] 等按钮都消失,只保留 [取消等待]
   ↓
5. 发独立文本消息(顺序:先 patch 卡,再发文本):
   "↩️ 回复会话: <name>
    请直接发送文字消息作为回复(5 分钟内有效)
    可点 [取消等待] 按钮,或发 /cancel 取消"
   ↓
6. setTimeout(expected_reply_timeout_ms) 触发超时处理

Step B — 用户发普通文本消息(im.message.receive_v1)
   ↓
bot.handleChat() 收到普通消息
   ↓
1. 检查 expectedReply 状态(先 in-memory,后 user-mapping.json)
   ├─ 否 → 走现有 handleChat 流程(普通 chat reply)
   └─ 是 → 进入 handleReply 流程 ↓
   ↓
2. 文本以 "/cancel" 开头 → handleCancelReply() 走取消流程(见下)
   ↓
3. 文本以 "/" 开头(且非 /cancel)→ 检查命令白名单:
   ├─ 只读命令(/help /status /whoami)→ 不清 expectedReply,继续按命令分发
   └─ 写命令(/list /listdir /new /switch /model /resume /agents /cancel)→ 清 expectedReply + patch "已自动取消(因你跑了 /xxx)"
   ↓
4. AgentViewManager.handleReply(openId, shortId, sessionId, cwd, text)
   ↓
5. **CAS 抢占**(v2.1 新增):read user-mapping via lock,拿 T0 → 写 T1 = uuid()
   ├─ CAS 失败(被 [取消] 抢先)→ patch 等待输入卡为"已取消",return
   └─ CAS 成功 ↓
   ↓
6. **Step B 二次状态守卫**(v2.1 新增):实时调 `claude agents --json`
   ├─ session 不在 roster → 错误卡"会话已不存在" + 自动 refresh + 清 expectedReply
   ├─ status === "busy" → 错误卡"Claude 已切换到 busy" + patch 等待输入卡为"已自动取消(busy)" + 清 expectedReply
   ├─ status === "idle" → 错误卡"该 session 已停止" + patch 等待输入卡为"已自动取消(idle)" + 清 expectedReply
   └─ status === "waiting" → 继续 ↓
   ↓
7. **创建新 CardUpdater(独立于 Agent View 列表/peek 卡),startProcessing(openId) → 拿新 cardMessageId**
   - 关键:这一步必须**复用** `FeishuBot.handleChatSDK`(`src/feishu/bot.ts:1019-1138`)的完整流程,不能只调一行 `sendSDKMessage` 就结束(v2.2 修正,P0 修复)
   - **重构要求**:把 `handleChatSDK` 从 `private` 提到 `public`(改名 `runChatSDK`),接受 `(openId, sessionUuid, cwd, settingsPath, promptText, serialKey, isNew=false)` 7 个参数,返回 `{ result, handler, cardMessageId }`
   - Agent View reply 调 `runChatSDK(...)`,`isNew=false`,`serialKey=sessionId` 走 `sessionLocks` 串行化
   ↓
8. **sendSDKMessage 完整生命周期(v2.2 补,容易遗漏)**——`runChatSDK` 内部必须按以下顺序处理,缺失任何一步都会出 bug:
   ```
   ① const { result, handler } = await sessionManager.sendSDKMessage(
        sessionUuid, promptText, cwd,
        (chunk) => cardUpdater.updateStream(thinking, text, elapsed),  // ①.a 流式回调
        (prompt, sdkHandler) => {                                      // ①.b 权限回调
          activePermissionHandlers.set(sdkHandler.getHandlerId(), sdkHandler);
          const permCardUpdater = new CardUpdater(feishuClient, { throttle_ms: 0 });
          const createdId = await permCardUpdater.createPermissionCard(
            openId, prompt.toolName, actionText, prompt.index, sdkHandler.getHandlerId()
          );
          permCardMessageIds.add(createdId);
        },
        false,      // isNew
        serialKey,  // sessionLocks 串行
        settingsPath
      );
   ② const finalText = text || result.response || '(空回复)';
   ③ if (cancelledMessageIds.has(msg.messageId)) {
        await cardUpdater.cancel();  // 用户中途 /stop
      } else if (cardUpdater.shouldFallbackToText(finalText)) {
        // 大输出:卡片放截断版 + 文本发余下部分
        const truncated = cardUpdater.truncateContent(finalText);
        await cardUpdater.complete(truncated, result.tokensIn, result.tokensOut, result.durationMs, 1);
        const remainder = finalText.slice(truncated.length);
        if (remainder) for (const chunk of splitReplyText(remainder, 3900)) await replyFn(chunk, ...);
      } else {
        await cardUpdater.complete(finalText, result.tokensIn, result.tokensOut, result.durationMs, 1);
      }
   ④ cardUpdater.dispose();
   ⑤ // 1200ms 后批量 patch 所有权限卡为"✅ 已完成",并 cancel click 触发的延迟 patch timer
      setTimeout(async () => {
        for (const cardId of permCardMessageIds) {
          const pending = activePermissionCardTimeouts.get(cardId);
          if (pending) { clearTimeout(pending); activePermissionCardTimeouts.delete(cardId); }
          try {
            const u = new CardUpdater(feishuClient, { throttle_ms: 0 });
            u.setCardMessageId(cardId);
            await u.updatePermissionCardToCompleted();
          } catch (e) { logger.warn(`permission card completion failed: ${e}`); }
        }
      }, 1200);
   ```
   - **activity marker** 由 `sendSDKMessage` 内部 `start/heartbeat/end` 自动写(`src/proxy/session.ts:808-832`),Agent View 不重写
   ↓
9. 流式结果:`CardUpdater` 自动 `processing → streaming → complete/error/cancelled`
   ↓
10. 完成后 `releaseSessionLock(serialKey)`(`sendSDKMessage` 内部,`src/proxy/session.ts:922`)
```

**handleCancelReply 数据流(v2.1 加 CAS 抢占)**:
```
   触发方式:① [取消等待] 按钮 ② 用户发 /cancel 文本 ③ 5min 超时 setTimeout
   ↓
   1. read user-mapping via lock,拿 T0
   2. write 清空 entry,条件:原 casToken === T0
      ├─ CAS 失败(被 handleReply 抢先,sendSDKMessage 已在跑)→ 
      │   ├─ 取消来源是超时:patch 等待输入卡为"⏱ 等待超时" + 发独立提示文本
      │   └─ 取消来源是用户:[静默],让 reply 继续(R1 已知:sendSDKMessage 无法中断)
      └─ CAS 成功 ↓
   3. patch 等待输入卡为"✅ 已取消"
   4. 发独立文本消息"已取消对 <name> 的回复等待"
   ```

**`/` 命令白名单(v2.1 新增,实现时查表)**:
```
   不清 expectedReply 的命令(只读):
     /help /status /whoami
   清 expectedReply 的命令(其他所有 / 开头):
     /list /listdir /new /switch /model /resume /agents /cancel
   匹配规则:精确匹配(不含参数),如 "/switch" 算清,但 "/list" 算清,/listdir 算清
```

**关键设计**(v2.1 更新):
- **每个 reply 是新飞书消息**,不 patch peek/列表卡。原因:peek 卡内容已多,patch 后难看;IM 习惯每动作产生新消息;用户能在消息流里直接看到 reply 完整过程
- **状态守卫依据**:`claude agents --json` 返回的 `status` 字段有 `busy` / `waiting` / `idle` 三值,**Reply 只允许 `waiting`**。见 §3.1
- **三重守卫**:`kind === "background"` + `status === "waiting"` + roster 实时复查(不只信卡片缓存)
- **CAS Token 抢占**(v2.1 新增):解决 [取消] + 文本 race,见上面伪代码
- **Step B 二次守卫**(v2.1 新增):发文本那一刻再查 status,busy/idle 拒绝
- **不操作 supervisor 私有协议**:Anthropic 未公开,代价太高
- **不阻塞**:reply 触发后立刻让出,流式回调异步
- **等待超时**:5 分钟无输入,自动走 handleCancelReply(走 CAS,可能输给并发 reply)
- **expectedReply 持久化**:写到 user-mapping.json,走 `proper-lockfile`,bot 重启可恢复
- **`/` 命令白名单**:只读命令不清 expectedReply,写命令清

**[取消] 按钮**:
- "等待输入" 卡片本身带 `[取消等待]` 按钮,value `{ tag: 'agent_view_cancel_reply' }`
- 用户不必发 `/cancel` 文本,点按钮即可
- 取消后 patch 等待输入卡为 "✅ 已取消",发独立提示文本消息
- 若 CAS 失败(被 reply 抢先),见上面 handleCancelReply 流程,行为分"超时" vs "用户取消"两种

**为什么不直接用 `card.action.trigger` 弹窗**:飞书卡片 input 组件在不同客户端(PC/手机/不同飞书版本)表现不一致,且本仓库无先例。两步式走"普通消息"通道,跟现有 cc-linker UX 一致(用户本来就习惯在飞书里打字),移动端体验更好。

### 5.4 Stop(v2.1 改为独立新卡,不再 patch 列表卡)

```
bot.handleCardAction({ tag: 'agent_view_stop', value: { shortId, sessionId, name } })
   ↓
AgentViewManager.handleStop(openId, shortId, sessionId, name)
   ↓
1. 二次确认分流(v2.1 改:发独立新卡,不 patch 列表):
   ├─ currentStatus === "busy" → 调 client.im.v1.message.create 发**独立新卡**:
   │   "🔴 确认停止? · <name>
   │    该 session 正在处理任务,停止后无法撤销。
   │    提示:Claude 可能正处于工具调用中,长任务中断需要重新派发。
   │    [✅ 确认停止] [← 取消]"
   │   按钮 value: { tag: 'agent_view_stop_confirm', shortId, sessionId }
   │   列表卡**保持原样**,不被覆盖
   │
   └─ currentStatus === "waiting" / "idle" → 死分支(按钮在这些状态不显示,见 §3.2)
   ↓
2. 用户点 [✅ 确认停止] → 真正执行:
   ├─ execFile('claude', ['stop', shortId])
   │   ├─ 失败 → 错误卡 "Stop 失败:<err>"(独立新消息)
   │   └─ 成功 ↓
   ├─ sleep(1000)  // 等 supervisor 收尾
   ├─ 发独立文本消息"✅ 已停止 <name>"
   └─ handleList(openId, lastAgentListCardId) 重新拉并 patch 列表卡
   ↓
3. 用户点 [← 取消] → 二次确认卡**不消失**(无操作 = 仍在飞书流),
   用户可手动忽略;列表卡原样保留
```

**为什么 v2.1 改独立新卡(v2 是 patch 列表卡,v2.1 改)**:
- 之前版本(v2)设计 "patch 原列表行为二次确认卡" 有 bug:用户取消停止后,列表卡已被覆盖,需要重新打 `/agents` 重新拉
- v2.1 改为发独立新卡:列表卡原样保留,取消停止 = 用户点 [← 取消] 后直接忽略确认卡
- 缺点:飞书流里多一条独立的二次确认卡,但收益 = 列表卡不会丢失,值得

**为什么 busy 才要二次确认**:`busy` 时 stop 会杀掉正在跑的长任务,手机端误点代价大;`waiting`/`idle` 状态时 Claude 已经停了或阻塞中,stop 无意义(按钮在这些状态不显示)。

### 5.5 Attach(v2.2 新增)

**核心设计**:Attach 是 `/switch` 的卡片化入口,将 background session 绑定为用户的当前活跃 session,后续普通消息直接注入。

**与 `/switch` 的区别**:
- 入口不同:卡片按钮 vs 文本命令
- 不依赖 registry:background session 可能不在 registry 中,Attach 直接从 `claude agents --json` 拿 `sessionId` + `cwd`
- 清除 expectedReply:Attach 时如果用户正在 reply 等待状态,先清除

```
bot.handleCardAction({ tag: 'agent_view_attach', value: { sessionId, shortId, name, cwd } })
   ↓
AgentViewManager.handleAttach(openId, sessionId, shortId, name, cwd)
   ↓
1. 实时守卫:重查 `claude agents --json`,确认 session 仍存在
   ├─ 不在 roster → 错误卡"会话已不存在" + 自动 refresh
   └─ 存在 ↓
   ↓
2. 清除 expectedReply（如果存在）
   └─ 类似于 `/` 命令行为,新操作覆盖旧状态
   ↓
3. **CAS 更新 UserManager(分两步,v2.2 修正)**
   ```
   // 第一步:清掉旧 entry
   const oldEntry = userManager.getEntry(openId);
   const cas1 = await userManager.compareAndSwap(openId, oldEntry, null);
   ├─ CAS 1 失败(其他客户端并发改了 entry)→ 错误卡"状态冲突,请重试"
   └─ CAS 1 成功 ↓

   // 第二步:写新 session entry
   // 字段来源:oldEntry 里有 defaultProvider,保留;createdAt 用 now;其他用新值
   const newEntry: MappingEntry = {
     type: 'session',
     sessionUuid: sessionId,
     cwd,
     createdAt: new Date().toISOString(),
     casToken: '<auto>',
     defaultProvider: oldEntry?.defaultProvider,  // 保留 user-level config
     // 其余字段不复制(claimedBy / startedAt / shortId 等是 type 特定的)
   };
   const cas2 = await userManager.compareAndSwap(openId, null, newEntry);
   ├─ CAS 2 失败(CAS 1 和 CAS 2 之间有其他客户端插队写了 entry)→ 错误卡"状态冲突,请重试"
   └─ CAS 2 成功 ↓
   ```
   - **为什么必须分两步**:`UserManager.compareAndSwap(expected, newValue)` 要求 expected == current,
     spread 旧 entry 改 type 字段会让 `type` 不匹配 → 必然失败
   - **race 处理**:CAS 1 成功后到 CAS 2 前的窗口期很短(几毫秒),但理论可能;
     CAS 2 失败说明中间被插队,降级为错误卡让用户重试(不重试整个流程,避免无限循环)
   - **expectedReply 互斥**(M2 设计保证):清掉旧 entry 时如果旧 entry 是 `pending_agent_reply`,
     等同于隐式取消等待;但 spec 这里要求**步骤 2 之前先做"清除 expectedReply"**(见步骤 2),
     所以到步骤 3 时 entry 不应该是 `pending_agent_reply`
   ↓
4. 发确认文本消息:
   "📎 已 Attach 到 `<name>`
    后续消息将直接发送至此 session。
    Status: <status> · CWD: <cwd>
    💡 提示:发 /new 创建新会话,或 /agents 返回列表。"
   ↓
5. 用户后续普通消息 → resolveChatTarget() 返回该 session
   → serialKey = sessionId → sendSDKMessage(resume) → 正常流式输出
```

**Attach 后消息流**:
- 用户发普通消息 → `handleChat()` → `resolveChatTarget()` 读取 UserManager 状态
- 返回 `type: 'session', sessionUuid: sessionId` → `serialKey = sessionId`
- 消息入队,`sessionLocks` 串行化同一 session 的并发消息
- `sendSDKMessage(sessionId, text, cwd, ...)` → `resume` 恢复 session → 流式输出

**Attach 到不同状态的行为**:
- `busy`:发确认消息时加 `⚠️ 该 session 正在处理中` 提示
- `waiting`:透传 `waitingFor`,如"等待原因: input needed"
- `idle`:正常 Attach,用户可继续对话(若 session 已完成,相当于 resume 后继续)

**Attach 与 Reply 的 race**:Attach 的"清除 expectedReply"通过 CAS 实现。如果用户点 [Attach] 的同时正在发 reply 文本,两者竞争 CAS,只有一个成功。失败方按各自规则降级(Attach 失败 → 错误卡"状态冲突";Reply CAS 失败 → patch 等待卡为"已取消")。

## 6. UI 设计

### 6.1 列表卡(主入口)

```
┌──────────────────────────────────────────────┐
│ 🤖 Agent View · 3 sessions                   │   <- header (blue)
├──────────────────────────────────────────────┤
│ **处理中 (1)**                                │
│                                              │
│ ✽ `flaky-test-fix`  ·  2m                   │
│   📁 ~/projects/my-app                       │
│   [Peek] [Attach] [Stop]                     │
│                                              │
│ **等待输入 (1)**                              │
│                                              │
│ ✋ `power-up design`  ·  1m                 │
│   📁 ~/projects/my-game                      │
│   [Peek] [Attach] [Reply]                    │
│                                              │
│ **已完成/空闲 (1)**                           │
│                                              │
│ ⏹ `title screen`  ·  9m                     │
│   📁 ~/projects/my-game                      │
│   [Peek] [Attach]                            │
├──────────────────────────────────────────────┤
│ Last refreshed 12:34:56  ·  [🔄 Refresh]    │
└──────────────────────────────────────────────┘
```

**v2.1 微调**(隐藏 interactive 数量提示):
```
│ Last refreshed 12:34:56  ·  [🔄 Refresh]    │
│ 隐藏 2 个 interactive 会话 (用 --cwd 过滤)  │  ← 仅当 N>0 时显示
└──────────────────────────────────────────────┘
```
(给排错用户一点线索:为什么"我的会话"没出现)

**状态图标映射(v2.2 修正,3 态)**

| 状态(`status`) | 飞书 emoji | 含义 | 允许 [Reply] | 允许 [Stop] | 允许 [Attach] |
|-----|-----------|------|---|---|---|
| `busy` | `✽` | Claude 正在执行 | ❌ 守卫拒绝 | ✅(二次确认) | ✅ |
| `waiting` | `✋` | Claude 等待输入/权限(`waitingFor` 说明具体等什么) | ✅ | ❌ 按钮隐藏 | ✅ |
| `idle` | `⏹` | Claude 已停止(已完成/失败/空闲) | ❌ 按钮隐藏 | ❌ 按钮隐藏 | ✅ |

> TUI 的 6 态(Working/Needs input/Idle/Completed/Failed/Stopped)是界面分组,JSON 只有 `busy`/`waiting`/`idle` 三值

**每行字段**:
- 名称(`name` 字段)
- 状态图标(上表映射)
- 耗时(从 `startedAt` 计算,人可读格式,如 `2m` / `1h 30m`)
- 目录(`cwd`,截断到 `~/projects/my-app`)
- **PR 编号:本版不显示**(N8),推迟到下个版本

**按钮可见性**:
- `[Peek]`:所有状态都显示
- `[Attach]`:所有状态都显示
- `[Reply]`:仅 `waiting` 时显示
- `[Stop]`:仅 `busy` 时显示(waiting/idle 状态从 action 列表里**过滤掉**,不是渲染了禁用)
- `[🔄 Refresh]`(footer):固定显示,value 标 `agent_view_refresh_list`(v2.1 拆 tag,见 §6.4)

**空状态卡(v2.1 补 [回到普通聊天] handler)**:
```
┌──────────────────────────────────────────────┐
│ 🤖 Agent View                                │   <- header (grey)
├──────────────────────────────────────────────┤
│ 暂无后台会话                                  │
│                                              │
│ Agent View 用于管理用 `claude --bg` 派发     │
│ 的后台任务。在终端执行:                       │
│                                              │
│   claude --bg "你的任务描述"                  │
│                                              │
│ 或在一个已有会话里输入 `/bg` 转入后台。       │
│ 派发后会出现在这里。                          │
├──────────────────────────────────────────────┤
│ [🔄 Refresh] [💬 回到普通聊天]              │
└──────────────────────────────────────────────┘
```

`[💬 回到普通聊天]` 按钮(v2.1 补 handler):
- value: `{ tag: 'agent_view_back_to_chat' }`
- handler:发独立文本消息"已退出 Agent View,继续发送消息或 / 命令即可。下次进 /agents 视图重新打 /agents。"
- 飞书流里多一条文本,空状态卡本身**不 patch**(用户可手动忽略)

**Claude daemon 未运行错误卡**(v2.1 新增,与"空 session" 区分):
```
┌──────────────────────────────────────────────┐
│ ❌ Claude supervisor 未运行                  │   <- header (red)
├──────────────────────────────────────────────┤
│ Agent View 需要 Claude daemon 提供后台       │
│ 会话管理。                                    │
│                                              │
│ 修复方法:在终端任意目录运行一次 `claude`     │
│ 命令(普通交互即可),daemon 会自动拉起。      │
├──────────────────────────────────────────────┤
│ [🔄 重新检测]                                │
└──────────────────────────────────────────────┘
```

**溢出**:>10 个会话时折行 `… N more`,提示用户用 `claude agents --cwd <path>` 缩小范围(v2.2 末轮核实:`--cwd` 实测存在,行为 "Show only background sessions started under <path>")。完整列表不渲染避免超 25KB(沿用 `stream.max_card_bytes`)。

### 6.2 Peek 卡(v2.1 简化按钮)

```
┌──────────────────────────────────────────────┐
│ 🔍 Peek · `flaky-test-fix`                   │   <- header
├──────────────────────────────────────────────┤
│ Status: 处理中 (busy)                        │
│ CWD: ~/projects/my-app                       │
│ PID: 33348  ·  Started 12:30:00              │
├──────────────────────────────────────────────┤
│ **Recent output (last 30 lines)**            │
│ ```                                          │
│ $ npm test                                   │
│ PASS tests/checkout.test.ts                  │
│ FAIL tests/cart.test.ts                      │
│   Expected: 3                                │
│   Received: 4                                │
│ ```                                          │
├──────────────────────────────────────────────┤
│ [Peek] [Attach] [Stop] [🔄 Refresh]         │  ← busy 状态
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ 🔍 Peek · `power-up design`                  │   <- header
├──────────────────────────────────────────────┤
│ Status: 等待输入 (waiting)                   │
│ 等待原因: input needed                       │  ← v2.2:透传 waitingFor
│ CWD: ~/projects/my-game                      │
│ PID: 95189  ·  Started 12:20:00              │
├──────────────────────────────────────────────┤
│ **Recent output (last 30 lines)**            │
│ ```                                          │
│ What would you like to do next?              │
│ ```                                          │
├──────────────────────────────────────────────┤
│ [Attach] [Reply] [🔄 Refresh]               │  ← waiting 状态
└──────────────────────────────────────────────┘
```

> v1 文档曾设计的 `[← Back to list]` 按钮本版去掉——peek 卡作为新消息存在于飞书流里,用户自己滚动回去;back 按钮反直觉。
> v2.1 [Refresh] 改用 `agent_view_refresh_peek` tag(见 §6.4),handler 重新拉 `claude logs <id>` 并 patch peek 卡

**等待输入状态卡**(用户点 [Reply] 后,v2.1 删假倒计时和 [Refresh]):
```
┌──────────────────────────────────────────────┐
│ ✍️ 等待输入回复 · `power-up design`           │   <- header (yellow)
├──────────────────────────────────────────────┤
│ 状态:等待输入 (waiting)                      │
│ 等待原因: input needed                       │  ← v2.2:透传 waitingFor
│ CWD: ~/projects/my-game                      │
├──────────────────────────────────────────────┤
│ 请直接发送文字消息作为回复(5 分钟内有效)     │
│                                              │
│ ⏱ 等待输入中(5 分钟后超时)                   │  ← v2.1:静态文案,不做假倒计时
├──────────────────────────────────────────────┤
│ [取消等待]                                   │  ← v2.1:删 [🔄 Refresh],无意义
└──────────────────────────────────────────────┘
```

**v2.1 删假倒计时的原因**:
- 飞书卡片 patch 有 throttle(`stream.throttle_ms = 1500ms`,见 `card-updater.ts:38`),不能每秒更新
- v2 文档曾写的 "⏱ 剩余时间: 4:32" 是固定数字,骗人的
- 改为静态"等待输入中(5 分钟后超时)",诚实

**v2.1 删等待卡 [Refresh] 的原因**:
- 等待输入状态下,用户应该发文本,不需要"刷新状态"
- 如果想重新查 status,直接点 [取消等待] 后再点 [Reply] 即可(守卫会重查)
- 减少一个按钮,降低认知负担

**Stop 二次确认卡**(busy 状态点 [Stop] 后,v2.1 改独立新卡):
```
┌──────────────────────────────────────────────┐
│ 🔴 确认停止? · `flaky-test-fix`              │   <- header (red)
├──────────────────────────────────────────────┤
│ 该 session 正在处理任务,停止后无法撤销。     │
│                                              │
│ 提示:Claude 可能正处于工具调用中,长任务     │
│ 中断需要重新派发。                            │
├──────────────────────────────────────────────┤
│ [✅ 确认停止] [← 取消]                       │
└──────────────────────────────────────────────┘
```

> v2.1 变更:此卡是**独立新消息**,**不 patch 列表卡**(详见 §5.4)。列表卡原样保留。

### 6.3 错误卡

| 错误 | 标题 | 内容 |
|------|------|------|
| 版本过低 | `❌ Claude 版本过低` | `需要 v2.1.139+,当前 vX.Y.Z / 请运行 claude update` |
| Claude 不在 PATH | `❌ Claude CLI 未安装` | `请先安装 Claude Code CLI` |
| **daemon 未运行(v2.1 新增)** | `❌ Claude supervisor 未运行` | `在终端跑一次 claude 命令,daemon 会自动拉起 / [🔄 重新检测]` |
| supervisor 异常 | `❌ Claude supervisor 异常` | `<stderr 前 200 字符>` |
| 解析失败 | `⚠️ 无法解析 Claude 输出` | `<前 100 字符>` |
| 会话已消失 | `⚠️ 会话已不存在` | `已自动刷新列表` + 触发 handleList |
| Reply 守卫拒绝(busy) | `⚠️ Claude 正在处理` | `该 session 正在执行,无法插入新消息 / busy 时 [Reply] 按钮自动隐藏,但缓存可能过期 [🔄 Refresh]` |
| Reply 守卫拒绝(idle) | `⚠️ 会话已停止` | `该 session 已停止,无需回复 / [🔄 Refresh]` |
| Reply 守卫拒绝(interactive) | `⚠️ 非后台会话` | `该 session 是主会话(非 background),请用 /bridge 处理` |
| Attach 失败(session 消失) | `⚠️ 会话已不存在` | `已自动刷新列表` + 触发 handleList |

错误卡统一无操作按钮(daemon 未运行卡例外,有 [🔄 重新检测]),header 用 `template: 'red'` 或 `template: 'grey'`,标题前缀 `❌` 或 `⚠️`。

### 6.4 Action value schema(v2.2 调整:9 种 tag,增加 attach)

**对齐 cc-linker 现有 `card.action.trigger` 处理模式**:`tag` 是动作判别字符串,`value` 是 value object(可空)。`bot.handleCardAction()` 现有 `switch (tag)` 分派。

**v2.2 关键调整**:
- 增加 `agent_view_attach`(v2.2 新增)
- 拆 `agent_view_refresh` → `agent_view_refresh_list` + `agent_view_refresh_peek`,因为 list/peek 两种卡 [Refresh] 含义不同
- 删等待输入卡的 [Refresh](无意义)
- 加 `agent_view_back_to_chat` 处理空状态卡 [回到普通聊天] 按钮
- `agent_view_stop` value 简化:只接受 `currentStatus: 'busy'`(waiting/idle 按钮不渲染,死分支删除)

```typescript
// 按钮实际构造(v2.2 共 9 种 tag)
{ tag: 'agent_view_refresh_list',     value: {} }                                       // v2.1:列表卡 [Refresh]
{ tag: 'agent_view_refresh_peek',     value: { shortId, sessionId } }                   // v2.1:peek 卡 [Refresh](新拆)
{ tag: 'agent_view_peek',              value: { shortId, sessionId, cwd } }
{ tag: 'agent_view_attach',            value: { sessionId, shortId, name, cwd } }        // v2.2:Attach
{ tag: 'agent_view_reply_request',     value: { shortId, sessionId, cwd } }
{ tag: 'agent_view_cancel_reply',      value: {} }                                      // 等待卡 [取消等待]
{ tag: 'agent_view_stop',              value: { shortId, sessionId, name } }           // v2.1:删 currentStatus(只接受 busy)
{ tag: 'agent_view_stop_confirm',      value: { shortId, sessionId } }                  // 二次确认后才真执行
{ tag: 'agent_view_back_to_chat',      value: {} }                                      // v2.1:空状态卡 [回到普通聊天]

// 在 bot.handleCardAction 内的分派(伪代码)
switch (tag) {
  case 'agent_view_refresh_list':     await agentView.handleRefreshList(openId, messageId); break;
  case 'agent_view_refresh_peek':     await agentView.handleRefreshPeek(openId, value.shortId, value.sessionId, messageId); break;
  case 'agent_view_peek':             await agentView.handlePeek(openId, value.shortId, value.sessionId, value.cwd); break;
  case 'agent_view_attach':           await agentView.handleAttach(openId, value.sessionId, value.shortId, value.name, value.cwd); break;
  case 'agent_view_reply_request':    await agentView.handleReplyRequest(openId, value.shortId, value.sessionId, value.cwd); break;
  case 'agent_view_cancel_reply':     await agentView.handleCancelReply(openId, messageId); break;
  case 'agent_view_stop':             await agentView.handleStop(openId, value.shortId, value.sessionId, value.name); break;
  case 'agent_view_stop_confirm':     await agentView.handleStopConfirm(openId, value.shortId, value.sessionId, messageId); break;
  case 'agent_view_back_to_chat':     await agentView.handleBackToChat(openId); break;
  default: ...;  // 现有 unknown tag 分支
}

// 类型定义(便于 action.ts 引用,v2.2 共 9 种 variant)
type AgentViewValue =
  | { tag: 'agent_view_refresh_list' }
  | { tag: 'agent_view_refresh_peek';  shortId: string; sessionId: string }
  | { tag: 'agent_view_peek';          shortId: string; sessionId: string; cwd: string }
  | { tag: 'agent_view_attach';        sessionId: string; shortId: string; name: string; cwd: string }
  | { tag: 'agent_view_reply_request'; shortId: string; sessionId: string; cwd: string }
  | { tag: 'agent_view_cancel_reply' }
  | { tag: 'agent_view_stop';          shortId: string; sessionId: string; name: string }
  | { tag: 'agent_view_stop_confirm';  shortId: string; sessionId: string }
  | { tag: 'agent_view_back_to_chat' }
```

**handler 路由的 messageId lookup 逻辑(v2.2 修正)**:
- handleCardAction 收到 `messageId`(触发 action 的卡的消息 ID)
- 列表卡 [Refresh]:用 `messageId` 走 `user-mapping.json` 的 `last_agent_list_card.cardMessageId` 校验(防 list 卡被覆盖后旧 messageId 误 patch),校验通过则 patch 同一卡;校验失败走"卡片已过期,发新列表卡"路径
- **peek 卡 [Refresh](v2.2 修正)**:peek 卡是独立新消息,value 里已带 `shortId` / `sessionId`,**不查 user-mapping**。`messageId` 直接用于 `client.im.v1.message.patch` 重新拉 `claude logs <id>` 渲染
- 等待输入卡 [取消] / [Refresh] 走 [取消] 路径(§5.3),无 lookup

## 7. 配置

`config.toml` 新增节:

```toml
[agent_view]
# 是否启用 Agent View 功能
enabled = true
# 两次 refresh 之间的最小间隔(ms),用于防抖
refresh_min_interval_ms = 2000
# Peek 抓取最近多少行
peek_lines = 30
# Peek 单次输出最大字节数(过大会被 ANSI strip + truncateBytes 截断)
peek_max_bytes = 2048
# Reply 等待输入超时(ms),默认 5 分钟
expected_reply_timeout_ms = 300000
# 是否只显示 kind=background 会话(关键过滤器)
background_only = true
# busy 状态下 [Stop] 是否需要二次确认(防止手机端误点)
stop_requires_confirm = true
# 给用户提示用,不强制
min_claude_version = "2.1.139"
# ===== v2.2 新增 =====
# Agent View reply 专用 throttle(v2.2 新增,原因:Agent View reply 通常 1-2 句短回复,
# 默认 1500ms throttle 让用户多等 1.5s 才看到 complete;短回复用 500ms 即可)
# 列表/peek 等长输出仍走默认 stream.throttle_ms
reply_throttle_ms = 500
# 卡片 body 字节上限(沿用 stream.max_card_bytes,Agent View 不重写,只引用)
# max_card_bytes = 25000
```

> **v2.1 删 `reply_lock_timeout_ms`**:直接复用 `runtime.session_lock_timeout_ms`(已在 `src/proxy/session.ts:928` 实现,默认 10 分钟)。Agent View 不重新定义。

> **v2.1 写盘锁**:读写 user-mapping.json 走 `proper-lockfile`,见 `src/utils/lock.ts`。不重新发明轮子。
```

`config.ts` 注册这些 key,带默认值,env 变量 `CC_LINKER_AGENT_VIEW_*` override。

## 8. 错误处理

| 错误 | 检测点 | 飞书呈现 |
|------|--------|----------|
| `claude` 不在 PATH | `execFile` ENOENT | 错误卡 "Claude CLI 未安装" |
| 版本 < 2.1.139 | 解析 `--version` | 错误卡 "需要 v2.1.139+,当前 vX" |
| **daemon 未运行(v2.1 新增)** | `~/.claude/daemon/roster.json` 不存在 | 错误卡 "Claude supervisor 未运行" + [🔄 重新检测](区分于"空 session") |
| supervisor 异常 | `agents --json` 非 0 exit | 错误卡 "Claude supervisor 异常" |
| 解析失败 | JSON.parse 抛错 | 错误卡 "无法解析输出" |
| **`kind: interactive` 混入(v2.1 新增)** | snapshot 过滤后还有 interactive | 静默丢弃(预期行为,不在用户面前报错) |
| `claude logs <id>` 失败 | execFile 非 0 | 在原列表卡 patch "会话已不存在" + refresh |
| `claude stop <id>` 失败 | execFile 非 0 | 在原列表卡 patch "Stop 失败:<err>" |
| **Reply 守卫:busy 状态(v2.2 强化)** | 实时 `claude agents --json` 复查 | 错误卡 "Claude 正在处理,请稍候" + [🔄 Refresh] |
| **Reply 守卫:idle 状态(v2.2 新增)** | snapshot 状态为 idle | 错误卡 "该 session 已停止,无需回复" + [🔄 Refresh] |
| **Reply 守卫:session 不在 roster(v2.1 新增)** | snapshot 已无该 sessionId | 错误卡 "会话已不存在" + 自动 refresh |
| **Attach 失败:session 消失(v2.2 新增)** | 实时 `claude agents --json` 找不到 session | 错误卡 "会话已不存在" + 自动 refresh |
| `sendSDKMessage` "session in use" | error 文本匹配 | reply 卡 "会话已被占用" |
| `sendSDKMessage` 其他错误 | catch 通用 | reply 卡显示错误(走 CardUpdater.error) |
| reply 等待超时(5 分钟无输入) | setTimeout 触发 | patch 原卡 "⏱ 等待超时" + **发独立提示文本消息**(v2 改) |
| reply 期间用户发 `/cancel` | 普通消息文本匹配 | patch 原卡 "已取消",清除标记,不发 reply |
| reply 期间用户发无关消息 | 普通消息 | 不影响:无 expectedReply 标记的消息走普通 chat 流程 |
| **reply 期间用户发其他 `/` 命令(v2 新增)** | 任何 `/` 开头命令 | 自动清 expectedReply + patch 卡 "已自动取消(因你跑了 /xxx)" |
| reply 期间用户发第二条 reply 文本 | 普通消息 | 不影响:expectedReply 标记已被 Step B 入口清掉,走普通 chat |
| 卡片 body 超 25KB | build 完测字节 | fallback 到纯文本消息(`shouldFallbackToText`) |
| 列表/peek 关闭/超时 | CardUpdater.dispose | 现有行为 |
| **bot 重启后 expectedReply 状态(v2.1 改)** | 启动时从 user-mapping.json 读,算 `now - startedAt` | 若已超时:从 user-mapping 静默删除(不发 patch,避免对归档卡的无效操作);若未超时:in-memory 重建 + setTimeout 等剩余时间 |
| **CAS 抢占失败(v2.1 新增)** | handleReply 或 handleCancelReply 的 CAS 写失败 | handleReply:patch 等待卡为"已取消",不发 reply;handleCancelReply:[静默],让 reply 继续 |
| **Step B 二次守卫:busy 转换(v2.1 新增)** | 发文本时重查 status 发现 busy | 错误卡"Claude 已切换到 busy" + patch 等待卡为"⏱ 等待已自动取消(busy)" + 清 expectedReply |
| **Step B 二次守卫:session 消失(v2.1 新增)** | 发文本时重查 roster 发现 sessionId 不在 | 错误卡"会话已不存在" + 自动 refresh 列表 + 清 expectedReply |
| **`/` 命令清 expectedReply(v2.1 新增)** | 收到 `/list` `/listdir` `/new` `/switch` `/model` `/resume` `/agents` 等 | patch 等待卡为"已自动取消(因你跑了 /xxx)",发独立提示 |
| **`/` 命令不清 expectedReply(v2.1 新增)** | 收到 `/help` `/status` `/whoami` | 不清,正常按命令分发 |

实现:`agent-view/card.ts` 暴露 `buildErrorCard(reason)`,统一标题、配色、footer。**不**复用 `feishu/card-updater.ts` 的错误卡构造,因其绑定到 `CardUpdater` 实例。

## 9. 关键风险与开放问题

### R1 — SDK resume 对 supervisor-managed session 行为部分已知(中,v2.1 重写)

**v1 假设**:`query({ resume: sessionId, prompt })` 对 supervisor 托管的 blocked session 表现未知。

**v2.2 已知事实**(实测 2.1.163,缩小风险面):
- `sessionId` 是 UUID,直接对应 `query({ resume })` 的 key
- `kind: "background"` session 通过 supervisor 拉起,resume 时 supervisor 重新拉 worker
- `claude stop <id>` 保留 conversation,`claude attach <id>` 可继续
- **已实测**:`status: idle` 状态时 resume 行为正常(已通过 §10.4 手动验收)
- **未实测 / 未知**:
  - `status: busy` 时外部并发 `claude -p --resume <id>` 会发生什么(可能:起并行进程 / 报错 / 拒绝)
  - `status: waiting` + `waitingFor === "permission prompt"` 时 resume 后 sendSDKMessage 的行为(权限提示是否会被跳过或排队)

**v2.2 缓解**:
- Reply 守卫限定只在 `status === "waiting"`(真正需要输入的状态)
- **v2.1 新增**:Step B 二次状态守卫(发文本那一刻再查 status),解决 waiting → busy 转换 race
- Attach 到 busy session 时加 `⚠️ 正在处理中` 提示,让用户知情
- 失败时 graceful 报错,不动 supervisor
- 真实环境手测验证(DoD 包含 waiting 状态 reply 和 idle 状态 attach 测试)
- 如需更深集成,v3 探索 supervisor 协议(Anthropic 不承诺 API 稳定性)

### R2 — Claude 版本边界(中)

**风险**:Agent View 在 research preview,接口可能变。`claude agents --json` 字段名、状态字符串可能调整。

**v2.2 修正**:官方文档确认 JSON 有 3 态(`busy` / `waiting` / `idle`),TUI 的 6 态(Working / Needs input / Idle / Completed / Failed / Stopped)是界面分组。v2.1 之前误以为 JSON 只有 2 态,导致 `waiting` 被遗漏。如果未来 Anthropic 加新状态,我们的映射可能失真。

**缓解**:
- snapshot.ts 解析失败不抛错,只显示错误卡
- 类型定义集中在一个文件,改起来范围可控
- 走 `claude --version` 守卫,提示用户升级
- **v2 新增**:在 `snapshot.ts` 加 "unknown status" 分支,fallback 到"未知状态"显示,不抛错

### R3 — 卡片大小(低)

**风险**:cwd 全路径 + 大量会话可能撑爆 25KB(沿用 `stream.max_card_bytes`)。

**缓解**:
- 列表上限 10 个会话 + 折行
- 估算每会话 250B,10 个 ~3KB,加上 header/footer ~3.5KB,远低于 25KB
- `shouldFallbackToText` 兜底

### R4 — 多飞书用户竞争(中)

**风险**:多个飞书用户可能 reply 同一 session。

**缓解**:
- 现有 `ClaudeSessionManager.sessionLocks` 串行化(已实现,见 `src/proxy/session.ts` `acquireSessionLock` / `releaseSessionLock`)
- 列表对所有用户显示相同内容(N11 暂不做隔离)

### R5 — 旧版 CLAUDE Code 兼容性(中)

**风险**:用户从老版本升级到 v0.3.4 后,`agent view` 命令可用但 `claude` CLI 未必 ≥ 2.1.139。

**缓解**:`/agents` 入口处先做 version 守卫,降级提示清晰。

### R6 — 飞书 ↔ 终端(或两个飞书客户端)并发 reply(中)

**风险**:同一 background session 同时被:
- (a) 飞书 reply + 终端 `claude attach`(用户分心)
- (b) 两个飞书用户同时 reply(单机部署不常见但可能)

官方文档只说 supervisor "starts a fresh process from where it left off",**未明说**两个客户端并发输入时如何仲裁。可能:两个 client 都被注入成功(状态分叉)、第二个被丢弃、supervisor 报错。

**缓解(v2.2 诚实化,避免过度承诺)**:
- `ClaudeSessionManager.sessionLocks` 按 sessionId 串行化 sendSDKMessage,**仅对飞书侧 cc-linker 内部发起的 reply 生效**;不阻止 supervisor 内部或终端 `claude attach` 触发的并发
- 飞书 reply 进行中,Activity Marker 写入 `~/.cc-linker/activity/<uuid>.log`(`start` / `heartbeat` / `end`),**只解决"可见性"**,不解决"协调":终端 `claude` 用户能从 activity log 看到"飞书正在用这个 session",但 supervisor 不会拒绝终端的 `claude attach`
- 终端用户主动 `claude attach` 跟飞书 reply 并发时,行为取决于 supervisor(spec 诚实标注,**本版不解决**):可能两个 client 都被注入成功(状态分叉),第二个被丢弃,或 supervisor 报错
- 多个飞书用户对同一 session 互发 reply 会被 sessionLocks 串行化(G2 已实现),但如上所述 supervisor 内部行为未明

**下个版本候选方案**:
- 读 supervisor 的 `daemon.log` 探测其他客户端活动
- 实现自定义 supervisor-side watcher
- 这部分工作量较大,且 Anthropic 不保证协议稳定

### R7 — 同 openId 多飞书客户端并发(v2.1 新增,中)

**风险**:同一用户(`owner_open_id` 白名单内)同时在手机 + PC 两个飞书客户端使用 /agents。

**场景**:
- 客户端 A 看到 session X `waiting`,点 [Reply],进 expectedReply 状态
- 客户端 B 同时点 [Refresh] 看到同一列表,显示 session X `waiting`(信息一致)
- 客户端 B 也点 [Reply],第二个 expectedReply 会**覆盖**第一个
- 客户端 A 发文本,被 B 的 expectedReply 状态吞掉,实际 reply 进了 B 的 session

**缓解(本版)**:
- expectedReply 状态是 per-`openId`(不是 per-client,v2.2 明确设计选择),先到先得
- 后到的 [Reply] 请求 → 错误卡"另一端正在操作,请先在对方客户端取消"(通过 `compareAndSwap` 的 casToken 检测,见 §5.3 CAS 抢占)
- 持久化到 user-mapping.json 共享,bot 重启后状态一致
- **诚实化**:`[Refresh]` 看到的列表是基于"最近一次 fetch 快照" + "user-mapping 持久化状态",**不是实时**;两端的列表卡是各自独立的飞书消息,patch 操作只影响该 client 看到的卡
- **本版不解决**:多端 UI 实时同步(显示"另一端正在输入");列表跨端实时合并(只最后一次 [Refresh] 客户端的视图生效)

### R8 — expectedReply 状态丢失(v2.1 强化,低)

**风险**:用户点 [Reply] 后,bot 重启 / OOM / 异常退出,内存里的 expectedReply 标记丢失,用户 5 分钟后回来发文本,bot 走普通 chat,reply 永不投递。

**v2.1 缓解**:
- 持久化到 `user-mapping.json`,走 `proper-lockfile` 写盘
- **v2.1 明确字段**:`{ type: 'pending_agent_reply', shortId, sessionId, cwd, startedAt, timeoutMs, casToken }`
- **v2.1 明确启动恢复流程**:
  1. bot 启动时遍历 user-mapping 所有 entry
  2. 对 `pending_agent_reply` 类型,计算 `now - startedAt`
  3. 已超时:从 user-mapping 静默删除(不发任何 patch,避免对飞书已归档卡的无效操作)
  4. 未超时:in-memory 重建状态,setTimeout 等剩余时间触发 handleCancelReply
- 不在启动时 patch 列表卡(列表卡可能已被飞书归档几分钟,patch 会失败)

**v2.2 补:启动恢复的具体调用路径**(spec 之前漏了实现位置,容易成死代码):
- `FeishuBot.start()`(`src/feishu/bot.ts:bot.start`) 启动时,在 `startupReconcile()`(`src/runtime/reconciler.ts`)之后调 `agentViewManager.restoreExpectedReplyStates()`
- `AgentViewManager.restoreExpectedReplyStates()` 实现要点:
  ```
  for (const [openId, entry] of userManager.allEntries()) {
    if (entry.type !== 'pending_agent_reply') continue;
    const elapsed = Date.now() - new Date(entry.startedAt).getTime();
    if (elapsed >= entry.timeoutMs) {
      // 已超时,静默删除(不 patch,不发提示)
      await userManager.compareAndSwap(openId, entry, null);
    } else {
      // 未超时,重建 in-memory 状态
      this.inMemoryExpectedReplies.set(openId, entry);
      const remain = entry.timeoutMs - elapsed;
      setTimeout(() => this.handleCancelReply(openId, /*reason=*/'timeout', /*silentForUser=*/true), remain);
    }
  }
  ```
- **不在 handleChat 路径上做"启动后才发文本"的恢复**——用户发文本那一刻只查 in-memory + user-mapping,不会"回头看"启动前未恢复的 setTimeout
- **不需要在 `expected-reply-state.ts` 单独建 module 持久化文件**——所有 state 都在 user-mapping.json,启动恢复只需要一次遍历

### R9 — ANSI strip 漏处理特殊序列(v2 新增,低)

**风险**:`claude logs` 输出含多种 TTY 控制序列,简单 regex 可能漏掉:
- `\x1b[?25l` (光标隐藏)
- `\x1b[1;1H` (光标定位)
- `\x1b]0;title\x07` (OSC 终端标题)
- 多字节 UTF-8 中文字符夹在转义码之间(UTF-8 字节边界)

**缓解**:
- ansi-strip.ts 覆盖最常见的 5-6 类序列(CSI / OSC / DCS / 单字符 ESC)
- 单测 fixture 覆盖各种序列 + UTF-8 边界
- peek_max_bytes 兜底,即使 strip 不完美,内容也不会撑爆卡片

## 10. 测试策略

### 10.1 单元测试(`bun test`)

**新增/重写(v2.2)**:
- `snapshot.ts`:解析各种 JSON 形态(busy / waiting / idle / mixed / empty / invalid / **kind=interactive 混合**)
- `snapshot.ts`:版本守卫(2.1.138 / 2.1.139 / 2.1.200 / 字符串异常)
- `snapshot.ts`:**kind 过滤测试**——mixed JSON 只保留 kind=background
- `snapshot.ts`:**unknown status 分支测试**——遇到非 busy/waiting/idle 字符串不抛错
- `snapshot.ts`:**waitingFor 字段透传测试**——`status === "waiting"` 时 `waitingFor` 正确传递到卡片
- `ansi-strip.ts`:覆盖 CSI / OSC / DCS / 颜色码 / 光标控制 / UTF-8 边界
- `expected-reply-state.ts`:state machine 测试
  - 标记写入 / 读取 / 清除(in-memory + user-mapping 双写)
  - 5 分钟超时触发清除
  - `/cancel` 触发清除
  - **[取消] 按钮触发清除(v2 新增)**
  - **其他 `/` 命令触发自动取消(v2 新增)**
  - **bot 重启后从 user-mapping 恢复(v2 新增)**
  - 普通消息在 expectedReply 状态下走 handleReply 流程
  - 普通消息在无 expectedReply 状态下走普通 chat 流程
- `card.ts`:列表卡 / peek 卡 / 错误卡 / 等待中状态卡 / **停止确认卡(v2 新增)** / 超时卡 / 取消卡 JSON 结构 + 字节上限
- `action.ts`:action value 解析与路由(**9 种 tag,v2.2 调整**:增加 attach)
- `expected-reply-state.ts`:**CAS 抢占测试(v2.1 新增)**
  - handleReply 拿到 T0,handleCancelReply 同时拿 T0,只一个 CAS 成功
  - 失败方行为分两类:handleReply 失败 → patch"已取消" + 不发 reply;handleCancelReply 失败 → [静默] + 让 reply 继续
- `expected-reply-state.ts`:**Step B 二次守卫测试(v2.1 新增)**
  - mock status 从 waiting 变 busy,handleReply 应拒绝并 patch
  - mock status 从 waiting 变 idle,handleReply 应拒绝并 patch
  - mock session 不在 roster,handleReply 应拒绝并触发 refresh
- **`mapping-ext.ts`(v2.2 新增,§5.1 M1)**:`entriesMatch` 对新 type 行为单测
  - `pending_agent_reply` CAS:相同 `type / sessionUuid / cwd / casToken` 匹配,`shortId / startedAt / timeoutMs` 变化不影响 CAS(只用于 UI)
  - `last_agent_list_card` CAS:`sessionUuid=null / cwd=null` 必须能匹配
  - 互斥保证:同一 openId 从 `pending_agent_reply` CAS 写 `last_agent_list_card`,type 不等 → CAS 必然失败
  - 旧 type 兼容性:对 `pending_new_session` 等老 type 的 entriesMatch 行为不变(回归保护)
- `manager.ts`:**Attach 测试(v2.2 新增)**
  - Attach 成功:CAS 更新 UserManager,清除 expectedReply,发确认消息
  - Attach 到 busy session:确认消息含 `⚠️ 正在处理中` 提示
  - Attach 到 waiting session:确认消息透传 `waitingFor`
  - Attach 到消失的 session:错误卡 + 自动 refresh
  - Attach 时 CAS 失败:错误卡"状态冲突"

### 10.2 集成测试(`bun test`)

- mock `execFile` 返回固定 JSON,验证 `AgentViewManager` 各方法的调用链
- **mock `claude agents --json` 返回 kind=mixed JSON,验证只 background 出现在列表卡**(v2 关键测试)
- **mock `claude logs` 返回含 ANSI 的输出,验证 peek 卡渲染干净**(v2 关键测试)
- **mock `existsSync` 让 `~/.claude/daemon/roster.json` 不存在,验证"daemon 未运行"错误卡**(v2 新增)
- mock `sendSDKMessage` 注入可控流,验证 reply 卡状态切换
- **mock `claude agents --json` 返回 waiting 状态,验证列表卡正确分组和 Reply 按钮可见性**(v2.2 关键测试)
- **mock Attach 到不在 registry 的 session,验证绕过 registry 直接 CAS 绑定成功**(v2.2 关键测试)

### 10.3 测试 fixture

`tests/fixtures/agents-json/`(v2 重写,v2.1 加 kind-race,v2.2 加 waiting):
- `busy.json`:1 个 busy + 1 个 waiting(both background)
- `all-idle.json`:2 个 idle background
- `waiting.json`(**v2.2 新增**):1 个 waiting + `waitingFor: "input needed"` + 1 个 waiting + `waitingFor: "permission prompt"`
- `kind-mixed.json`:1 个 background busy + 1 个 interactive busy + 1 个 background waiting(**v2 修正,用 waiting 替代 idle**)
- `empty.json`:空数组
- `invalid.json`:格式错乱
- `kind-race.json`(**v2.1 新增,v2.2 修正**):同一 sessionId 在两次连续 mock 中,第一次 status=waiting + kind=background,第二次 status=busy + kind=background,模拟 waiting → busy 转换;用于 Step B 二次守卫测试
- `waiting-idle-race.json`(**v2.2 新增**):同一 sessionId,第一次 status=waiting,第二次 status=idle,模拟 waiting → idle 转换

`tests/fixtures/ansi-logs/`(v2 新增):
- `plain.txt`:纯文本,验证 strip 后一致
- `color.txt`:含 `\x1b[31m...\x1b[0m` 颜色码
- `cursor.txt`:含 `\x1b[2J\x1b[H` clear screen
- `progress.txt`:模拟进度条重绘
- `utf8.txt`:中文字符夹在转义码之间

`tests/fixtures/cas/`(v2.1 新增):
- `concurrent-reply-cancel.json`:mock 两次并发读 user-mapping + 写回,模拟 CAS 抢占
- `step-b-busy.json`:mock 第一次 `claude agents --json` 返回 waiting(Step A 守卫通过),第二次返回 busy(Step B 二次守卫触发)

### 10.4 手动验收(DoD 必做)

- 启 cc-linker
- 终端 `claude --bg "<长任务>"` 派发
- 飞书 `/agents` 看到列表(**只看到 background,主会话不出现**)
- 点 [Peek] 看输出(**ANSI 干净**)
- 让 Claude 进入 waiting 状态(原 "needs input"),飞书 [Reply] 按钮 → 列表卡 patch 为"等待输入"(含 `[取消]` 按钮) → 用户发文本消息 → 注入回答
- **点 [Attach] 按钮验证 Attach 流程(v2.2 新增)**:Attach 到 waiting session → 发确认消息 → 后续普通消息直接注入 → 发 /new 离开 → 再 Attach 回来
- **点 `[取消]` 按钮验证取消流程(v2 新增)**
- **点 busy 状态 session 的 [Stop] → 二次确认卡 → [✅ 确认停止] → 真正停掉(v2 新增)**
- 验证 Activity Marker 写到 `~/.cc-linker/activity/<uuid>.log`(自动,不需额外代码)
- 终端 `cat` 那个 log 确认
- **bot 重启后验证 expectedReply 状态从 user-mapping 恢复(v2 新增)**
- **关掉 claude daemon 后 /agents,看到"daemon 未运行"卡 + [🔄 重新检测] (v2 新增)**

## 11. 验收标准(Definition of Done)

### 功能性(v2.2 更新)

- [ ] `/agents` 在飞书可用,版本 < 2.1.139 时显示降级提示
- [ ] **`claude` daemon 未运行时显示专门错误卡 + [🔄 重新检测](v2 新增)**
- [ ] 列表卡只显示 `kind: "background"` 的 session,**主会话(`kind: "interactive"`)不出现(v2 关键修复)**
- [ ] **列表卡正确分组 busy / waiting / idle,空组不显示(v2.2 修正)**
- [ ] **列表卡显示 `waitingFor` 信息(v2.2 新增)**
- [ ] 列表卡显示名称、状态、耗时、cwd 摘要(PR 编号 v1 不显示)
- [ ] **[Attach] 绑定 session 为当前活跃 session,后续消息直接注入(v2.2 新增)**
- [ ] **[Attach] 绕过 registry 直接 CAS 绑定(v2.2 新增)**
- [ ] **[Attach] 清除 expectedReply 状态(v2.2 新增)**
- [ ] [Refresh] 按钮即时重拉,防抖 `refresh_min_interval_ms`
- [ ] [Peek] 抓取最近 `peek_lines` 行,**过 ANSI strip(v2 关键修复)**,渲染 peek 卡
- [ ] [Reply] 两步式:点按钮 → 列表卡 patch 为等待状态(含 `[取消]` 按钮) → 用户发文本消息 → 注入回答
- [ ] **[Reply] 在 `status: "waiting"` 时允许(v2.2 修正)**
- [ ] **[Reply] 在 `status: busy` / `status: idle` / session 不在 roster / `kind: interactive` 时被守卫拒绝,显示明确提示(v2.2 修正)**
- [ ] [Reply] 等待 5 分钟超时,自动清除 expectedReply 标记、**发独立提示文本**、patch 原卡
- [ ] [Reply] 等待期间用户发 `/cancel` 取消
- [ ] **[Reply] 等待期间用户点 `[取消]` 按钮取消(v2 新增)**
- [ ] **[Reply] 等待期间用户发其他 `/` 命令,自动清标记 + patch "已自动取消(v2 新增)"**
- [ ] [Reply] 等待期间用户发无关消息不被打断(走普通 chat)
- [ ] **[Reply] 等待期间用户发 `/` 写命令(/list /switch 等),自动清标记 + patch "已自动取消(v2.1 新增)"**
- [ ] **[Reply] 等待期间用户发 `/help` `/status` `/whoami` 只读命令,不清标记(v2.1 新增)**
- [ ] **[CAS 抢占:v2.1 新增] [取消] 和发文本几乎同时,只一个生效,失败方按规则降级**
- [ ] **[Step B 二次守卫:v2.1 新增] 发文本那一刻再查 status,busy/idle 拒绝 + patch 卡(v2.2 修正)**
- [ ] **[Stop] 在 `status: busy` 时需要二次确认(v2.1 改:二次确认是独立新卡,不 patch 列表)**
- [ ] **[Stop] 二次确认卡 [← 取消] 时列表卡原样保留(v2.1 新增)**
- [ ] [Stop] 真正停掉 session,完成后自动刷新列表
- [ ] 同一 session 的并发 reply 走 `sessionLocks` 串行化(已实现,验证即可)
- [ ] Activity Marker 写入,格式与 session-activity-sync design 一致(已实现,验证即可)
- [ ] **expectedReply 状态持久化到 user-mapping.json,走 `proper-lockfile`,bot 重启可恢复(v2.1 明确)**
- [ ] **列表卡 messageId 持久化到 user-mapping.json(v2.1 明确)**
- [ ] **空状态卡 [💬 回到普通聊天] 点击后发独立文本消息(v2.1 新增)**
- [ ] **无 background session 时显示空状态卡(v2.2 补验收项,§6.1 设计)**: `claude agents --json` 返回空数组时,飞书侧收到空状态卡(含 [💬 回到普通聊天] 和 [🔄 Refresh] 两个按钮),而不是报错或显示无意义的空列表
- [ ] **filter 把 `kind: "interactive"` 主会话全部过滤掉后背景仍为空时,空状态卡文案准确**(不显示"暂无 background session",而是"暂无后台会话",与 daemon 未运行卡区分)
- [ ] 卡片 body 永远不超 25KB(沿用 `stream.max_card_bytes`),触顶走文本 fallback
- [ ] `agent_view.enabled = false` 时 `/agents` 返回 "已禁用"

### 工程性

- [ ] `bun run typecheck` 通过
- [ ] `bun test` 全绿,新单测覆盖:
  - snapshot kind 过滤
  - ANSI strip 各种序列
  - expectedReply 状态机全分支
  - **CAS 抢占(v2.1 新增)**
  - **Step B 二次守卫(v2.1 新增)**
  - stop 二次确认(独立新卡,不 patch 列表)
  - **`/` 命令白名单(v2.1 新增)**
  - **9 种 action tag 路由(v2.2 调整,增加 attach)**
  - **waiting 状态解析和 `waitingFor` 透传(v2.2 新增)**
  - **Attach CAS 绑定和确认消息(v2.2 新增)**
- [ ] README.md / README_en.md 新增 "Agent View" 章节
- [ ] CLAUDE.md Important Files 表加 `src/agent-view/`
- [ ] CLAUDE.md High-Level Architecture 章节提及 `claude agents --json` 实际接口
- [ ] 手动验收完整端到端场景通过(派发→waiting→飞书 reply→cancel→attach→stop 二次确认(独立卡)→bot 重启恢复)

## 12. 文档更新

- `docs/superpowers/specs/2026-06-01-feishu-agent-view-design.md`(本文档)
- `README.md` / `README_en.md` 新增 "Agent View" 章节,展示命令、卡片示例图、配置说明
- `CLAUDE.md` "Important Files" 表加 `src/agent-view/`
- `docs/agent-view.md`(可选,放完整用户手册)

## 13. 参考

- Claude Code Agent View 文档:https://code.claude.com/docs/en/agent-view
- Claude Agent SDK:https://docs.anthropic.com/en/api/agent-sdk/overview
- `docs/session-activity-sync-design.md`(复用 Activity Marker 设计)
- `docs/superpowers/specs/2026-05-24-feishu-permission-interaction-design.md`(sendSDKMessage 现有用法)

**v2 新增引用(实现时直接对照当前代码)**
- `src/proxy/session.ts` — `ClaudeSessionManager.sendSDKMessage` 方法(签名与流式回调契约,约第 714 行起)
- `src/proxy/session.ts` — `acquireSessionLock` / `releaseSessionLock`(reply 自动串行化,约第 927 行起)
- `src/utils/session-activity.ts:97-143` — `writeActivityMarker` 格式(已在 sendSDKMessage 内部自动调用)
- `src/feishu/card-updater.ts` — `CardUpdater` 类(流式卡 + 权限卡完整 API,Agent View reply 复用)
- `src/feishu/bot.ts` — `handleCardAction` 现有 `switch (tag)` 分派模式(新增 9 个 agent_view_* case,约第 438 行起)
- `src/feishu/mapping.ts` — `UserManager` CAS 接口(复用存 expectedReply 状态到 user-mapping.json)
- `~/.claude/daemon/roster.json` — Claude daemon 运行列表(daemon 未运行 = 文件不存在)

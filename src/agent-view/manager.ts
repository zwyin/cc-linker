import type { UserManager, MappingEntry } from '../feishu/mapping';
import { AgentSnapshotFetcher } from './snapshot-fetcher';
import { ExpectedReplyState } from './expected-reply-state';
import { buildListCard, buildPeekCard, buildErrorCard, buildEmptyCard, buildWaitingCard, buildStopConfirmCard, buildLoadingPeekCard, buildAttachedCard } from './card';
import { AttachedWatchers } from './attached-card-watcher';
import type { AgentSession, AgentSessionGroup, AgentSessionStatus } from './types';
import { groupByStatus } from './types';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { extractRecentAssistantText } from './jsonl-peek';
import { JsonlIndex } from './jsonl-name';
import { readRoster, lookupResumeFromPath } from './roster-source';
import { readJobState } from './job-state';

/** Maximum list-card byte size. 飞书 card 25KB 上限;超过走 text fallback。 */
const MAX_CARD_BYTES = 25_000;
/** 列表 fallback 文本:卡超 25KB 时降级。 */
const LIST_FALLBACK_TEXT = (n: number) => `📋 Agent View · ${n} sessions · /agents to refresh`;
/** v2.3.2 截断策略:completed 组的最多行数。waiting/busy/idle 不受此限,优先展示。 */
const MAX_COMPLETED_ITEMS = 5;

/**
 * v2.3.2 截断:旧 `slice(0, 10)` 在 groupByStatus 前一刀切,completed 组"重"挤掉
 * working(例如 1+7 active + 11 completed = 19 → 前 10 里有 5 个 completed,
 * working 只剩 4 个,3 个被推到 ... N more 后面,跟 TUI 看到的 7 working
 * 不一致)。新策略:先 groupByStatus → 各 group 内按 startedAt 倒序 → waiting/busy
 * 全部进,completed 限额到 MAX_COMPLETED_ITEMS(5)。剩余 completed 计 hasMore。
 */
function buildCappedCard(sessions: AgentSession[], totalSessions: number): {
  card: string;
  hasMore: number;
} {
  const groupsAll = groupByStatus(sessions);
  const sortByRecency = (arr: AgentSession[]) =>
    [...arr].sort((a, b) => b.startedAt - a.startedAt);
  const busySorted = sortByRecency(groupsAll.busy);
  const waitingSorted = sortByRecency(groupsAll.waiting);
  const completedSorted = sortByRecency(groupsAll.completed);
  const completedCapped = completedSorted.slice(0, MAX_COMPLETED_ITEMS);
  const groups: AgentSessionGroup = {
    busy: busySorted,
    waiting: waitingSorted,
    idle: groupsAll.idle,
    completed: completedCapped,
  };
  const hasMore = Math.max(
    0,
    totalSessions - busySorted.length - waitingSorted.length - groupsAll.idle.length - completedCapped.length,
  );
  return {
    card: buildListCard(groups, new Date().toLocaleTimeString(), hasMore),
    hasMore,
  };
}

export interface AgentViewDeps {
  userManager: UserManager;
  feishuClient?: any;
  replyFn: (text: string, opts: { openId: string; messageId?: string }) => Promise<string | null>;
  cardReplyFn: (card: string, opts: { openId: string; messageId?: string }) => Promise<string | null>;
  patchFn: (messageId: string, card: string) => Promise<any>;
  runChatSDK: (params: {
    openId: string; sessionUuid: string; cwd: string;
    promptText: string; serialKey: string; isNew?: boolean;
    settingsPath?: string; messageId?: string;
    /** v2.3.5: 标记 AgentView reply 路径,bot 会自动 stop bg + 递归 SDK */
    fromAgentViewReply?: boolean;
  }) => Promise<{ result: any; handler: any; cardMessageId: string | null }>;
  expectedReplyTimeoutMs?: number;
}

export class AgentViewManager {
  readonly expectedReply: ExpectedReplyState;
  readonly attachedWatchers: AttachedWatchers;
  private minRefreshIntervalMs = 2000;
  private lastRefreshAt = 0;

  constructor(public deps: AgentViewDeps) {
    this.expectedReply = new ExpectedReplyState(
      deps.userManager,
      deps.expectedReplyTimeoutMs ?? 300_000
    );
    this.attachedWatchers = new AttachedWatchers(
      () => deps.patchFn,  // 修 3: getter,每次取最新值,适配 start.ts:417 后续替换
      (shortId, maxChars) => this.resolvePeekContent(shortId, maxChars),
    );
  }

  /** /agents 命令入口 — 抓取快照并发送列表卡;持久化 cardMessageId 以便后续 refresh patch */
  async handleList(openId: string, _msgMessageId?: string): Promise<void> {
    const result = await AgentSnapshotFetcher.fetch();
    if (!result.ok) {
      const card = buildErrorCard({ title: 'Agent View 错误', body: result.reason });
      await this.deps.cardReplyFn(card, { openId });
      return;
    }
    const totalSessions = result.sessions.length;
    if (totalSessions === 0) {
      const card = buildEmptyCard();
      await this.deps.cardReplyFn(card, { openId });
      return;
    }
    // v2.3.2:截断逻辑(active 优先 + completed 限额)抽到 module-level helper,
    // handleList 和 handleRefreshList 共用。
    const { card } = buildCappedCard(result.sessions, totalSessions);
    const cardMessageId = await this.sendOrFallback(
      card,
      { openId },
      LIST_FALLBACK_TEXT(totalSessions),
      openId,
    );
    if (cardMessageId) {
      // 保存 cardMessageId 到 user-mapping(last_agent_list_card)
      // 供 handleRefreshList 校验 messageId 时使用
      await this.deps.userManager.compareAndSwap(openId, null, {
        type: 'last_agent_list_card',
        sessionUuid: null,
        createdAt: new Date().toISOString(),
        cardMessageId,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  // ── Card action handlers (dispatched from FeishuBot.handleCardAction) ──
  // Full implementations land in T14-T22. These stubs keep the bot's
  // dispatch typecheck-clean while the real handlers are being written;
  // calling them before T14-T22 throws so we notice in QA.

  /**
   * Refresh 列表卡 — 校验 messageId 匹配 user-mapping 中的 last_agent_list_card,
   * 校验通过则 patch 原卡;校验失败则发新卡(避免误 patch 已被覆盖的旧卡)。
   */
  async handleRefreshList(openId: string, messageId?: string): Promise<string | null> {
    if (!messageId) return null;
    if (!this.shouldRefresh()) return null;
    // v2.2 修正:校验 messageId 匹配 last_agent_list_card.cardMessageId
    // 防止用户从飞书历史消息点 [Refresh](旧 messageId 已 patch 过),误 patch 错卡片
    const entry = this.deps.userManager.getEntry(openId);
    if (entry?.type !== 'last_agent_list_card' || entry.cardMessageId !== messageId) {
      // 校验失败:发新列表卡(覆盖原 cardMessageId 记录)
      await this.handleList(openId);
      return null;
    }
    const result = await AgentSnapshotFetcher.fetch();
    if (!result.ok) {
      // patch 错误卡
      const card = buildErrorCard({
        title: 'Refresh 失败',
        body: result.reason,
        refreshButton: true,
      });
      await this.deps.patchFn(messageId, card);
      return null;
    }
    const totalSessions = result.sessions.length;
    if (totalSessions === 0) {
      const card = buildEmptyCard();
      await this.deps.patchFn(messageId, card);
      return null;
    }
    // v2.3.2:同 handleList 截断逻辑(抽出 helper)
    const { card, hasMore } = buildCappedCard(result.sessions, totalSessions);
    void hasMore;  // refresh 路径忽略 hasMore(已被 buildListCard 内部消化)
    // G11:超 25KB 走 text fallback;用 replyFn 代替 patchFn(无法 patch 一个新消息)
    const size = new TextEncoder().encode(card).length;
    if (size > MAX_CARD_BYTES) {
      await this.deps.replyFn(LIST_FALLBACK_TEXT(totalSessions), { openId });
      return null;
    }
    await this.deps.patchFn(messageId, card);
    return null;
  }

  /** Find a session in the latest snapshot by sessionId. Returns null if absent. */
  private async findSession(_openId: string, sessionId: string): Promise<AgentSession | null> {
    const result = await AgentSnapshotFetcher.fetch();
    if (!result.ok) return null;
    return result.sessions.find(s => s.sessionId === sessionId) ?? null;
  }

  /**
   * v2.2.8: 解析 Peek 卡的 Recent output 内容。
   *
   * 数据源优先级:
   *   1) bg session 自己的 JSONL 最后一条 assistant 文本(本地 markdown,飞书直接渲染)
   *   2) roster.dispatch.launch.sessionId 指向的 parent JSONL 最后 assistant 文本
   *      (fork-from-active 场景:bg session 自己的 JSONL 只有 metadata)
   *   3) 退化:`claude logs <short>` raw 输出 + ANSI strip,加入"原始终端片段"提示
   *
   * 返回 `{ text, format }`:
   *   format='markdown' — 直接 markdown 渲染(干净)
   *   format='terminal' — 走 code-block + 提示这是 raw 终端片段(可能有 tofu)
   *   text=null — 三层都没拿到东西
   *
   * @internal _peekHooks 用于测试 swap 各层依赖
   */
  async resolvePeekContent(
    shortId: string,
    maxChars: number,
  ): Promise<{ text: string | null; format: 'markdown' | 'terminal' }> {
    // Tier 1a (v2.3):state.json.linkScanPath 直达(blocked / done 时有值)
    //   优先于满磁盘扫,延迟 + 准确度都更好
    const env = await AgentViewManager._peekHooks.readJobState(shortId);
    const linkScanPath = env?.state?.linkScanPath ?? null;
    if (linkScanPath) {
      const text = AgentViewManager._peekHooks.extractRecentAssistantText(linkScanPath, maxChars);
      if (text) return { text, format: 'markdown' };
    }
    // Tier 1b: 自己的 JSONL(running/working 时 linkScanPath 空,降级到满磁盘扫)
    const ownPath = AgentViewManager._peekHooks.findJsonlForShort(shortId);
    if (ownPath) {
      const text = AgentViewManager._peekHooks.extractRecentAssistantText(ownPath, maxChars);
      if (text) return { text, format: 'markdown' };
    }
    // Tier 2: roster 的 resume-from parent JSONL
    const roster = AgentViewManager._peekHooks.readRoster();
    const parentPath = roster ? AgentViewManager._peekHooks.lookupResumeFromPath(roster, shortId) : null;
    if (parentPath) {
      const text = AgentViewManager._peekHooks.extractRecentAssistantText(parentPath, maxChars);
      if (text) return { text, format: 'markdown' };
    }
    // Tier 3: 老的 claude logs 退化(尽量避免)
    try {
      const cp = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileP = promisify(cp.execFile);
      const r = await execFileP('claude', ['logs', shortId], { timeout: 3000 });
      const { stripAnsi } = await import('./ansi-strip');
      const stripped = stripAnsi(r.stdout);
      const peekLines = config.get<number>('agent_view.peek_lines', 30);
      const tail = stripped.split('\n').slice(-peekLines).join('\n');
      const truncated = truncateBytes(tail, maxChars);
      if (truncated.trim()) return { text: truncated, format: 'terminal' };
    } catch {
      // ignore, fall through
    }
    return { text: null, format: 'markdown' };
  }

  // v2.2.8: 注入点 —— tests 通过 swap 这些函数模拟各层命中/miss
  // 走 mutable object(不是 ESM 命名空间),绕开 bun mock.module 跨文件限制
  // v2.3: 加 readJobState 让 Tier 1a 也可被测试 swap
  static _peekHooks = {
    findJsonlForShort: (short: string): string | null => {
      const idx = new JsonlIndex();
      return idx.lookup(short);
    },
    extractRecentAssistantText,
    readRoster,
    lookupResumeFromPath,
    readJobState,
  };

  /**
   * /agents 列表卡 → [Peek] 按钮入口。
   * v2.2.8: Recent output 改从 JSONL 提取最后一条 assistant markdown 文本,
   * 不再用 `claude logs` 的 raw 终端 buffer(含光标定位 + box-drawing,飞书渲染成 tofu □)。
   * 见 resolvePeekContent。
   */
  async handlePeek(
    openId: string,
    shortId: string,
    sessionId: string,
    cwd: string,
  ): Promise<string | Record<string, unknown> | null> {
    const session = await this.findSession(openId, sessionId);
    if (!session) {
      await this.deps.replyFn('⚠️ 会话已不存在', { openId });
      return null;
    }
    const peekMaxBytes = config.get<number>('agent_view.peek_max_bytes', 2048);
    const peek = await this.resolvePeekContent(shortId, peekMaxBytes);
    const truncated = peek.text ?? '(无可用输出)';
    const buttons = {
      peek: true,
      attach: true,
      reply: session.status === 'waiting',
      stop: session.status === 'busy',
      refresh: true,
    };
    const card = buildPeekCard({
      name: session.name,
      status: session.status,
      completed: session.completed,
      waitingFor: session.waitingFor,
      shortId,
      sessionId,
      cwd,
      pid: session.pid,
      startedAt: session.startedAt,
      recentOutput: truncated,
      outputFormat: peek.format,
      buttons,
    });
    return await this.sendOrFallback(
      card,
      { openId },
      `🔍 Peek · \`${session.name}\` · /agents 刷新列表`,
      openId,
    );
  }

  /**
   * Peek 卡 → [Refresh] 按钮入口。
   *
   * v2.2.20 关键修复:**必须 sync 返回 loading card object,不能 null**。
   *
   * 原因:start.ts:508 在 reply 为 null/string 时回 `return { type: 'raw', data: {} }`
   * 给飞书。实测(2026-06-08 23:09)这种空响应会让飞书把卡片 revert 到最初
   * 创建时的内容 → 用户报告"新内容先看到,然后被旧内容覆盖"。
   *
   * 修复:返回 sync loading card(飞书立即渲染),1.2s 后 async patch 替换为
   * 真数据(避开飞书 card action event lock + update_multi:true 保证替换
   * 生效)。
   */
  async handleRefreshPeek(
    openId: string,
    shortId: string,
    sessionId: string,
    messageId?: string,
  ): Promise<string | Record<string, unknown> | null> {
    if (!messageId) return null;
    // 2s debounce:防止用户对同一 Peek 卡快速连点 Refresh
    // (实测日志 11:25-11:27 期间 10 次),避免多次 patch 排队叠加 1200ms 延迟
    // 导致 patch 顺序不可控,Feishu 客户端把早到(synthetic 内容)的 patch
    // 渲染为终态——表现为 "原卡片内容覆盖" 现象。
    if (!this.shouldRefresh()) return null;

    // 同步做基础 session 校验(用于给 sync loading card 一个名字)
    // 用 try/catch 包裹:如果 snapshot fetch 失败,fallback 通用 loading card
    let sessionName = shortId;
    try {
      const session = await this.findSession(openId, sessionId);
      if (!session) {
        // session 已不存在:直接 sync 返回错误卡,无需 async patch
        return JSON.parse(
          buildErrorCard({
            title: '⚠️ 会话已不存在',
            body: '已自动刷新列表',
          }),
        );
      }
      sessionName = session.name;
    } catch {
      // snapshot 拉取失败也走 loading card 路径(用户至少能看到个反馈)
    }

    // Fire-and-forget:在 background 跑真正的数据拉取 + patch
    // 不 await —— bot 会把 sync 返回的 loading card 立即发给飞书
    void this._doRefreshPeek(openId, shortId, sessionId, messageId, sessionName);

    // Sync 返回 loading card(飞书立即渲染,1.2s 后被真数据 patch 替换)
    return JSON.parse(buildLoadingPeekCard({ name: sessionName, shortId, sessionId }));
  }

  /**
   * v2.2.20: handleRefreshPeek 的 background work。
   * 1.2s 后用真数据 patch Peek 卡,叠加 update_multi:true 让飞书正常替换内容。
   */
  private async _doRefreshPeek(
    openId: string,
    shortId: string,
    sessionId: string,
    messageId: string,
    sessionName: string,
  ): Promise<void> {
    try {
      const peekMaxBytes = config.get<number>('agent_view.peek_max_bytes', 2048);
      const peek = await this.resolvePeekContent(shortId, peekMaxBytes);
      const truncated = peek.text ?? '(无可用输出)';
      // 这里 findSession 之前已经跑过一次(在 sync 路径),但为保险起见再拉一次
      const session = await this.findSession(openId, sessionId);
      if (!session) return;
      const buttons = {
        peek: true,
        attach: true,
        reply: session.status === 'waiting',
        stop: session.status === 'busy',
        refresh: true,
      };
      const card = buildPeekCard({
        name: session.name,
        status: session.status,
        completed: session.completed,
        waitingFor: session.waitingFor,
        shortId,
        sessionId,
        cwd: session.cwd,
        pid: session.pid,
        startedAt: session.startedAt,
        recentOutput: truncated,
        outputFormat: peek.format,
        buttons,
      });
      // G11:超 25KB 走 text fallback(无法 patch 时发新文本)
      const size = new TextEncoder().encode(card).length;
      if (size > MAX_CARD_BYTES) {
        await this.deps.replyFn(
          `🔍 Peek · \`${sessionName}\` · /agents 刷新列表`,
          { openId },
        );
        return;
      }
      await this.deps.patchFn(messageId, card);
    } catch (err: any) {
      logger.warn(`_doRefreshPeek failed: shortId=${shortId}, err=${err?.message ?? err}`);
    }
  }

  /**
   * Step A: 二次确认(发独立卡)
   * 当用户点 [Stop] 按钮时,先弹一张红色确认卡,避免误触。
   * 卡内带 [确认停止] 按钮触发 handleStopConfirm(T21)。
   */
  async handleStop(
    _openId: string,
    shortId: string,
    sessionId: string,
    name: string,
  ): Promise<string | Record<string, unknown> | null> {
    const card = buildStopConfirmCard(name, shortId, sessionId);
    return await this.deps.cardReplyFn(card, { openId: _openId });
  }

  /**
   * Step B: 真执行 `claude stop <shortId>` + 等 1s + 刷新列表。
   * 失败时回复 `❌ Stop 失败:<err>`。
   */
  async handleStopConfirm(
    openId: string,
    shortId: string,
    _sessionId: string,
    _messageId?: string,
  ): Promise<string | null> {
    try {
      const cp = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileP = promisify(cp.execFile);
      try {
        await execFileP('claude', ['stop', shortId], { timeout: 5000 });
      } catch (err: any) {
        // v2.2.19 fix: session 在用户点确认前已自然 settle 时,
        // `claude stop` 报 "No job matching" — 这是成功,不是失败。
        const errMsg = err?.stderr || err?.message || String(err);
        if (!/No job matching/i.test(errMsg)) {
          throw err;
        }
      }
      // 等 supervisor 收尾
      await new Promise(r => setTimeout(r, 1000));
      await this.deps.replyFn(`✅ 已停止 ${shortId}`, { openId });
      // 重新拉并 patch 列表卡
      await this.handleList(openId);
      return null;
    } catch (err: any) {
      await this.deps.replyFn(`❌ Stop 失败:${err.message}`, { openId });
      return null;
    }
  }

  /**
   * Attach 到一个 background session。
   * v2.2 关键:必须用**两步 CAS**:
   *   1. 清旧 entry(如果有)→ entriesMatch(oldEntry, null) 在 entriesMatch 中
   *      视为 (non-null, null) 不匹配,所以不能直接 CAS(null → new)。
   *   2. 写新 session entry。
   * 保留旧 entry 的 defaultProvider(用户级配置,不应因 attach 重置)。
   * 失败:实时守卫(会话已不存在)/ CAS 冲突。
   */
  async handleAttach(
    openId: string,
    sessionId: string,
    shortId: string,
    name: string,
    cwd: string,
  ): Promise<string | Record<string, unknown> | null> {
    // v2.2.15: 比较守卫同时认 short 和 full UUID,避免 v2.2.14 把 short 展开成
    // full 后跟 snapshot 里的 full UUID 比较反而失配的回归(实测 card 给的 sessionId
    // 是 short,snapshot 里的 sessionId 是 full —— 两者展开成同一个 full 时看似一致,
    // 但顺序问题: 展开前是 "098639ad" vs "098639ad-9be0-...",不等;展开后是
    // "098639ad-9be0-..." vs "098639ad-9be0-...",相等 —— 但展开前守卫已经失败)。
    // 解决: 守卫里同时接受 short 和 full,把 sessionId 存 UserManager 之前
    // 才正式展开成 full。
    const idx = new JsonlIndex();
    let fullUuid: string | null = null;
    if (/^[0-9a-f]{8}$/.test(sessionId)) {
      const jsonlPath = idx.lookup(sessionId);
      if (jsonlPath) {
        const base = jsonlPath.split('/').pop() ?? '';
        const extracted = base.replace(/\.jsonl$/, '');
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(extracted)) {
          fullUuid = extracted;
        }
      }
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) {
      fullUuid = sessionId;
    }
    // 0. 实时守卫(snapshot 里的 sessionId 可能是 short 或 full,都得认)
    const result = await AgentSnapshotFetcher.fetch();
    if (
      !result.ok ||
      !result.sessions.find(s => s.sessionId === sessionId || (fullUuid && s.sessionId === fullUuid))
    ) {
      await this.deps.replyFn('⚠️ 会话已不存在', { openId });
      return null;
    }
    // 进入 CAS 阶段前,正式把 sessionId 替换成 full UUID,后续 UserManager
    // 写入和 SDK 调用都走 full,免得 SDK 拒 short("Provided value ... is not a UUID")
    if (fullUuid) sessionId = fullUuid;
    // v2.2.19 修正:expectedReply.clear 必须在 CAS 1 成功之后调用。
    // 旧逻辑(L415-418)在 CAS 1 之前就 clear — 如果 CAS 1 失败,用户的 pending reply
    // 已经丢失且无法恢复。新逻辑:CAS 1 成功后再 clear(CAS 1 已 null 掉 entry,
    // clear() 只清 in-memory + timer;若 CAS 1 失败则 expectedReply 完整保留)。
    const oldEntry = this.deps.userManager.getEntry(openId);
    const wasPendingReply = oldEntry?.type === 'pending_agent_reply';
    // 1. CAS 1: 清旧 entry
    const currentEntry = this.deps.userManager.getEntry(openId);
    if (currentEntry) {
      const ok1 = await this.deps.userManager.compareAndSwap(openId, currentEntry, null);
      if (!ok1) {
        await this.deps.replyFn('⚠️ 状态冲突,请重试', { openId });
        return null;
      }
    }
    // CAS 1 成功 → 安全清除 expectedReply 本地状态
    if (wasPendingReply) {
      await this.expectedReply.clear(openId, 'overwrite');
    }
    // 3. CAS 2: 写新 session entry
    const newEntry: MappingEntry = {
      type: 'session',
      sessionUuid: sessionId,
      cwd,
      createdAt: new Date().toISOString(),
      // 保留用户级 defaultProvider,不要因 attach 丢失
      defaultProvider: oldEntry?.defaultProvider,
    };
    const ok2 = await this.deps.userManager.compareAndSwap(openId, null, newEntry);
    if (!ok2) {
      await this.deps.replyFn('⚠️ 状态冲突,请重试', { openId });
      return null;
    }
    // 4. 发确认文本(busy/waiting 状态加提示)
    const session = result.sessions.find(s => s.sessionId === sessionId)!;
    const warning = session.status === 'busy' ? '\n⚠️ 该 session 正在处理中' : '';
    const waitingInfo =
      session.status === 'waiting' && session.waitingFor
        ? `\n等待原因: ${session.waitingFor}`
        : '';
    // v2.2.11: 探测到 live bg worker 时,预警 attach 后发消息会被拒绝卡阻拦,
    // 避免用户后面莫名其妙看到冲突卡才反应过来。settled session 不显示该提示。
    let bgWorkerNotice = '';
    try {
      const { readRoster } = await import('./roster-source');
      const roster = readRoster();
      const short = sessionId.slice(0, 8);
      if (roster?.workers?.[short]) {
        bgWorkerNotice =
          `\n\n⚠️ 该 session 仍有 bg worker 在跑。直接发消息会被阻拦(避免与 worker ` +
          `并发改 cwd 文件),弹卡询问 [🛑 停 bg 后继续发送] / [🌿 开新会话发送] / ` +
          `[❌ 取消]。`;
      }
    } catch {
      // graceful: roster 读不到就不显示警示
    }
    await this.deps.replyFn(
      `📎 已 Attach 到 \`${session.name}\`${warning}${waitingInfo}\n` +
        `Status: ${session.status} · CWD: ${cwd}\n` +
        `💡 提示:发 /new 创建新会话,或 /agents 返回列表。${bgWorkerNotice}`,
      { openId },
    );
    // === 新增:Attach 后自动启动 watch + 发首张 attached 卡 ===
    const peekMaxBytes = config.get<number>('agent_view.peek_max_bytes', 2048);
    const peek = await this.resolvePeekContent(shortId, peekMaxBytes);
    const initialCard = buildAttachedCard({
      name: session.name, status: session.status, completed: session.completed,
      waitingFor: session.waitingFor, shortId, sessionId,
      cwd, recentOutput: peek.text ?? '(无可用输出)',
      outputFormat: peek.format, lastWatchedAt: new Date().toLocaleTimeString(),
    });
    const cardMessageId = await this.sendOrFallback(
      initialCard,
      { openId },
      `📡 Watching · \`${session.name}\` · /agents 查看`,
      openId,
    );
    if (cardMessageId) {
      await this.attachedWatchers.start(openId, {
        sessionId, shortId, name: session.name, cwd, cardMessageId,
      });
    }
    return null;
  }

  /**
   * v2.2.11 + v2.2.13 + v2.2.18: bg-conflict 拒绝卡 → [🛑 停 bg 后继续发送] 按钮。
   *
   * v2.2.13 关键修正:**总是 fallback 到 parent**(除非没 parent)。
   * v2.2.18 关键修正:**立刻 return null**。整个 stop+wait+SDK 链耗时常 > 3s,飞书
   * card action callback 窗口 ~3s 就会报"目标回调服务超时未响应"。改为:
   *   1) 同步只做"ack patch"(把拒绝卡 patch 成"已停止,发送中..."),亚秒级返回
   *   2) void fire-and-forget _doStopAndSend(...) 跑实际工作
   *   3) 整个 _doStopAndSend 链路内的 patchFn / runChatSDK 自己管自己的卡片更新
   */
  handleStopAndSend(
    openId: string,
    shortId: string,
    sessionId: string,
    cwd: string,
    text: string,
    parentUuid: string,
    hasParent: boolean,
    messageId?: string,
  ): null {
    // Step 1: 立刻 ack —— 把拒绝卡 patch 成"已停止,发送中..."。同步走,
    // 亚秒级返回,让飞书 card action callback 不会超时。
    if (messageId) {
      try {
        // 用 fire-and-forget patch —— 飞书 patch 也可能慢,但失败可接受
        // (后续 SDK 流式 patch 会再覆盖此卡)。
        this.deps
          .patchFn(
            messageId,
            buildErrorCard({
              title: '🛑 bg worker 已停止',
              body: '正在发送你的消息...',
            }),
          )
          .catch(() => {});
      } catch {
        // patch 失败不影响主流程
      }
    }

    // Step 2: 立即 return null,让飞书 card action callback 立即完成
    void this._doStopAndSend(
      openId, shortId, sessionId, cwd, text, parentUuid, hasParent, messageId,
    );
    return null;
  }

  /**
   * v2.2.18: handleStopAndSend 的实际工作后台版。fire-and-forget 调,
   * 内部所有 patchFn / runChatSDK / replyFn 都走自己的失败恢复。
   */
  private async _doStopAndSend(
    openId: string,
    shortId: string,
    sessionId: string,
    cwd: string,
    text: string,
    parentUuid: string,
    hasParent: boolean,
    messageId?: string,
  ): Promise<void> {
    try {
      // 1. 跑 claude stop 释放 bg worker
      try {
        const cp = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileP = promisify(cp.execFile);
        await execFileP('claude', ['stop', shortId], { timeout: 5000 });
      } catch (err: any) {
        // "No job matching"(已自然 settle)算成功;其他错才报
        const msg = err?.stderr || err?.message || String(err);
        if (!/No job matching/i.test(msg)) {
          await this.deps.replyFn(`❌ Stop 失败:${msg}`, { openId });
          return;
        }
      }
      // 2. 等 supervisor 释放(2026-06-09:1s → 3s,治新 bg worker 太快 respawn 的 race)
      await new Promise(r => setTimeout(r, 3000));

      // 3. 总是 fallback 到 parent(除非没 parent)
      const effectiveSessionUuid = hasParent && parentUuid ? parentUuid : sessionId;
      const effectiveSerialKey = effectiveSessionUuid;
      const fallbackNote = hasParent && parentUuid
        ? `已自动 fallback 到 parent session (${parentUuid.slice(0, 8)}...) —— bg worker 内存里的增量对话会丢失,parent 有 fork 之前的历史。`
        : '';

      // 4. CAS 切 UserManager 到 effective sessionId
      if (effectiveSessionUuid !== sessionId) {
        const oldEntry = this.deps.userManager.getEntry(openId);
        if (oldEntry?.type === 'session' && oldEntry.sessionUuid === sessionId) {
          const newEntry: MappingEntry = { ...oldEntry, sessionUuid: effectiveSessionUuid };
          const ok = await this.deps.userManager.compareAndSwap(openId, oldEntry, newEntry);
          if (ok && fallbackNote) {
            await this.deps.replyFn(
              `🛑 bg worker ${shortId} 已停止。${fallbackNote}`,
              { openId },
            );
          }
        }
      }

      // 5. 调 runChatSDK 发消息(SDK 内部会自己 patch 卡成"💭 处理中" → "✅ 处理完成")
      try {
        await this.deps.runChatSDK({
          openId,
          sessionUuid: effectiveSessionUuid,
          cwd,
          promptText: text,
          serialKey: effectiveSerialKey,
          isNew: false,
        });
      } catch (err: any) {
        await this.deps.replyFn(`❌ 发送失败:${err?.message ?? err}`, { openId });
      }
    } catch (err: any) {
      // Top-level safety net: _doStopAndSend is fire-and-forget (void),
      // so any unhandled rejection would silently disappear.
      logger.error(`_doStopAndSend unexpected error: ${err?.message ?? err}`);
      try {
        await this.deps.replyFn(`❌ 操作失败,请重试`, { openId });
      } catch { /* last-resort swallow */ }
    }
  }

  /**
   * v2.2.11: bg-conflict 拒绝卡 → [🌿 开新会话发送] 按钮。
   *
   * 完全独立于原 bg session:isNew=true 让 runChatSDK 不带 resume,
   * SDK 创建全新 sessionId。bg worker 继续独立跑,飞书侧拿到一个全新
   * 上下文(cwd 沿用原 session 的,方便继续在同项目下干活)。
   */
  async handleNewAndSend(
    openId: string,
    cwd: string,
    text: string,
    messageId?: string,
  ): Promise<string | null> {
    if (messageId) {
      try {
        await this.deps.patchFn(
          messageId,
          buildErrorCard({
            title: '🌿 开新会话中',
            body: '正在创建独立 session 处理你的消息...',
          }),
        );
      } catch {
        // ignore
      }
    }
    try {
      await this.deps.runChatSDK({
        openId,
        sessionUuid: '', // empty + isNew=true → 新建
        cwd,
        promptText: text,
        serialKey: `new:${openId}:${Date.now()}`,
        isNew: true,
      });
    } catch (err: any) {
      await this.deps.replyFn(`❌ 新会话创建失败:${err?.message ?? err}`, { openId });
    }
    return null;
  }

  /**
   * v2.2.11: bg-conflict 拒绝卡 → [❌ 取消] 按钮。
   * 把拒绝卡 patch 成"已取消"提示,不调 SDK,不动 UserManager。
   */
  async handleBgConflictCancel(
    _openId: string,
    messageId?: string,
  ): Promise<string | null> {
    if (messageId) {
      try {
        await this.deps.patchFn(
          messageId,
          buildErrorCard({
            title: '❌ 已取消',
            body: '消息未发送,bg worker 不受影响。',
          }),
        );
      } catch {
        // ignore
      }
    }
    return null;
  }

  /**
   * Step A — set expectedReply and prompt the user to send the reply text.
   * Three-way guard (fetch ok / session present / status === 'waiting') runs
   * first; on success the trigger card (list or peek) is patched to a waiting
   * card BEFORE the prompt text is sent, so the user sees the card transition
   * before their input is requested. v2.2: patch order is patch -> reply.
   */
  async handleReplyRequest(
    openId: string,
    _shortId: string,
    sessionId: string,
    cwd: string,
  ): Promise<void> {
    // 1. 三重守卫
    const result = await AgentSnapshotFetcher.fetch();
    if (!result.ok) {
      await this.deps.replyFn(`❌ ${result.reason}`, { openId });
      return;
    }
    const session = result.sessions.find(s => s.sessionId === sessionId);
    if (!session) {
      await this.deps.replyFn('⚠️ 会话已不存在', { openId });
      return;
    }
    if (session.status !== 'waiting') {
      await this.deps.replyFn(
        `⚠️ 该 session 不是 waiting 状态(当前 ${session.status}),无法 reply`,
        { openId },
      );
      return;
    }
    // 2. 持久化 expectedReply
    // 智能 CAS(expectedReplyState v2.3.3):transient / 同 session 自动清,真冲突 throw。
    // 不再依赖"patch 触发的 list 卡为等待输入卡"——v2.2 这条路要求 preListEntry 是
    // last_agent_list_card(飞书能 patch),但 v2.3.3 之后用户从 attach 切到 reply 时
    // preListEntry 是 session 类型,triggerCardMessageId=undefined,patch 步骤不进
    // → 文本消息却提"点 [取消等待] 按钮"(飞书纯文本无 button)→ 用户看不见按钮。
    // 新设计:不用 patch 触发卡,改用 replyFn 发清晰文案 + 后续 reply 完成时
    // 自动 restore expectedReply(见 handleReply 后段,让用户能连续发 reply)。
    try {
      await this.expectedReply.set(openId, { shortId: _shortId, sessionId, cwd });
    } catch (err: any) {
      // 真正"另一端在操作" — 给明确指引让用户取消
      await this.deps.replyFn(`⚠️ ${err.message.replace(/^Failed to set expectedReply for .+?: /, '')}`, { openId });
      return;
    }
    // 3. 发独立提示消息(纯文本,无 button —— 飞书 IM 限制)
    await this.deps.replyFn(
      `↩️ 回复会话: ${session.name}\n` +
      `请直接发送文字消息(5 分钟内有效)。\n` +
      `发 /cancel 退出等待。\n` +
      `可继续多次发文字,直到 Claude 不再需要输入。`,
      { openId },
    );
  }

  /**
   * Step B — once a reply text arrives, re-run the status guard, then proxy
   * the text through runChatSDK. v2.2 critical fix: wrap runChatSDK in
   * try/finally so expectedReply is cleared even if it throws (otherwise
   * the user stays stuck in waiting state until the 5-minute timeout).
   *
   * v2.2 simplification: removed the CAS-claim dance that bumped casToken.
   * The dance was dead code: the finally block clears the entry regardless
   * of CAS outcome, so the casToken change had no observable effect.
   * sessionLocks (in the SpoolQueue dispatch path) already serialize
   * per-session data, so per-session corruption is impossible.
   */
  async handleReply(openId: string, text: string): Promise<void> {
    // 1. 检查 expectedReply
    const info = this.expectedReply.get(openId);
    if (!info) return;

    // 2. Step B 二次状态守卫
    const result = await AgentSnapshotFetcher.fetch();
    if (!result.ok) {
      await this.expectedReply.clear(openId);
      return;
    }
    const session = result.sessions.find(s => s.sessionId === info.sessionId);
    if (!session) {
      await this.expectedReply.clear(openId);
      await this.deps.replyFn('⚠️ 会话已不存在', { openId });
      return;
    }
    if (session.status !== 'waiting') {
      await this.expectedReply.clear(openId);
      await this.deps.replyFn(
        `⚠️ Claude 已切换到 ${session.status},无法 reply`,
        { openId },
      );
      return;
    }

    // 3. runChatSDK,try/finally 保证 clear 必发(v2.2 critical)
    // v2.3.5: 传 fromAgentViewReply: true — bot runChatSDK 检测到 bg conflict 时
    // 自动 stop bg + 3s wait + 递归 SDK(不再弹 3 按钮冲突卡),符合用户"接管"预期。
    let sdkError: any = null;
    try {
      await this.deps.runChatSDK({
        openId,
        sessionUuid: info.sessionId,
        cwd: info.cwd,
        promptText: text,
        serialKey: info.sessionId,
        isNew: false,
        fromAgentViewReply: true,
      });
    } catch (err: any) {
      sdkError = err;
    } finally {
      await this.expectedReply.clear(openId);
    }
    if (sdkError) {
      await this.deps.replyFn(`❌ Reply 失败:${sdkError?.message ?? sdkError}`, { openId });
      return;
    }
    // v2.3.9 简化:不再"自动持续 reply" post-fetch re-set。
    // 原 v2.3.4 设计:SDK 跑完后 fetch snapshot 看到 waiting 就 re-set,让用户
    // 在 5min timeout 内连续发文字 reply。实操中,re-set 跟 user-mapping 其他路径
    // (handleList 写 last_agent_list_card 等)race-prone,导致:
    //   - 第二次 reply 时 user_mapping 偶发"已清 + 未 re-set"窗口
    //   - handleChat 走普通 chat 而非 reply,bot 静默无回应
    //   - 用户感觉"再发消息没反应"
    //
    // 修法:reply 完成即清,user 想继续 reply 必须重新点 [Reply] 按钮。
    // 5min 内点 [Reply] 仍能正常(没动这条路径)。UX 退步(失去便利),但 100% 可靠。
    // 持续 reply 的"需要"用 bot 端的 v2.3.8 pre-step stop 补足 —— user 重新点
    // [Reply] 时,bot 自动停 bg + 调 SDK,流程一气呵成。
    //
    // 给一个友好提示让 user 知道下一次该点 [Reply]:
    await this.deps.replyFn(
      `✅ Claude 已处理完你的消息。\n` +
      `若需继续 reply,在飞书 Agent View 重新点 [Reply] 即可。`,
      { openId },
    );
  }

  /**
   * Cancel an active waiting state. Idempotent — safe to call when no
   * reply is pending. v2.2: if nothing was pending, stay SILENT — don't
   * spam a "已取消" reply that confuses the user (they didn't ask to
   * cancel anything).
   */
  async handleCancelReply(openId: string, _messageId?: string): Promise<void> {
    const wasPending = !!this.expectedReply.get(openId);
    await this.expectedReply.clear(openId, 'user');
    if (wasPending) {
      await this.deps.replyFn('✅ 已取消等待回复', { openId });
    }
    // else: silent — no reply was pending, no need to confirm
  }

  /** Drop the user out of Agent View — pure text reply, no state mutation.
   *  v2.2: clear any pending expectedReply so the next chat message doesn't
   *  get re-routed as a reply (the user wants to chat, not reply to a
   *  background session). */
  async handleBackToChat(openId: string): Promise<void> {
    await this.expectedReply.clear(openId, 'overwrite');
    await this.deps.replyFn(
      '已退出 Agent View,继续发送消息或 / 命令即可。下次进 /agents 视图重新打 /agents。',
      { openId },
    );
  }

  /** [Stop Watching] 按钮 handler */
  async handleStopWatching(openId: string): Promise<null> {
    await this.attachedWatchers.stop(openId, 'user_stop', { patchFinal: true });
    return null;
  }

  /** R8 启动恢复钩子 */
  async restoreExpectedReplyStates(): Promise<void> {
    await this.expectedReply.restoreExpectedReplyStates();
  }

  /** Refresh 防抖 */
  shouldRefresh(): boolean {
    const now = Date.now();
    if (now - this.lastRefreshAt < this.minRefreshIntervalMs) return false;
    this.lastRefreshAt = now;
    return true;
  }

  /**
   * G11 卡片尺寸保护:卡 ≤ 25KB 发 cardReplyFn;超 25KB 降级为 replyFn text。
   * 返回 cardMessageId(若走 fallback 则返回 null)。
   */
  private async sendOrFallback(
    card: string,
    cardOpts: { openId: string; messageId?: string },
    fallbackText: string,
    openId: string,
  ): Promise<string | null> {
    const size = new TextEncoder().encode(card).length;
    if (size > MAX_CARD_BYTES) {
      await this.deps.replyFn(fallbackText, { openId });
      return null;
    }
    return await this.deps.cardReplyFn(card, cardOpts);
  }
}

/**
 * Truncate a string to at most `max` UTF-8 bytes.
 * Used by Peek cards to keep recent log output under the 2KB message-size budget.
 * Inline (not imported from card-updater) to avoid cross-module coupling.
 */
function truncateBytes(s: string, max: number): string {
  return new TextEncoder().encode(s).length <= max
    ? s
    : (() => {
        let acc = '';
        for (const ch of s) {
          if (new TextEncoder().encode(acc + ch).length > max) break;
          acc += ch;
        }
        return acc;
      })();
}

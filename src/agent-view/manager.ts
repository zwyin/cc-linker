import type { UserManager, MappingEntry } from '../feishu/mapping';
import { AgentSnapshotFetcher } from './snapshot-fetcher';
import { ExpectedReplyState } from './expected-reply-state';
import { buildListCard, buildPeekCard, buildErrorCard, buildEmptyCard, buildWaitingCard, buildStopConfirmCard } from './card';
import type { AgentSession, AgentSessionGroup, AgentSessionStatus } from './types';
import { groupByStatus } from './types';
import { config } from '../utils/config';

/** Maximum list-card byte size. 飞书 card 25KB 上限;超过走 text fallback。 */
const MAX_CARD_BYTES = 25_000;
/** 列表卡显示上限:spec §6.1 "列表上限 10 个会话 + 折行"。 */
const MAX_LIST_ITEMS = 10;
/** 列表 fallback 文本:卡超 25KB 时降级。 */
const LIST_FALLBACK_TEXT = (n: number) => `📋 Agent View · ${n} sessions · /agents to refresh`;

export interface AgentViewDeps {
  userManager: UserManager;
  feishuClient?: any;
  replyFn: (text: string, opts: { openId: string; messageId?: string }) => Promise<string | null>;
  cardReplyFn: (card: string, opts: { openId: string; messageId?: string }) => Promise<string | null>;
  patchFn: (messageId: string, card: string) => Promise<any>;
  runChatSDK: (params: {
    openId: string; sessionUuid: string; cwd: string;
    promptText: string; serialKey: string; isNew?: boolean;
    settingsPath?: string;
  }) => Promise<{ result: any; handler: any; cardMessageId: string | null }>;
  expectedReplyTimeoutMs?: number;
}

export class AgentViewManager {
  readonly expectedReply: ExpectedReplyState;
  private minRefreshIntervalMs = 2000;
  private lastRefreshAt = 0;

  constructor(public deps: AgentViewDeps) {
    this.expectedReply = new ExpectedReplyState(
      deps.userManager,
      deps.expectedReplyTimeoutMs ?? 300_000
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
    // 列表上限 10(spec §6.1)
    const cappedSessions = result.sessions.slice(0, MAX_LIST_ITEMS);
    const groups = groupByStatus(cappedSessions);
    const card = buildListCard(groups, new Date().toLocaleTimeString());
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
    const cappedSessions = result.sessions.slice(0, MAX_LIST_ITEMS);
    const groups = groupByStatus(cappedSessions);
    const card = buildListCard(groups, new Date().toLocaleTimeString());
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
   * /agents 列表卡 → [Peek] 按钮入口。
   * 抓 session 元信息(name/status/waitingFor/pid/startedAt),execFile `claude logs <shortId>` 拿尾部输出,
   * strip ANSI + 取后 30 行 + 截到 2048 bytes,buildPeekCard 通过 cardReplyFn 发出。
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
    let raw: string;
    try {
      const cp = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileP = promisify(cp.execFile);
      const result = await execFileP('claude', ['logs', shortId], { timeout: 3000 });
      raw = result.stdout;
    } catch (err: any) {
      await this.deps.replyFn(`❌ claude logs 失败:${err.message}`, { openId });
      return null;
    }
    // strip ANSI + 取后 N 行 + 截到 M bytes(N, M 来自 config)
    const { stripAnsi } = await import('./ansi-strip');
    const stripped = stripAnsi(raw);
    const peekLines = config.get<number>('agent_view.peek_lines', 30);
    const peekMaxBytes = config.get<number>('agent_view.peek_max_bytes', 2048);
    const lines = stripped.split('\n').slice(-peekLines).join('\n');
    // agent-view 自己实现 truncateBytes(简单,避免跨模块依赖 card-updater private)
    const truncated = truncateBytes(lines, peekMaxBytes);
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
      waitingFor: session.waitingFor,
      shortId,
      sessionId,
      cwd,
      pid: session.pid,
      startedAt: session.startedAt,
      recentOutput: truncated,
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
   * Peek 卡 → [Refresh] 按钮入口。校验 messageId 后,跟 handlePeek 类似流程
   * 但用 patchFn patch 现有 peek 卡。session 不存在时 patch 错误卡提示"已自动刷新列表"。
   */
  async handleRefreshPeek(
    openId: string,
    shortId: string,
    sessionId: string,
    messageId?: string,
  ): Promise<string | null> {
    if (!messageId) return null;
    const session = await this.findSession(openId, sessionId);
    if (!session) {
      await this.deps.patchFn(
        messageId,
        buildErrorCard({
          title: '⚠️ 会话已不存在',
          body: '已自动刷新列表',
        }),
      );
      return null;
    }
    let raw: string;
    try {
      const cp = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileP = promisify(cp.execFile);
      const result = await execFileP('claude', ['logs', shortId], { timeout: 3000 });
      raw = result.stdout;
    } catch (err: any) {
      await this.deps.patchFn(
        messageId,
        buildErrorCard({
          title: '❌ claude logs 失败',
          body: err.message,
        }),
      );
      return null;
    }
    const { stripAnsi } = await import('./ansi-strip');
    const stripped = stripAnsi(raw);
    const peekLines = config.get<number>('agent_view.peek_lines', 30);
    const peekMaxBytes = config.get<number>('agent_view.peek_max_bytes', 2048);
    const lines = stripped.split('\n').slice(-peekLines).join('\n');
    const truncated = truncateBytes(lines, peekMaxBytes);
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
      waitingFor: session.waitingFor,
      shortId,
      sessionId,
      cwd: session.cwd,
      pid: session.pid,
      startedAt: session.startedAt,
      recentOutput: truncated,
      buttons,
    });
    // G11:超 25KB 走 text fallback(无法 patch 时发新文本)
    const size = new TextEncoder().encode(card).length;
    if (size > MAX_CARD_BYTES) {
      await this.deps.replyFn(
        `🔍 Peek · \`${session.name}\` · /agents 刷新列表`,
        { openId },
      );
      return null;
    }
    await this.deps.patchFn(messageId, card);
    return null;
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
      await execFileP('claude', ['stop', shortId], { timeout: 5000 });
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
    _shortId: string,
    _name: string,
    cwd: string,
  ): Promise<string | Record<string, unknown> | null> {
    // 0. 实时守卫
    const result = await AgentSnapshotFetcher.fetch();
    if (!result.ok || !result.sessions.find(s => s.sessionId === sessionId)) {
      await this.deps.replyFn('⚠️ 会话已不存在', { openId });
      return null;
    }
    // 1. 清除 expectedReply(如果有)
    await this.expectedReply.clear(openId, 'overwrite');
    // 2. CAS 1: 清旧 entry
    const oldEntry = this.deps.userManager.getEntry(openId);
    if (oldEntry) {
      const ok1 = await this.deps.userManager.compareAndSwap(openId, oldEntry, null);
      if (!ok1) {
        await this.deps.replyFn('⚠️ 状态冲突,请重试', { openId });
        return null;
      }
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
    await this.deps.replyFn(
      `📎 已 Attach 到 \`${session.name}\`${warning}${waitingInfo}\n` +
        `Status: ${session.status} · CWD: ${cwd}\n` +
        `💡 提示:发 /new 创建新会话,或 /agents 返回列表。`,
      { openId },
    );
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
    // ExpectedReplyState.set CAS-expects null, so any existing entry (e.g.
    // last_agent_list_card from the /agents that triggered this Reply click)
    // makes set() throw. Capture the trigger card's messageId first, then
    // clear that entry to free the slot for set(). v2.2 intent: after set()
    // succeeds we patch the captured cardMessageId to a waiting card BEFORE
    // sending the prompt text.
    const preListEntry = this.deps.userManager.getEntry(openId);
    const triggerCardMessageId =
      preListEntry?.type === 'last_agent_list_card' ? preListEntry.cardMessageId : undefined;
    if (preListEntry?.type === 'last_agent_list_card') {
      await this.deps.userManager.compareAndSwap(openId, preListEntry, null);
    }
    try {
      await this.expectedReply.set(openId, { shortId: _shortId, sessionId, cwd });
    } catch (_err: any) {
      await this.deps.replyFn('⚠️ 另一端正在操作,请先在对方客户端取消', { openId });
      return;
    }
    // 3. patch 触发的 list 卡为等待输入卡(v2.2 顺序:先 patch,后发文本)
    if (triggerCardMessageId) {
      const waitingCard = buildWaitingCard({
        name: session.name,
        status: session.status,
        waitingFor: session.waitingFor,
        cwd,
      });
      await this.deps.patchFn(triggerCardMessageId, waitingCard);
    }
    // 4. 发独立文本消息
    await this.deps.replyFn(
      `↩️ 回复会话: ${session.name}\n请直接发送文字消息作为回复(5 分钟内有效)\n可点 [取消等待] 按钮,或发 /cancel 取消`,
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
    try {
      await this.deps.runChatSDK({
        openId,
        sessionUuid: info.sessionId,
        cwd: info.cwd,
        promptText: text,
        serialKey: info.sessionId,
        isNew: false,
      });
    } finally {
      await this.expectedReply.clear(openId);
    }
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

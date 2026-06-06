import type { UserManager, MappingEntry } from '../feishu/mapping';
import { AgentSnapshotFetcher } from './snapshot-fetcher';
import { ExpectedReplyState } from './expected-reply-state';
import { buildListCard, buildPeekCard, buildErrorCard, buildEmptyCard, buildWaitingCard, buildStopConfirmCard } from './card';
import type { AgentSession, AgentSessionGroup, AgentSessionStatus } from './types';
import { groupByStatus } from './types';

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
    const groups = groupByStatus(result.sessions);
    if (groups.busy.length + groups.waiting.length + groups.idle.length === 0) {
      const card = buildEmptyCard();
      await this.deps.cardReplyFn(card, { openId });
      return;
    }
    const card = buildListCard(groups, new Date().toLocaleTimeString());
    const cardMessageId = await this.deps.cardReplyFn(card, { openId });
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
    const groups = groupByStatus(result.sessions);
    if (groups.busy.length + groups.waiting.length + groups.idle.length === 0) {
      const card = buildEmptyCard();
      await this.deps.patchFn(messageId, card);
      return null;
    }
    const card = buildListCard(groups, new Date().toLocaleTimeString());
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
    // strip ANSI + 取后 30 行 + 截到 2048 bytes
    const { stripAnsi } = await import('./ansi-strip');
    const stripped = stripAnsi(raw);
    const lines = stripped.split('\n').slice(-30).join('\n');
    // agent-view 自己实现 truncateBytes(简单,避免跨模块依赖 card-updater private)
    const truncated = truncateBytes(lines, 2048);
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
    return await this.deps.cardReplyFn(card, { openId });
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
    const lines = stripped.split('\n').slice(-30).join('\n');
    const truncated = truncateBytes(lines, 2048);
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
    await this.deps.patchFn(messageId, card);
    return null;
  }

  async handleAttach(
    _openId: string,
    _sessionId: string,
    _shortId: string,
    _name: string,
    _cwd: string,
  ): Promise<string | Record<string, unknown> | null> {
    throw new Error('AgentViewManager.handleAttach not implemented (T22)');
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
   * Step B — once a reply text arrives, CAS-claim the expectedReply slot,
   * re-run the status guard, then proxy the text through runChatSDK. v2.2
   * critical fix: wrap runChatSDK in try/finally so expectedReply is cleared
   * even if it throws (otherwise the user stays stuck in waiting state until
   * the 5-minute timeout).
   */
  async handleReply(openId: string, text: string): Promise<void> {
    // 1. 检查 expectedReply
    const info = this.expectedReply.get(openId);
    if (!info) return;

    // 2. CAS 抢占(改 casToken 标识"reply 开始了")
    try {
      const entry = this.deps.userManager.getEntry(openId);
      if (entry?.type !== 'pending_agent_reply') return;
      const casToken = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const ok = await this.deps.userManager.compareAndSwap(openId, entry, {
        ...entry,
        casToken,
      });
      if (!ok) return;
    } catch (_err) {
      return;
    }

    // 3. Step B 二次状态守卫
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

    // 4. runChatSDK,try/finally 保证 clear 必发(v2.2 critical)
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

  /** Cancel an active waiting state. Idempotent — safe to call when no reply is pending. */
  async handleCancelReply(openId: string, _messageId?: string): Promise<void> {
    await this.expectedReply.clear(openId, 'user');
    await this.deps.replyFn('✅ 已取消等待回复', { openId });
  }

  async handleStop(
    _openId: string,
    _shortId: string,
    _sessionId: string,
    _name: string,
  ): Promise<string | Record<string, unknown> | null> {
    throw new Error('AgentViewManager.handleStop not implemented (T20)');
  }

  async handleStopConfirm(
    _openId: string,
    _shortId: string,
    _sessionId: string,
    _messageId?: string,
  ): Promise<string | null> {
    throw new Error('AgentViewManager.handleStopConfirm not implemented (T21)');
  }

  /** Drop the user out of Agent View — pure text reply, no state mutation. */
  async handleBackToChat(openId: string): Promise<void> {
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

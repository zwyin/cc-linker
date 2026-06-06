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

  async handleReplyRequest(
    _openId: string,
    _shortId: string,
    _sessionId: string,
    _cwd: string,
  ): Promise<string | Record<string, unknown> | null> {
    throw new Error('AgentViewManager.handleReplyRequest not implemented (T17)');
  }

  async handleCancelReply(_openId: string, _messageId?: string): Promise<string | null> {
    throw new Error('AgentViewManager.handleCancelReply not implemented (T19)');
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

  async handleBackToChat(_openId: string): Promise<string | null> {
    throw new Error('AgentViewManager.handleBackToChat not implemented (T16)');
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

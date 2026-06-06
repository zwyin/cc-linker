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

  /** /agents 命令入口 (skeleton — full impl in T14) */
  async handleList(openId: string, _msgMessageId?: string): Promise<void> {
    const result = await AgentSnapshotFetcher.fetch();
    if (!result.ok) {
      await this.deps.replyFn(`❌ ${result.reason}`, { openId });
      return;
    }
    const groups = groupByStatus(result.sessions);
    const card = buildListCard(groups, new Date().toLocaleTimeString());
    await this.deps.cardReplyFn(card, { openId });
  }

  // ── Card action handlers (dispatched from FeishuBot.handleCardAction) ──
  // Full implementations land in T14-T22. These stubs keep the bot's
  // dispatch typecheck-clean while the real handlers are being written;
  // calling them before T14-T22 throws so we notice in QA.

  async handleRefreshList(_openId: string, _messageId?: string): Promise<string | null> {
    throw new Error('AgentViewManager.handleRefreshList not implemented (T14)');
  }

  async handleRefreshPeek(
    _openId: string,
    _shortId: string,
    _sessionId: string,
    _messageId?: string,
  ): Promise<string | null> {
    throw new Error('AgentViewManager.handleRefreshPeek not implemented (T15)');
  }

  async handlePeek(
    _openId: string,
    _shortId: string,
    _sessionId: string,
    _cwd: string,
  ): Promise<string | Record<string, unknown> | null> {
    throw new Error('AgentViewManager.handlePeek not implemented (T15)');
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

import { basename, dirname, join, resolve } from 'path';
import { existsSync, readdirSync } from 'fs';
import { UserManager } from './mapping';
import type { MappingEntry } from './mapping';
import { readRoster, lookupResumeFromPath } from '../agent-view/roster-source';
import { ListSnapshotManager, ListSnapshotEntry } from './list-snapshot';
import { SpoolQueue, SpoolMessage, TargetSnapshot } from '../queue/spool';
import { ClaudeSessionManager, SendMessageResult } from '../proxy/session';
import { sessionManager as defaultSessionManager } from '../proxy/session';
import type { AgentViewManager } from '../agent-view/manager';
import { isAgentViewValue } from '../agent-view/action';
import { buildBgConflictCard } from '../agent-view/card';
import { checkRendezvousEligibility } from '../agent-view/rendezvous-fallback';
import { RendezvousClient, type StatePatch } from '../agent-view/rendezvous-client';
import { readLastAssistantTurn, waitForNewAssistantTurn, type LastAssistantTurn } from '../agent-view/jsonl-last-assistant';
import { readJobState } from '../agent-view/job-state';
import { formatTokenCount } from './card-updater';
import { StreamChunk } from '../proxy/stream-parser';
import { CardUpdater } from './card-updater';
import { LiveProgressWatcher, isSessionProcessing, DEFAULT_LIVE_PROGRESS_CONFIG, type LiveProgressConfig } from './live-progress';
import { PermissionHandler, type PermissionPrompt } from '../proxy/permission-handler';
import { esc } from './markdown-escape';
import { RegistryManager } from '../registry';
import type { SessionEntry } from '../registry/types';
import { syncBeforeCommand } from '../scanner';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { isSafeId } from '../utils/safe-id';
import { SERVICE_UNAVAILABLE_REPLY } from './replies';
import { repairJsonlLastPrompt } from '../utils/jsonl-repair';
import { formatTimeAgo } from '../cli/output';
import { ProviderManager } from '../utils/providers';
import { isSessionActive, SessionActivityCache, type ActivityResult } from '../utils/session-activity';
import {
  extractImageKey,
  downloadMessageImage,
  buildPromptWithImages,
  cleanupOldImages,
} from './image';

/**
 * Detect if a message is a Feishu command (e.g. "/list", "/switch uuid").
 *
 * A command is any text starting with "/" whose second character is not
 * whitespace. We use a /\s/ regex (not just `' ' !==`) so that tabs, NBSP,
 * and other Unicode separators are also treated as non-commands — matching
 * the /\s+/ split used downstream in handleCommand and parseNewCommand.
 */
export function isCommandMessage(text: string): boolean {
  return text.startsWith('/') && text.length > 1 && !/\s/.test(text[1] ?? '');
}

export type FeishuMessageEvent = {
  open_id: string;
  message_id: string;
  content: string;
  chat_type: 'p2p' | 'group';
  message_type: 'text' | 'image';
};

export type FeishuReplyFn = (
  text: string,
  options?: {
    messageId?: string;
    openId?: string;
    requestUuid?: string;
    chunkIndex?: number;
  },
) => Promise<string | null>;

/** Card action callback payload from Feishu WSClient (card.action.trigger event) */
export type FeishuBotCardAction = {
  open_id: string;
  action: { tag: string; value: string | Record<string, unknown> };
  message: { message_id: string };
};

/** Send an interactive card to a Feishu user */
export type FeishuBotCardReplyFn = (
  card: Record<string, unknown>,
  options?: { messageId?: string; openId?: string },
) => Promise<string | null>;

class ReplyDeliveryPendingError extends Error {
  constructor(public delayMs: number, message = 'reply_delivery_pending') {
    super(message);
    this.name = 'ReplyDeliveryPendingError';
  }
}

function stableUuid(messageId: string, chunkIndex = 0): string {
  return `msg-${Bun.hash(`${messageId}:${chunkIndex}`).toString(16)}`;
}

/** Unique UUID for card callback replies — NOT based on messageId to avoid
 *  Feishu API idempotency deduplication when user clicks the same card button multiple times.
 */
function uniqueUuid(): string {
  return `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * v2.2.10 测试 hook —— runChatSDK 内部走 _bgConflictHooks 调用 roster 探测,
 * tests swap 字段即可模拟 live bg worker 场景,不用 mock.module(后者跨文件
 * 不可撤销,污染 roster-source.test.ts)。
 */
export const _bgConflictHooks = {
  readRoster,
  lookupResumeFromPath,
};

export class FeishuBot {
  private userManager: UserManager;
  private listSnapshotManager: ListSnapshotManager;
  private spoolQueue: SpoolQueue;
  private registry: RegistryManager;
  private sessionManager: ClaudeSessionManager;
  private replyFn: FeishuReplyFn;
  private cardReplyFn: FeishuBotCardReplyFn;
  private feishuClient: any;
  private providerManager: ProviderManager;
  private running = false;
  private stopRequested = false;
  private activeWorkers = new Set<Promise<void>>();
  private activePermissionHandlers = new Map<string, PermissionHandler>();
  /**
   * Agent View manager (set via setAgentView in start.ts). Holds deps with
   * `runChatSDK` arrow-bound to this FeishuBot instance so AgentViewManager.handleReply
   * can drive the full SDK streaming lifecycle (permission cards, throttled
   * updates, registry updates, spool finalization) without going through SpoolQueue.
   */
  private agentView?: AgentViewManager;
  /**
   * Tracks the 1200ms-delayed "click → 处理中" patch timer for each permission card,
   * keyed by Feishu message_id. Used by the post-operation completion patcher to
   * cancel the click's pending patch BEFORE writing "✅ 已完成", so the click patch
   * can't fire later and overwrite the final state.
   */
  private activePermissionCardTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Set of messageIds that the user explicitly cancelled (via /stop or card button).
   * Checked by streaming catch blocks to distinguish user-initiated cancellation
   * from actual errors — avoids showing "处理失败" when the user chose to stop.
   */
  private cancelledMessageIds = new Set<string>();
  private lastImageCleanup = 0;

  /** Live progress watchers, keyed by openId. One watcher per user. */
  private liveWatchers = new Map<string, LiveProgressWatcher>();

  /**
   * Active rendezvous reply waits keyed by openId.
   *
   * 存 AbortController + 原 session 上下文 (sessionUuid + cwd + attachedAt):
   *   - abort: handler 用来打断 poll 循环
   *   - sessionUuid / cwd: 恢复 user-mapping (markSent 在 from-Reply 路径清了)
   *   - attachedAt: from-Attach 入口时 ≠ undefined; handler 恢复时保留, 让用户后续
   *     消息仍走 rendezvous 路径 (不保留则降级到 busy-check, Attach 语义丢)
   *
   * Serialized per-user by spool's serialKey lock, 同 openId 最多 1 个在飞 wait。
   */
  private activeRendezvousWaits = new Map<string, {
    abort: AbortController;
    sessionUuid: string;
    cwd: string;
    attachedAt: string | undefined;  // from-Attach 路径时填, from-Reply 时 undefined
  }>();

  /**
   * CardUpdater instances for active rendezvous waits, keyed by openId.
   * Handler 用它 patch 流式卡到 abort 终态。
   */
  private rendezvousCardUpdaters = new Map<string, CardUpdater>();

  /** Maximum time to wait for user to click "force-send" on busy card before
   *  auto-processing the message as force-send. Prevents infinite accumulation
   *  of orphan messages in processing/ that would be re-cycled on daemon restart.
   *  Default: 60 seconds. */
  private static readonly BUSY_TIMEOUT_MS = 60_000;

  constructor(opts: {
    userManager: UserManager;
    listSnapshotManager: ListSnapshotManager;
    spoolQueue: SpoolQueue;
    registry: RegistryManager;
    sessionManager?: ClaudeSessionManager;
    replyFn?: FeishuReplyFn;
    cardReplyFn?: FeishuBotCardReplyFn;
    feishuClient?: any;
    providerManager?: ProviderManager;
  }) {
    this.userManager = opts.userManager;
    this.listSnapshotManager = opts.listSnapshotManager;
    this.spoolQueue = opts.spoolQueue;
    this.registry = opts.registry;
    this.sessionManager = opts.sessionManager ?? defaultSessionManager;
    this.replyFn = opts.replyFn ?? (async () => null);
    this.cardReplyFn = opts.cardReplyFn ?? (async () => null);
    this.feishuClient = opts.feishuClient ?? null;
    this.providerManager = opts.providerManager ?? new ProviderManager();
  }

  async onMessage(event: FeishuMessageEvent): Promise<void> {
    if (event.chat_type !== 'p2p') {
      logger.debug(`忽略非私聊消息: ${event.message_id} (chat_type=${event.chat_type})`);
      return;
    }

    if (!['text', 'image'].includes(event.message_type)) {
      logger.debug(`忽略不支持的消息类型: ${event.message_id} (message_type=${event.message_type})`);
      return;
    }

    // messageId + openId 白名单校验：defense-in-depth 首个 gate
    // 字符集 + 长度上限定义见 src/utils/safe-id.ts
    // 攻击者通过 valid/invalid 格式响应差异可推断配置（owner_open_id、白名单存在性）—— oracle 防御
    if (!isSafeId(event.message_id) || !isSafeId(event.open_id)) {
      logger.warn(
        `消息 ID 格式异常，拒绝入队: messageId=${event.message_id}, openId=${event.open_id}`,
      );
      await this.replyFn(SERVICE_UNAVAILABLE_REPLY, {
        messageId: event.message_id,
        openId: event.open_id,
        requestUuid: stableUuid(event.message_id),
      });
      return;
    }

    if (!this.userManager.validateOwner(event.open_id)) {
      await this.replyFn('该 Bot 为个人私有实例，暂不对外开放', {
        messageId: event.message_id,
        openId: event.open_id,
        requestUuid: stableUuid(event.message_id),
      });
      return;
    }

    if (this.spoolQueue.hasReceipt(event.message_id)) {
      logger.debug(`消息已处理，跳过: ${event.message_id}`);
      return;
    }

    let text = '';
    let imagePaths: string[] = [];

    if (event.message_type === 'image') {
      if (!config.get<boolean>('images.enabled', true)) {
        await this.replyFn('⚠️ 图片处理功能已禁用', {
          messageId: event.message_id,
          openId: event.open_id,
          requestUuid: stableUuid(event.message_id),
        });
        return;
      }

      if (!this.feishuClient) {
        await this.replyFn('⚠️ 图片处理功能未就绪（缺少飞书客户端配置），请发送文字消息。', {
          messageId: event.message_id,
          openId: event.open_id,
          requestUuid: stableUuid(event.message_id),
        });
        return;
      }

      const imageKey = extractImageKey(event.content);
      if (!imageKey) {
        logger.warn(`图片消息解析失败: ${event.message_id}, content=${event.content}`);
        return;
      }

      try {
        const localPath = await downloadMessageImage(
          this.feishuClient, event.message_id, imageKey,
        );
        imagePaths = [localPath];
        text = '';
      } catch (err: any) {
        logger.error(`图片下载失败: ${event.message_id}: ${err.message}`);
        await this.replyFn(`⚠️ 图片下载失败: ${err.message}`, {
          messageId: event.message_id,
          openId: event.open_id,
          requestUuid: stableUuid(event.message_id),
        });
        return;
      }
    } else {
      try {
        const content = JSON.parse(event.content);
        text = content.text ?? '';
      } catch {
        text = event.content;
      }
      text = text.trim();
    }

    if (!text && imagePaths.length === 0) return;

    const MAX_MESSAGE_LENGTH = 10000;
    if (text.length > MAX_MESSAGE_LENGTH) {
      await this.replyFn(
        `消息过长（${text.length} 字符），请控制在 ${MAX_MESSAGE_LENGTH} 字符以内，或将内容分段发送。`,
        { messageId: event.message_id, openId: event.open_id, requestUuid: stableUuid(event.message_id) },
      );
      return;
    }

    const isCommand = isCommandMessage(text);
    const target = isCommand
      ? { type: 'no_target' as const, openId: event.open_id, mappingVersion: this.userManager.getVersion() }
      : await this.resolveChatTarget(event.open_id, event.message_id);

    // command 走独立 serialKey（每个 messageId 独立），避免被 session streaming 阻塞
    // 注意：必须用 isCommand 标志，不按命令白名单——/listdir / 未来新增命令都自动覆盖
    const serialKey = isCommand
      ? `cmd:${event.open_id}:${event.message_id}`
      : target.type === 'session' && target.sessionUuid
        ? target.sessionUuid
        : `new:${event.open_id}`;

    const spoolMsg: SpoolMessage = {
      messageId: event.message_id,
      openId: event.open_id,
      text,
      target,
      serialKey,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      imagePaths,
    };

    const enqueued = this.spoolQueue.enqueue(spoolMsg);
    if (!enqueued) {
      logger.warn(`消息入队失败: ${event.message_id}`);
      // CR3 #4: 统一用通用消息，enqueue false 现在有 3 种原因（CAS race / 队列满 / writeAtomic
      // 失败如 EACCES / ENOSPC），前两者不影响用户决策（重试就行），后者跟"队列满"无关——
      // 旧消息 "消息处理队列已满" 对后者是误导。统一为 SERVICE_UNAVAILABLE_REPLY 与 oracle 防御一致。
      await this.replyFn(SERVICE_UNAVAILABLE_REPLY, {
        messageId: event.message_id,
        openId: event.open_id,
        requestUuid: stableUuid(event.message_id),
      });
    }
  }

  async dispatch(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      while (!this.stopRequested) {
        const now = Date.now();
        if (now - this.lastImageCleanup > 60 * 60 * 1000) {
          cleanupOldImages();
          this.lastImageCleanup = now;
        }

        const maxConcurrency = config.get<number>('queue.worker_concurrency', 5);

        while (this.activeWorkers.size < maxConcurrency) {
          const claimed = this.claimOne();
          if (!claimed) break;

          const worker = this.handleClaimed(claimed)
            .catch(err => {
              logger.error(`Worker failed for ${claimed.messageId}: ${err}`);
              try {
                this.spoolQueue.markFailed(claimed.messageId, claimed.serialKey, String(err));
              } catch (markErr) {
                logger.error(`Mark failed error: ${markErr}`);
              }
            });

          this.activeWorkers.add(worker);
          worker.finally(() => this.activeWorkers.delete(worker));
        }

        if (this.activeWorkers.size === 0) break;

        // Race against workers + a short poll tick: when a slow worker (e.g. claude -p sleep 50)
        // is running, Promise.race(workers) blocks the entire dispatch loop for the full duration,
        // and new cmd: messages arriving in pending/ sit there until that worker finishes.
        // The tick (200ms) lets the outer loop re-enter and call claimOne() to pick up
        // independent serialKey messages while the slow worker is still running.
        // Spec: 飞书侧"处理中可发命令 + 切换会话展示进展" (PR 2) — must process /list
        // in parallel with streaming session. (Bug found 2026-06-06 via integration test.)
        await Promise.race([
          ...Array.from(this.activeWorkers),
          new Promise<void>(resolve => setTimeout(resolve, 200)),
        ]);
      }
    } finally {
      this.running = false;
    }
  }

  /** Read live_progress config with defaults. */
  private get liveConfig(): LiveProgressConfig {
    return {
      intervalMs: config.get<number>('feishu_bot.live_progress.interval_ms', DEFAULT_LIVE_PROGRESS_CONFIG.intervalMs),
      maxTicks: config.get<number>('feishu_bot.live_progress.max_ticks', DEFAULT_LIVE_PROGRESS_CONFIG.maxTicks),
      maxPatchFailures: config.get<number>('feishu_bot.live_progress.max_patch_failures', DEFAULT_LIVE_PROGRESS_CONFIG.maxPatchFailures),
    };
  }

  /** Stop the user's live watcher if any. Idempotent.
   *  Async so callers can await clean shutdown (avoids cutting off in-flight
   *  patchCard when the daemon receives SIGTERM). */
  async stopLiveWatcher(openId: string, reason: string): Promise<void> {
    const w = this.liveWatchers.get(openId);
    if (w) {
      this.liveWatchers.delete(openId);
      await w.stop(reason);  // onStop callback handles the (no-op) re-delete
    }
  }

  /** Build overview card with live data — used by LiveProgressWatcher.tick() */
  buildLiveOverviewCard(
    uuid: string,
    entry: Pick<SessionEntry, 'title' | 'cwd' | 'message_count' | 'last_active' | 'origin' | 'status' | 'last_user_preview' | 'last_assistant_preview'>,
    isRunning: boolean,
    live: { lastUser?: string; lastAssistant?: string },
    runtime: { elapsedMs?: number; sinceLastOutputMs?: number } = {},
  ): Record<string, unknown> {
    return buildSessionOverviewCard(uuid, entry, isRunning, {
      lastUserPreview: live.lastUser,
      lastAssistantPreview: live.lastAssistant,
      elapsedMs: runtime.elapsedMs,
      sinceLastOutputMs: runtime.sinceLastOutputMs,
    });
  }

  /** Stop all live watchers — called from graceful shutdown.
   *  Async + Promise.all so we wait for every in-flight tick to settle
   *  before the daemon exits. */
  async shutdown(): Promise<void> {
    const watchers = Array.from(this.liveWatchers.values());
    this.liveWatchers.clear();
    // 新增:也停 agentView 的 attached watchers
    if (this.agentView) {
      await this.agentView.attachedWatchers.stopAll();
    }
    // Abort 所有在飞 rendezvous waits, 让 poll 循环干净退出
    for (const entry of this.activeRendezvousWaits.values()) entry.abort.abort();
    this.activeRendezvousWaits.clear();
    this.rendezvousCardUpdaters.clear();
    await Promise.all(watchers.map(w => w.stop('bot_shutdown')));
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  setReplyFn(fn: FeishuReplyFn): void {
    this.replyFn = fn;
  }

  setCardReplyFn(fn: FeishuBotCardReplyFn): void {
    this.cardReplyFn = fn;
  }

  setFeishuClient(client: any): void {
    this.feishuClient = client;
  }

  isRunning(): boolean {
    return this.running || this.activeWorkers.size > 0;
  }

  /** Resolve the user's defaultProvider to a Claude settings file path */
  private getSettingsPathForUser(openId: string): string | undefined {
    const entry = this.userManager.getEntry(openId);
    if (entry?.defaultProvider) {
      const provider = this.providerManager.resolve(entry.defaultProvider);
      if (provider) return provider.path;
    }
    return undefined;
  }

  /** Get the current provider alias for a user (for registry.lastKnownProvider) */
  private getCurrentProviderAliasForUser(openId: string): string | null {
    const entry = this.userManager.getEntry(openId);
    return entry?.defaultProvider ?? null;
  }

  /** Resolve the user's current working directory for /listDir */
  private getCwdForUser(openId: string): string {
    const entry = this.userManager.getEntry(openId);
    if (entry?.type === 'session' && entry.sessionUuid) {
      return entry.cwd || this.registry.get(entry.sessionUuid)?.cwd || '';
    }
    if (entry?.cwd) return entry.cwd;
    return config.get<string>('feishu_bot.default_cwd', '');
  }

  /** Handle card action callback from Feishu (card.action.trigger via WSClient) */
  async handleCardAction(
    payload: FeishuBotCardAction,
  ): Promise<string | Record<string, unknown> | null> {
    const { open_id: openId, action, message } = payload;
    const { tag } = action;
    let value = action.value;
    const messageId = message?.message_id;

    // v2.2.3 defense in depth: 旧的 start.ts 路径(以及未来潜在的 caller)
    // 可能错误地把 object value 序列化成 JSON 字符串塞进 action.value。
    // 这里做一次解析回退,并 WARN 提示上游有 regression。
    if (typeof value === 'string' && value.length > 0 && value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object') {
          logger.warn(
            `卡片回调 value 是 JSON 字符串而非对象,tag=${tag} — 上游可能有 regression,已 fallback parse`,
          );
          value = parsed as Record<string, unknown>;
        }
      } catch {
        // 解析失败保留原 string,后续 switch 会走 string 分支或落 default。
      }
    }

    if (!openId || !tag) {
      logger.warn(`卡片回调缺少必要字段: tag=${tag}, openId=${openId}`);
      return null;
    }

    // SAFE_ID_REGEX 校验：与 onMessage 一致，覆盖 11 处 recordReceipt 调用。
    // 不在白名单的 messageId 会让 recordReceipt 写 receipts/${messageId}.json
    // 时撞 ENAMETOOLONG 或 path-traversal；openId 同理。
    if (!isSafeId(openId) || !isSafeId(messageId ?? '')) {
      logger.warn(
        `卡片回调 ID 格式异常，拒绝: openId=${openId}, messageId=${messageId ?? '(none)'}`,
      );
      return null;
    }

    // Check for permission card interactions first
    const valueObj = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
    if (valueObj && (valueObj.type === 'permission_approve' || valueObj.type === 'permission_deny')) {
      const index = Number(valueObj.index);
      const handlerId = typeof valueObj.handlerId === 'string' ? valueObj.handlerId : '';
      if (!Number.isInteger(index)) {
        logger.warn(`Permission card: invalid index ${valueObj.index}`);
        return '参数错误，请重试';
      }
      return await this.handlePermissionCardAction(
        openId, valueObj.type === 'permission_approve', index, handlerId, messageId,
      );
    }

    if (valueObj && valueObj.type === 'cli_force_send') {
      return await this.handleForceSendCardAction(openId, valueObj, message?.message_id);
    }

    // Agent View card actions — dispatched to AgentViewManager.
    // Guarded by `this.agentView` so the bot still works in deployments that
    // haven't enabled agent_view. The 9 cases call methods that are stubbed
    // on AgentViewManager (real impls land in T14-T22).
    if (isAgentViewValue(valueObj)) {
      if (!this.agentView) {
        logger.warn(`agent_view card action 但 AgentViewManager 未启用: tag=${valueObj.tag}`);
        return 'Agent View 未启用';
      }
      // v2.2 修正:config 禁用时静默忽略(spec §G11)
      if (!config.get<boolean>('agent_view.enabled', true)) {
        logger.debug(`agent_view card action 但 agent_view.enabled=false: tag=${valueObj.tag}`);
        return null;
      }
      switch (valueObj.tag) {
        case 'agent_view_refresh_list':
          return await this.agentView.handleRefreshList(openId, messageId);
        case 'agent_view_refresh_peek':
          return await this.agentView.handleRefreshPeek(
            openId, valueObj.shortId, valueObj.sessionId, messageId,
          );
        case 'agent_view_peek':
          return await this.agentView.handlePeek(
            openId, valueObj.shortId, valueObj.sessionId, valueObj.cwd,
          );
        case 'agent_view_attach':
          return await this.agentView.handleAttach(
            openId, valueObj.sessionId, valueObj.shortId, valueObj.name, valueObj.cwd,
          );
        case 'agent_view_reply_request':
          await this.agentView.handleReplyRequest(
            openId, valueObj.shortId, valueObj.sessionId, valueObj.cwd, messageId,
          );
          return null;
        case 'agent_view_cancel_reply':
          await this.agentView.handleCancelReply(openId, messageId);
          return null;
        case 'agent_view_stop':
          return await this.agentView.handleStop(
            openId, valueObj.shortId, valueObj.sessionId, valueObj.name,
          );
        case 'agent_view_stop_confirm':
          return await this.agentView.handleStopConfirm(
            openId, valueObj.shortId, valueObj.sessionId, messageId,
          );
        case 'agent_view_back_to_chat':
          await this.agentView.handleBackToChat(openId);
          return null;
        // v2.2.11: bg-conflict 拒绝卡上的三个按钮
        case 'agent_view_stop_and_send':
          return await this.agentView.handleStopAndSend(
            openId, valueObj.shortId, valueObj.sessionId, valueObj.cwd, valueObj.text,
            valueObj.parentUuid ?? '', valueObj.hasParent === true,
            messageId,
          );
        case 'agent_view_new_and_send':
          return await this.agentView.handleNewAndSend(
            openId, valueObj.cwd, valueObj.text, messageId,
          );
        case 'agent_view_bg_conflict_cancel':
          return await this.agentView.handleBgConflictCancel(openId, messageId);
        case 'agent_view_stop_watching':
          await this.agentView.handleStopWatching(openId);
          return null;
        default:
          return null;
      }
    }

    // v2.2.3: start.ts now passes the full object as `value` (instead of pre-
    // extracting a string sessionId), so for legacy text-only buttons
    // (switch / resume / select_dir / ...) the sessionId is on `value.sessionId`.
    // Direct-test callers may still pass a raw string — keep both paths working.
    const sessionId = valueObj
      ? String(valueObj.sessionId ?? valueObj.value ?? '')
      : (value as string);

    switch (tag) {
      case 'help': {
        const reply = this.helpText();
        await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
        return reply;
      }
      case 'list':
        await this.doCardList(openId, messageId);
        return null;
      case 'new':
        await this.doCardNew(openId, messageId);
        return null;
      case 'switch':
        return await this.doSwitch(openId, sessionId, messageId);
      case 'resume': {
        const reply = await this.doResume(openId, sessionId);
        await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
        return reply;
      }
      case 'select_model': {
        const reply = await this.doSelectModel(openId, sessionId, messageId);
        await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
        return reply;
      }
      case 'clear_model': {
        const reply = await this.doClearModel(openId, messageId);
        await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
        return reply;
      }
      case 'select_dir':
        return await this.doSelectDir(openId, sessionId, messageId);
      case 'status': {
        const reply = await this.doStatus(openId);
        await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
        return reply;
      }
      case 'stop': {
        return await this.doStop(openId, messageId);
      }
      default: {
        const reply = `未知操作: ${tag}`;
        await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
        return reply;
      }
    }
  }

  /** Handle permission card button click — also returns card for WS response update */
  private async handlePermissionCardAction(
    openId: string,
    approved: boolean,
    index: number,
    handlerId: string,
    messageId?: string,
  ): Promise<string | Record<string, unknown> | null> {
    const handler = this.activePermissionHandlers.get(handlerId);
    if (!handler) {
      logger.warn(`Permission card: no active handler for handlerId=${handlerId}`);
      return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '⏱ 已过期' }, template: 'grey' },
        elements: [{ tag: 'markdown', content: '**权限确认已过期**，请重新触发该操作。' }],
      };
    }

    // Delay patch to avoid racing with Feishu's card action processing lock.
    // Feishu may lock the card during event handling; patching immediately
    // can be silently ignored. A short delay lets the event finish first.
    // We track the timer so the post-operation completion patcher can cancel
    // it — otherwise a late click patch could overwrite "✅ 已完成" with
    // "⏳ 处理中".
    if (this.feishuClient && messageId) {
      const timeout = setTimeout(async () => {
        this.activePermissionCardTimeouts.delete(messageId);
        try {
          logger.info(`Permission card: delayed patch starting, messageId=${messageId}`);
          const cardUpdater = new CardUpdater(this.feishuClient, { throttle_ms: 0 });
          cardUpdater.setCardMessageId(messageId);
          if (approved) {
            await cardUpdater.updatePermissionCardToProcessing();
          } else {
            await cardUpdater.updatePermissionCard(false);
          }
          logger.info(`Permission card: delayed patch completed, messageId=${messageId}`);
        } catch (err: any) {
          logger.warn(`Permission card: delayed patch failed: ${err}`);
        }
      }, 1200);
      this.activePermissionCardTimeouts.set(messageId, timeout);
    }

    const resolved = handler.resolveUserDecision(index, approved);
    if (!resolved) {
      return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '⏱ 已过期' }, template: 'grey' },
        elements: [{ tag: 'markdown', content: '**权限确认已过期**，请重新触发该操作。' }],
      };
    }

    // Return the new card directly — WSClient will send this back to Feishu
    // as the response to card.action.trigger, which should update the UI immediately.
    if (approved) {
      return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '⏳ 处理中...' }, template: 'blue' },
        elements: [{ tag: 'markdown', content: '**已允许**，Claude 正在执行该操作...' }],
      };
    }

    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '❌ 已拒绝' }, template: 'red' },
      elements: [{ tag: 'markdown', content: '操作已被拒绝，Claude 将尝试其他方式。' }],
    };
  }

  /** Handle CLI-busy card's force-send action: mark the pending message to skip activity check. */
  private async handleForceSendCardAction(
    openId: string,
    valueObj: Record<string, unknown>,
    messageId?: string
  ): Promise<string | Record<string, unknown> | null> {
    const entry = this.userManager.getEntry(openId);
    if (!entry?.sessionUuid) {
      return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '❌ 错误' }, template: 'red' },
        elements: [{ tag: 'markdown', content: '**会话不存在**' }],
      };
    }

    // 在 processing 目录中查找属于该 session 的消息
    const processingMsgs = this.spoolQueue.listProcessing()
      .filter(m => m.serialKey === entry.sessionUuid && m.openId === openId);

    if (processingMsgs.length === 0) {
      // User clicked but no message in processing/ for this session.
      // Possible causes: user double-clicked, bot restarted, or the message
      // was already force-sent by another path. Return a status card so the
      // user gets feedback rather than a silent no-op.
      return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'ℹ️ 消息已被处理' }, template: 'grey' },
        elements: [{
          tag: 'markdown',
          content: '**该消息已不在等待状态。**\n\n可能的原因：\n- 你点击了多次（重复点击会忽略后续的）\n- Bot 重启后该消息已被自动恢复处理\n- 该消息已被其他途径强制发送\n\n请检查飞书侧是否已收到该消息的回复。',
        }],
      };
    }

    const targetMsg = processingMsgs[0];

    // 标记为强制发送（CAS via lockfile）
    const updated = await this.spoolQueue.updateMessageFlags(
      targetMsg.messageId,
      targetMsg.serialKey,
      { skipActivityCheck: true, awaitingForceSend: false }
    );

    if (!updated) {
      return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '❌ 操作失败' }, template: 'red' },
        elements: [{ tag: 'markdown', content: '**消息标记失败，请重试。**\n\n该消息可能已被其他途径处理。' }],
      };
    }

    // 移回 pending/ 目录，让 worker 下一轮 dispatch 重新 claim
    // 重新 claim 时会看到 skipActivityCheck=true，跳过活跃检测直接处理
    const requeued = this.spoolQueue.requeueFromProcessing(
      targetMsg.messageId,
      targetMsg.serialKey
    );
    if (!requeued) {
      logger.warn(`强制发送后移回 pending 失败: ${targetMsg.serialKey}:${targetMsg.messageId}`);
      return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '❌ 操作失败' }, template: 'red' },
        elements: [{ tag: 'markdown', content: '**消息移回队列失败，请重试。**\n\n你可以发送一条新消息来覆盖。' }],
      };
    }

    // 失效缓存（让 worker 下次 loop 重新检测）
    this.sessionManager.activityCache?.invalidate(`feishu-detects-cli:${entry.sessionUuid}`);

    return null;
  }

  /** Claim one message from pending queue */
  private claimOne(): SpoolMessage | null {
    const pending = this.spoolQueue.listPending();
    for (const msg of pending) {
      const claimed = this.spoolQueue.claimNext(msg.serialKey);
      if (claimed) return claimed;
    }
    return null;
  }

  /**
  /** Process a claimed message (already moved to processing dir). */
  private async handleClaimed(msg: SpoolMessage): Promise<void> {
    // 【live progress】用户发新消息（非 command）→ 停止该用户的 live watcher
    // 命令（/list / /status 等）不打断 watcher，因为用户可能切到 session 后想查进展
    if (!isCommandMessage(msg.text)) {
      // .catch 防 unhandled rejection: stopLiveWatcher 现在 async, 未来若
      // onStop 内部加 throwable 步骤 (logging, metrics) 没 catch 会进程崩
      this.stopLiveWatcher(msg.openId, 'user_new_message').catch(err =>
        logger.error(`stopLiveWatcher(user_new_message) failed: ${err}`),
      );
    }

    if (this.spoolQueue.hasSentDelivery(msg.messageId)) {
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey, msg.replyMessageId);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey, msg.replyMessageId);
      return;
    }

    // Check for orphaned busy message (Issue 2.1)
    // If the message has been waiting for user to click "force-send" for too long,
    // auto-process it as if the user had clicked. Prevents infinite accumulation
    // of orphan messages in processing/ that get re-cycled by recoverProcessing.
    if (msg.awaitingForceSend && msg.busySinceAt) {
      const waited = Date.now() - new Date(msg.busySinceAt).getTime();
      if (waited >= FeishuBot.BUSY_TIMEOUT_MS) {
        logger.info(
          `Busy message ${msg.messageId} waited ${Math.floor(waited / 1000)}s, ` +
          `auto-processing as force-send (orphan timeout)`
        );
        this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, {
          skipActivityCheck: true,
          awaitingForceSend: false,
        });
        // Invalidate cache so next detection is fresh
        if (this.registry.get(msg.serialKey)) {
          this.sessionManager.activityCache?.invalidate(`feishu-detects-cli:${msg.serialKey}`);
        }
        // Continue processing (don't return)
      }
    }

    try {
      if (msg.responseText) {
        await this.replyAndFinalize(msg, msg.responseText);
      } else if (isCommandMessage(msg.text)) {
        await this.handleCommand(msg);
      } else {
        await this.handleChat(msg);
      }
    } catch (err: any) {
      if (err instanceof ReplyDeliveryPendingError) {
        this.spoolQueue.requeueForRetry(msg.messageId, msg.serialKey, err.message, err.delayMs);
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      this.spoolQueue.markFailed(msg.messageId, msg.serialKey, message);
      try {
        const outcome = await this.replyTo(msg, `处理失败: ${message}`);
        if (outcome.completed) {
          this.spoolQueue.markReplied(msg.messageId, msg.serialKey, outcome.replyMessageId ?? undefined);
        }
      } catch (replyErr) {
        logger.error(`错误回复也失败了: ${replyErr}`);
      }
    }
  }

  /**
   * Dispatch a `/` command message to the appropriate handler.
   *
   * v2.4.x fix: 命令消息不再经过 handleChat (走独立 fast path), 所以
   * expectedReply 清空逻辑也从 handleChat 搬到这里, 保证所有写命令都清
   * (包括 /list, /switch, /new, /stop 等)。否则用户 Agent View 流程里:
   *   1. 点 [Reply] 设 expectedReply=session A
   *   2. /switch B → user-mapping 切到 B, 但 expectedReply 还 set 着 A
   *   3. 发文本 → handleChat 看到 expectedReply 有 → 发到 A (BUG)
   *
   * 只读命令 (/help, /status, /whoami) 不清, 跟 handleChat 行为一致。
   */
  async handleCommand(msg: SpoolMessage): Promise<void> {
    const parts = msg.text.split(/\s+/);
    const cmd = parts[0]?.replace(/^\/+/, '')?.toLowerCase();

    // v2.4.x: 命令消息入口清 expectedReply (只在写命令)
    // 防御: 旧 mock 可能没装 expectedReply (Field like), 跳过而不是 throw
    const isReadOnly = ['help', 'status', 'whoami'].includes(cmd || '');
    if (!isReadOnly && this.agentView?.expectedReply) {
      const info = this.agentView.expectedReply.get(msg.openId);
      if (info) {
        await this.agentView.expectedReply.clear(msg.openId, 'overwrite');
        await this.replyFn(
          `⏱ 等待输入已自动取消(因你跑了 /${cmd})`,
          { openId: msg.openId, requestUuid: uniqueUuid() },
        );
      }
    }

    switch (cmd) {
      case 'help':
        await this.replyAndFinalize(msg, this.helpText());
        return;

      case 'list':
        await this.handleList(msg);
        return;

      case 'listdir':
        await this.handleListDir(msg);
        return;

      case 'new':
        await this.handleNew(msg, msg.text.replace(/^\/new\b\s*/i, ''));
        return;

      case 'switch':
        await this.handleSwitch(msg, parts.slice(1).join(' '));
        return;

      case 'model':
        await this.handleModel(msg, parts.slice(1).join(' '));
        return;

      case 'resume':
        await this.handleResume(msg, parts.slice(1).join(' '));
        return;

      case 'status':
        await this.handleStatus(msg);
        return;

      case 'stop':
        await this.handleStop(msg);
        return;

      case 'whoami':
        await this.replyAndFinalize(msg, `你的 open_id: ${msg.openId}\n\n将其填入 config.toml 的 feishu_bot.owner_open_id 可限制仅你本人使用。`);
        return;

      case 'agents':
        if (!this.agentView) {
          await this.replyAndFinalize(msg, 'Agent View 未启用(检查 config.toml [agent_view].enabled)');
          return;
        }
        // v2.2 修正:config 禁用时显式提示(spec §G11)
        if (!config.get<boolean>('agent_view.enabled', true)) {
          await this.replyAndFinalize(msg, 'Agent View 已禁用(在 config.toml 设置 [agent_view].enabled = true)');
          return;
        }
        // v2.3.14 修正:handleList 之前返回 void,spool 消息卡在 processing/ 永远不 finalize,
        // 100 条累积后 enqueue 触发"队列满"fallback → 用户看到"服务暂不可用"。
        // 同 v2.3.11 handleReply 路径同模式 bug:依赖 handleXxx 内部收尾是不可靠的,
        // 必须 caller 显式 markReplied + markDone 释放 serialKey 锁。
        const cardMessageId = await this.agentView.handleList(msg.openId, msg.messageId);
        this.spoolQueue.markReplied(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
        this.spoolQueue.markDone(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
        return;

      default:
        await this.replyAndFinalize(msg, `未知命令: /${cmd}\n\n${this.helpText()}`);
        return;
    }
  }

  private async handleChat(msg: SpoolMessage): Promise<void> {
    // v2.4.x: 预期消息只可能是普通文本(命令消息在 dispatcher 就走 handleCommand
    // 不进这里)。原 spec §5.3 提到的"写命令清 expectedReply"逻辑已搬到
    // handleCommand 入口(命令消息必走), 这里只剩 /cancel + 普通文本分支。
    if (this.agentView && config.get<boolean>('agent_view.enabled', true)) {
      // 新增:任何进入 handleChat 的消息都停掉当前 attached watch
      if (this.agentView.attachedWatchers.has(msg.openId)) {
        void this.agentView.attachedWatchers.stop(msg.openId, 'user_chat', { patchFinal: true });
      }
      if (msg.text === '/cancel') {
        await this.agentView.handleCancelReply(msg.openId, msg.messageId);
        return;
      }
      // 注意: 这里的 if (msg.text.startsWith('/')) 分支在 v2.4.x 已成死代码 —
      // 命令消息在 dispatcher (line ~848) 走 isCommandMessage → handleCommand
      // 不进 handleChat。保留只是为了 safety net (万一某条消息漏过 dispatcher)。
      if (msg.text.startsWith('/')) {
        const cmd = msg.text.split(/\s+/)[0]?.replace(/^\/+/, '').toLowerCase();
        // 只读命令直接转交 (不清 expectedReply)
        const isReadOnly = ['help', 'status', 'whoami'].includes(cmd || '');
        if (!isReadOnly) {
          // 写命令: 防御性清 expectedReply + 提示
          const info = this.agentView.expectedReply.get(msg.openId);
          if (info) {
            await this.agentView.expectedReply.clear(msg.openId, 'overwrite');
            await this.replyFn(
              `⏱ 等待输入已自动取消(因你跑了 /${cmd})`,
              { openId: msg.openId, requestUuid: uniqueUuid() },
            );
          }
        }
        await this.handleCommand(msg);
        return;
      }
      // 非 / 开头普通消息:检查 expectedReply
      const info = this.agentView.expectedReply.get(msg.openId);
      if (info) {
        // v2.3.11 修正:reply 路径必须显式 markReplied + markDone。
        //
        // handleReply 内部用 replyFn 直接发"✅ Claude 已处理完..."/"❌ Reply 失败..."
        // 反馈,replyFn(`src/cli/commands/start.ts:332`)只调飞书 API,不写 spool
        // delivery。handleClaimed 在 catch 里才 markFailed,正常返回不做收尾。结果是
        // 这条 spool 消息永远卡在 processing/。SpoolQueue.claimNext 看到同 serialKey
        // (`new:openId`)的残骸就 return null,后续 reply 全部 starve 在 pending/ —
        // 用户体验:"再次点 Reply → 看到 prompt → 输入文字 → 没反应"。
        //
        // handleReply 内层已经包了 try/finally,无论 SDK 是否成功都已 replyFn 反馈给
        // 用户;外层这里只做 spool 收尾。handleReply 自己抛(replyFn 网络挂 / patch 失败
        // 等极端 case)则 markFailed 兜底,同样把锁放掉。
        try {
          await this.agentView.handleReply(msg.openId, msg.text);
          this.spoolQueue.markReplied(msg.messageId, msg.serialKey);
          this.spoolQueue.markDone(msg.messageId, msg.serialKey);
        } catch (err: any) {
          this.spoolQueue.markFailed(
            msg.messageId,
            msg.serialKey,
            err?.message ?? String(err),
          );
        }
        return;
      }
    }
    switch (msg.target.type) {
      case 'session': {
        const sessionUuid = msg.target.sessionUuid ?? '';
        const currentEntry = this.registry.get(sessionUuid);
        const cwd = msg.target.cwd || currentEntry?.cwd || process.env.HOME || '/';

        // v2.4.x: 如果 entry 是 attached 的,直接走 rendezvous 路径,跳过 busy check
        // (probe 2026-06-13 证明 done/stopped/idle bg 收到 reply 会 respawn 处理;
        // busy 卡因 CPU 抖动误报,不再适用 attached-chat 场景)
        const userEntry = this.userManager.getEntry(msg.openId);
        if (userEntry?.type === 'session' && userEntry.attachedAt && userEntry.sessionUuid === sessionUuid) {
          // attached chat: 走 runChatSDK + fromAttachedChat=true,内部会触发 tryRendezvousReply
          const settingsPath = this.getSettingsPathForUser(msg.openId);
          const promptText = buildPromptWithImages(msg.text, msg.imagePaths ?? []);
          let runResult: Awaited<ReturnType<FeishuBot['runChatSDK']>> | null = null;
          try {
            runResult = await this.runChatSDK({
              openId: msg.openId,
              sessionUuid,
              cwd,
              settingsPath,
              promptText,
              serialKey: msg.serialKey,
              isNew: false,
              messageId: msg.messageId,
              fromAttachedChat: true,  // 新 flag,触发 tryRendezvousReply
            });
          } catch (err: any) {
            this.spoolQueue.markReplied(msg.messageId, msg.serialKey);
            this.spoolQueue.markFailed(msg.messageId, msg.serialKey, String(err?.message ?? err));
            this.cancelledMessageIds.delete(msg.messageId);
            return;
          }
          // 跟现有路径同款 spool 收尾 (mirrors lines 1103-1122)
          const { result, cardMessageId } = runResult;
          // v2.4.x: 守护 last_error — rendezvous 路径没有 SDK 视角的错误信息,
          // 不应该盲目清掉。message_count 始终 +1(不论谁处理)。
          this.registry.upsert(sessionUuid, {
            cwd, last_active: new Date().toISOString(),
            last_message_preview: preview(msg.text) || (msg.imagePaths?.length ? '[图片]' : ''),
            // rendezvous 路径下保留旧 last_error(我们不知道 rendezvous 的内部错误状态);
            // SDK fallback 路径下用 result.error。undefined 会被 upsert 过滤掉。
            last_error: runResult.rendezvousHandled ? undefined : (result?.error ?? null),
            status: result?.sessionStatus === 'degraded' ? 'degraded' : 'active',
            jsonl_path: result?.jsonlPath ?? undefined,
            pending_jsonl_resolve: result?.jsonlPath ? false : currentEntry?.pending_jsonl_resolve,
            message_count: (currentEntry?.message_count ?? 0) + 1,
          });
          await this.registry.flush();
          if (runResult.rendezvousHandled) {
            // rendezvous 路径已在 tryRendezvousReply 内部发完 chat-text reply
            this.spoolQueue.markReplied(msg.messageId, msg.serialKey);
            this.spoolQueue.markDone(msg.messageId, msg.serialKey);
          } else {
            // fallback 到 SDK 路径,正常收尾
            this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, {
              responseText: result?.response || '(空回复)',
            });
            if (cardMessageId) {
              this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, cardMessageId, 1);
            }
            this.spoolQueue.markReplied(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
            this.spoolQueue.markDone(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
            // 镜像原 runChatSDK 收尾:repairJsonlLastPrompt + cancelledMessageIds 清理
            const jlPath = result?.jsonlPath ?? currentEntry?.jsonl_path;
            if (jlPath) { try { repairJsonlLastPrompt(jlPath); } catch {} }
            this.cancelledMessageIds.delete(msg.messageId);
          }
          return;
        }

        // 原有 busy check 块 —— 不动
        if (!msg.skipActivityCheck && currentEntry) {
          try {
            const status = await isSessionActive(
              currentEntry,
              this.sessionManager.activityCache ?? new SessionActivityCache(),
              'feishu-detects-cli'
            );
            if (status.isProcessing && status.confidence !== 'low') {
              // 修:busy + bg worker 共存时,优先发 3 按钮 bg-conflict 卡(让用户选 stop_bg / new_session / cancel),
              // 不发 1 按钮 busy 卡(信息不全,user 没法做选择)。原来 runChatSDK 里只有 session 不 busy 才查 bg-conflict,
              // 这次把检查提前到 busy 路径,两种状态都覆盖。
              const bgConflict = this.checkBgConflict(sessionUuid, cwd, msg.text);
              if (bgConflict) {
                const conflictCardId = await this.sendBgConflictCard(msg, bgConflict);
                logger.info(
                  `[activity] bg-conflict card sent (busy+bg): messageId=${msg.messageId}, conflictCardId=${conflictCardId}`,
                );
                const updateFields: any = {
                  awaitingForceSend: true,
                  busySinceAt: new Date().toISOString(),
                };
                if (conflictCardId) updateFields.replyMessageId = conflictCardId;
                this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, updateFields);
                return;
              }
              const busyCardId = await this.sendCLIBusyCard(msg, currentEntry, status);
              logger.info(`[activity] busy card created: messageId=${msg.messageId}, busyCardId=${busyCardId}`);
              // Keep message in processing/ with awaitingForceSend=true so user can force-send.
              // Record busyCardId as replyMessageId so cleanup processes can track the card.
              // Set busySinceAt for orphan-message timeout (Issue 2.1).
              this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, {
                awaitingForceSend: true,
                replyMessageId: busyCardId,
                busySinceAt: new Date().toISOString(),
              });
              return;
            }
          } catch (err) {
            logger.warn(`会话活跃检测失败: ${err}`);
            // 降级：允许发送
          }
        }

        const useSDK = config.get<boolean>('sdk.enabled', true);
        if (useSDK) {
          const settingsPath = this.getSettingsPathForUser(msg.openId);
          const promptText = buildPromptWithImages(msg.text, msg.imagePaths ?? []);
          let runResult: Awaited<ReturnType<FeishuBot['runChatSDK']>> | null = null;
          try {
            runResult = await this.runChatSDK({
              openId: msg.openId,
              sessionUuid,
              cwd,
              settingsPath,
              promptText,
              serialKey: msg.serialKey,
              isNew: false,
              messageId: msg.messageId,
            });
          } catch (err: any) {
            // runChatSDK 已经把卡片标为 error 并 dispose;只做 SpoolQueue / 取消清理
            this.spoolQueue.markReplied(msg.messageId, msg.serialKey);
            this.spoolQueue.markFailed(msg.messageId, msg.serialKey, String(err?.message ?? err));
            this.cancelledMessageIds.delete(msg.messageId);
            return;
          }
          const { result, cardMessageId } = runResult;
          this.registry.upsert(sessionUuid, {
            cwd, last_active: new Date().toISOString(),
            last_message_preview: preview(msg.text) || (msg.imagePaths?.length ? '[图片]' : ''),
            last_error: result.error ?? null,
            status: result.sessionStatus === 'degraded' ? 'degraded' : 'active',
            jsonl_path: result.jsonlPath ?? undefined,
            pending_jsonl_resolve: result.jsonlPath ? false : currentEntry?.pending_jsonl_resolve,
            message_count: (currentEntry?.message_count ?? 0) + 1,
          });
          await this.registry.flush();
          this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, { responseText: result.response || '(空回复)' });
          if (cardMessageId) {
            this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, cardMessageId, 1);
          }
          this.spoolQueue.markReplied(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
          this.spoolQueue.markDone(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
          const jlPath = result.jsonlPath ?? currentEntry?.jsonl_path;
          if (jlPath) { try { repairJsonlLastPrompt(jlPath); } catch {} }
          this.cancelledMessageIds.delete(msg.messageId);
        } else if (config.get<boolean>('stream.enabled', false)) {
          await this.handleChatStreaming(msg, sessionUuid, cwd, currentEntry);
        } else {
          await this.handleChatNonStreaming(msg, sessionUuid, cwd, currentEntry);
        }
        return;
      }

      case 'new_session_claim': {
        const claimMessageId = msg.target.claimMessageId ?? msg.messageId;
        const claimResult = await this.userManager.claimPendingNewSession(msg.openId, claimMessageId);

        if (claimResult.status === 'creating') {
          await this.replyAndFinalize(msg, '新会话正在创建，请稍后重试，或执行 /list 查看是否已生成。');
          return;
        }

        if (claimResult.status !== 'claimed') {
          await this.replyAndFinalize(msg, '新会话创建入口已失效，请重新执行 /new。');
          return;
        }

        const useSDK = config.get<boolean>('sdk.enabled', true);
        if (useSDK) {
          await this.createSessionFromPromptSDK(msg, msg.target.cwd ?? claimResult.entry.cwd ?? '', claimMessageId, msg.text);
        } else if (config.get<boolean>('stream.enabled', false)) {
          await this.createSessionFromPromptStreaming(msg, msg.target.cwd ?? claimResult.entry.cwd ?? '', claimMessageId, msg.text);
        } else {
          await this.createSessionFromPrompt(msg, msg.target.cwd ?? claimResult.entry.cwd ?? '', claimMessageId, msg.text);
        }
        return;
      }

      case 'new_session_creating':
        await this.replyAndFinalize(msg, '新会话正在创建，请稍后重试，或执行 /list 查看是否已生成。');
        return;

      case 'no_target':
      default:
        await this.replyAndFinalize(msg, [
          '当前没有活跃会话。',
          '请先执行以下任一命令：',
          '1. /list',
          '2. /switch <ID>',
          '3. /new [cwd] [-- prompt]',
        ].join('\n'));
        return;
    }
  }

  private async sendCLIBusyCard(
    msg: SpoolMessage,
    entry: any,
    status: ActivityResult,
  ): Promise<string> {
    // L1084 是全文件唯一一个没有 feishuClient null check 的 new CardUpdater 调用点。
    // feishuClient 为 null 时 throw → handleChat catch → 降级:允许发送(无卡片能力时合理)。
    if (!this.feishuClient) {
      throw new Error('feishuClient is null, cannot send busy card');
    }
    const cardUpdater = new CardUpdater(this.feishuClient, { throttle_ms: 0 });
    return await cardUpdater.createCLIBusyCard(
      msg.openId,
      entry?.title ?? '未命名会话',
      status
    );
  }

  /**
   * 修:busy 路径升级 — 检查 session 是否仍被 bg worker 持有。
   * 若有,返回 bg-conflict 卡所需数据(供 sendBgConflictCard 使用);
   * 若无,返回 null(走原 1 按钮 busy 卡)。
   *
   * 复用 runChatSDK 里的逻辑(readRoster + workerPid + parentUuid 计算),
   * 提取为 helper 让两条路径(busy + runChatSDK)都用同一份。
   */
  private checkBgConflict(
    sessionUuid: string,
    cwd: string,
    text: string,
  ): { name: string; shortId: string; sessionId: string; cwd: string; text: string; workerPid?: number; parentUuid?: string | null } | null {
    if (!sessionUuid) return null;
    const roster = _bgConflictHooks.readRoster();
    const short = sessionUuid.slice(0, 8);
    const worker = roster?.workers?.[short];
    if (!worker) return null;
    const workerPid = (worker as any).pid;
    const workerName = (worker as any).dispatch?.seed?.name || short;
    // parent UUID 从 roster.launch.sessionId 提取 basename(同 runChatSDK 逻辑)
    let parentUuid: string | null = null;
    try {
      const parentPath = _bgConflictHooks.lookupResumeFromPath(roster, short);
      if (parentPath) {
        const id = parentPath.split('/').pop()?.replace(/\.jsonl$/, '') ?? '';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
          parentUuid = id;
        }
      }
    } catch {
      // ignore
    }
    return {
      name: workerName,
      shortId: short,
      sessionId: sessionUuid,
      cwd,
      text,
      workerPid,
      parentUuid,
    };
  }

  /** 发 3 按钮 bg-conflict 卡(供 busy 路径用) */
  private async sendBgConflictCard(
    msg: SpoolMessage,
    info: NonNullable<ReturnType<typeof this.checkBgConflict>>,
  ): Promise<string | null> {
    if (!this.cardReplyFn) return null;
    const card = buildBgConflictCard(info);
    try {
      return await this.cardReplyFn(JSON.parse(card), { openId: msg.openId });
    } catch (err: any) {
      logger.warn(`sendBgConflictCard failed: ${err?.message ?? err}`);
      return null;
    }
  }

  /** Non-streaming path for existing session messages (extracted from original handleChat session case) */
  private async handleChatNonStreaming(
    msg: SpoolMessage, sessionUuid: string, cwd: string, currentEntry: any,
  ): Promise<void> {
    const settingsPath = this.getSettingsPathForUser(msg.openId);
    const promptText = buildPromptWithImages(msg.text, msg.imagePaths ?? []);
    const result = await this.sessionManager.sendMessage(sessionUuid, promptText, cwd, false, msg.serialKey, settingsPath);

    this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, {
      responseText: result.response || '(空回复)',
    });

    this.registry.upsert(sessionUuid, {
      cwd,
      last_active: new Date().toISOString(),
      last_message_preview: preview(msg.text) || (msg.imagePaths?.length ? '[图片]' : ''),
      last_error: result.error ?? null,
      status: result.sessionStatus === 'degraded' ? 'degraded' : 'active',
      jsonl_path: result.jsonlPath ?? undefined,
      pending_jsonl_resolve: result.jsonlPath ? false : currentEntry?.pending_jsonl_resolve,
      message_count: (currentEntry?.message_count ?? 0) + 1,
    });
    await this.registry.flush();

    const jsonlPath = result.jsonlPath ?? currentEntry?.jsonl_path;
    if (jsonlPath) {
      try {
        repairJsonlLastPrompt(jsonlPath);
      } catch (err) {
        logger.warn(`修复 JSONL last-prompt 失败: ${err}`);
      }
    }

    await this.replyAndFinalize(msg, result.response || '(空回复)');
  }

  /** Streaming path for existing session messages */
  private async handleChatStreaming(
    msg: SpoolMessage, sessionUuid: string, cwd: string, currentEntry: any,
  ): Promise<void> {
    const startTime = Date.now();
    let thinking = '';
    let text = '';
    let cardUpdater: CardUpdater | null = null;
    let cardMessageId: string | null = null;
    let cardInitFailed = false;

    try {
      if (this.feishuClient) {
        cardUpdater = new CardUpdater(this.feishuClient, {
          throttle_ms: config.get<number>('stream.throttle_ms', 1500),
          max_card_bytes: config.get<number>('stream.max_card_bytes', 25000),
          show_thinking: config.get<boolean>('stream.show_thinking', true),
        });
        cardMessageId = await cardUpdater.startProcessing(msg.openId);
      }
    } catch (err: any) {
      logger.warn(`Stream: 发送处理中卡片失败: ${err}`);
      cardInitFailed = true;
    }

    try {
      const settingsPath = this.getSettingsPathForUser(msg.openId);
      const promptText = buildPromptWithImages(msg.text, msg.imagePaths ?? []);
      const result = await this.sessionManager.sendStreamingMessage(
        sessionUuid, promptText, cwd,
        (chunk: StreamChunk) => {
          if (cardInitFailed || !cardUpdater) return;
          if (chunk.type === 'thinking') thinking += chunk.content;
          else if (chunk.type === 'text') text += chunk.content;
          const elapsed = Date.now() - startTime;
          cardUpdater.updateStream(
            config.get<boolean>('stream.show_thinking', true) ? thinking : '',
            text, elapsed
          ).catch(e => logger.warn(`Stream: update failed: ${e}`));
        },
        false, msg.serialKey, settingsPath,
      );

      // Finalize card
      if (cardUpdater) {
        const wasCancelled = this.cancelledMessageIds.has(msg.messageId);
        if (wasCancelled) {
          this.cancelledMessageIds.delete(msg.messageId);
          await cardUpdater.cancel();
        } else if (cardUpdater.shouldFallbackToText(text)) {
          const truncated = cardUpdater.truncateContent(text);
          await cardUpdater.complete(truncated, result.tokensIn ?? 0, result.tokensOut ?? 0, result.durationMs, 1);
          const remainder = text.slice(truncated.length);
          if (remainder && config.get<boolean>('stream.fallback_to_text', true)) {
            for (const chunk of splitReplyText(remainder, 3900)) {
              await this.replyFn(chunk, { messageId: msg.messageId, openId: msg.openId });
            }
          }
        } else {
          await cardUpdater.complete(text, result.tokensIn ?? 0, result.tokensOut ?? 0, result.durationMs, 1);
        }
        cardMessageId = cardUpdater.getCardMessageId();
        cardUpdater.dispose();
      }

      // Update registry
      this.registry.upsert(sessionUuid, {
        cwd, last_active: new Date().toISOString(), last_message_preview: preview(msg.text) || (msg.imagePaths?.length ? '[图片]' : ''),
        last_error: result.error ?? null,
        status: result.sessionStatus === 'degraded' ? 'degraded' : 'active',
        jsonl_path: result.jsonlPath ?? undefined,
        pending_jsonl_resolve: result.jsonlPath ? false : currentEntry?.pending_jsonl_resolve,
        message_count: (currentEntry?.message_count ?? 0) + 1,
      });
      await this.registry.flush();

      // Finalize spool
      this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, { responseText: result.response || '(空回复)' });
      if (cardMessageId) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, cardMessageId, 1);
      }
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey, cardMessageId ?? undefined);

      // JSONL repair
      const jlPath = result.jsonlPath ?? currentEntry?.jsonl_path;
      if (jlPath) { try { repairJsonlLastPrompt(jlPath); } catch {} }

      this.cancelledMessageIds.delete(msg.messageId);
    } catch (err: any) {
      cardMessageId = await this._handleStreamError(msg, err, cardUpdater, cardInitFailed, cardMessageId, false);
    }
  }

  /**
   * Try to handle an Agent View Reply via the rendezvous socket.
   *
   * Returns true if handled — a reply (success or error) has been sent
   * to the user via replyFn, and spool has been finalized. Caller should
   * short-circuit (return from runChatSDK with rendezvousHandled: true).
   *
   * Returns false if rendezvous is not eligible — caller should fall
   * through to the existing v2.3.5 auto-stop + SDK path.
   *
   * v2.4.x 失败处理(基于 docs/qa/2026-06-11-rendezvous-probe-notes.md 真协议):
   *   - canUse=false (daemon_down, bg_busy, no_rendezvous_sock) → return false
   *     so caller falls through to v2.3.5 auto-stop + SDK
   *   - inject ok → return true (成功路径)
   *   - inject socket_closed (Phase 1 ECONNREFUSED 等真连接失败) → return false
   *     v2.3.5 claude stop (对死 bg 是 no-op) + SDK resume 仍能工作
   *   - inject daemon_error (state.json 缺失) → return false (同上)
   *   - inject timeout (bg 在跑但 state.json 一直不终结) → return true, 仅报告
   *     fallback 会 claude stop 打断活 bg, 风险大
   *   - inject state_error / 其他 reason → return true, 仅报告
   */
  /**
   * v2.4.x: 返 { handled, bgAskedNewQuestion, cardMessageId } 替代之前的 boolean。
   * - handled=true: rendezvous 路径已处理, caller 不要再走 SDK
   * - bgAskedNewQuestion=true: bg 跑了并问新问题, caller (handleReply)
   *   应该重新 set expectedReply 让用户直接接着回
   * - cardMessageId: 处理中卡 → 等待卡 (transition 后) 的 messageId,
   *   给 caller re-set expectedReply 用
   */
  private async tryRendezvousReply(params: {
    openId: string;
    sessionUuid: string;
    promptText: string;
    cwd: string;
    messageId?: string;
  }): Promise<{
    handled: boolean;
    bgAskedNewQuestion: boolean;
    cardMessageId: string | null;
  }> {
    const { openId, sessionUuid, promptText, cwd, messageId } = params;
    const short = sessionUuid.slice(0, 8);
    const eligibility = await checkRendezvousEligibility(short);
    if (!eligibility.canUse || !eligibility.rendezvousSock) {
      logger.warn(`rendezvous: fallback to SDK because ${eligibility.reason}`);
      return { handled: false, bgAskedNewQuestion: false, cardMessageId: null };
    }
    logger.info(
      `rendezvous: inject short=${short} text_len=${promptText.length} reason=${eligibility.reason}`,
    );
    const timeoutMs = config.get<number>('agent_view.rendezvous_timeout_ms', 60_000);

    // v2.4.x 流式 reply: 提交 + 接管"等待输入"卡 + 边 poll 边流式 patch
    //
    // 流程:
    //   1. Phase 1 (≤200ms): fire-and-forget 提交 reply 到 bg
    //      - 成功 submitted → 进入第 2 步
    //      - 失败 rejected (ECONNREFUSED 等) → return false 走 v2.3.5
    //   2. 接管"等待输入"卡 (有 messageId 时) 或新发"处理中"卡
    //   3. Phase 2 (≤timeoutMs): pollStateJsonStreaming + onPoll 回调
    //      - 每次 poll: 读 JSONL 末次 assistant turn, 文本变化就 patch
    //      - 终结 (done/stopped/blocked-needs/error) → 终态 patch
    //   4. 失败 fallback (socket_closed/daemon_error): 走 v2.3.5 SDK
    //      (Phase 1 已经做了 ECONNREFUSED 检测, 这里 catch Phase 2 的 daemon_error)
    return await this.runStreamingRendezvousReply({
      openId, sessionUuid, promptText, cwd, messageId, eligibility, timeoutMs,
    });
  }

  /**
   * v2.4.x 流式 reply 实际实现。从 tryRendezvousReply 拆出来,
   * 让主流程读起来线性(失败返 false, 成功返 true)。
   */
  private async runStreamingRendezvousReply(params: {
    openId: string;
    sessionUuid: string;
    promptText: string;
    cwd: string;
    messageId?: string;
    eligibility: Awaited<ReturnType<typeof checkRendezvousEligibility>>;
    timeoutMs: number;
  }): Promise<{
    handled: boolean;
    bgAskedNewQuestion: boolean;
    cardMessageId: string | null;
  }> {
    const { openId, sessionUuid, promptText, cwd, messageId, eligibility, timeoutMs } = params;
    const short = sessionUuid.slice(0, 8);

    // v2.4.1: Capture pre-injection baseline. Reading JSONL BEFORE submit ensures
    // we have the truly previous turn (bg hasn't been woken up yet, can't have
    // started writing). This baseline is used by:
    //   - onPoll: detect when bg writes a new turn (compare currentText !== baselineText)
    //   - terminal 'done'/'new_needs' branches: poll for new turn to avoid race
    //     between state.json update and JSONL flush
    const preBaselineTurn = eligibility.jsonlPath
      ? await readLastAssistantTurn(eligibility.jsonlPath)
      : null;
    const preBaselineText: string | null = preBaselineTurn?.text ?? null;

    // Phase 1: 提交
    const submit = await RendezvousClient.submitReplyOnly(
      eligibility.rendezvousSock!, promptText,
    );
    if (submit === 'rejected') {
      logger.warn(
        `rendezvous: submit rejected (ECONNREFUSED/EPIPE) → falling back to v2.3.5`,
      );
      return { handled: false, bgAskedNewQuestion: false, cardMessageId: null };
    }

    // v2.4.x 分层卡片: 总是新发"处理中"卡。原"↩️ 回复"等待卡保留为
    // 历史不动, 不会被 transition。这样 chat 列表保留完整上下文:
    //   [旧等待卡(黄)] → 继续 → [新处理中卡(蓝)] → 终结 → [完成/新等待(绿/黄)]
    // 旧设计 "接管等待卡" 会丢掉 waiting reason / cwd / recent output,
    // 而且 transition 过程用户看不清卡在切换。
    const cardUpdater = new CardUpdater(this.feishuClient!, {
      throttle_ms: 5000,  // v2.4.x: 流式 patch 5s 节流
    });
    // 总是新发"处理中"卡。原"↩️ 回复"等待卡保留为历史, 不动。
    await cardUpdater.startProcessing(openId);

    // Phase 2: 边 poll 边流式 patch
    const startTime = Date.now();
    let lastText = '';
    let streamCount = 0;
    // v2.4.1: 使用 preBaselineText (submit 前捕获) 而非首次 poll 捕获的 baseline。
    // 首次 poll 捕获太晚 —— bg 可能已经写完新 turn,baseline 变成新 turn,
    // 永远检测不到"新 turn"。
    let isNewTurn = false;
    // baselineText 闭包捕获 preBaselineText (因为 onPoll 是 async 闭包)
    // v2.4.x: bg 跑了并问新问题 (new_needs) → 告诉 caller re-set expectedReply
    let bgAskedNewQuestion = false;

    const rendezvousResult = await RendezvousClient.pollStateJsonStreaming({
      short,
      stateJsonPath: eligibility.stateJsonPath!,
      timeoutMs,
      // poll 间隔: 默认 500ms (RendezvousClient 内部), 配合 5s 卡片节流
      // 形成 1Hz 卡片刷新节奏
      onPoll: async (state) => {
        if (state.kind === 'active' && eligibility.jsonlPath) {
          // bg 在跑: 读 JSONL 末次 turn (含 thinking + tool_uses + text)
          const lastTurn = await readLastAssistantTurn(eligibility.jsonlPath);
          const currentText = lastTurn?.text ?? '';
          const currentThinking = lastTurn?.thinking ?? '';
          const currentToolUses = lastTurn?.toolUses ?? [];

          // v2.4.1: 使用 submit 前捕获的 preBaselineText (而不是首次 poll 的 baseline)。
          // 这让"新 turn 检测"在 bg 写盘时序与 poll 时序错位时也正确。

          // 检测是否进入新 turn: text 完全不同于基线
          if (currentText !== preBaselineText && !isNewTurn) {
            isNewTurn = true;
          }

          // 总是 update stream — 即使没新内容也更新 elapsed time (5s tick)。
          // CardUpdater.updateStream 内部 5s 节流, 不会真每 500ms 都 patch。
          // 这样用户至少看到"⏱ 5s" → "⏱ 10s" 持续变化, 知道 bg 还活着。
          //
          // v2.4.x: 进入新 turn 后, 把 thinking + toolUses + text 一起传过去,
          // 让卡片展示"💭 思考过程" / "🔧 当前操作" / "📝 回复" 三段。
          const showRich = isNewTurn;
          await cardUpdater.updateStream(
            showRich ? currentThinking : '',
            showRich ? currentText : '',
            Date.now() - startTime,
            showRich ? currentToolUses : [],
          ).catch(err => logger.warn(`rendezvous: updateStream failed: ${err?.message ?? err}`));

          if (isNewTurn && currentText !== lastText) {
            lastText = currentText;
            streamCount += 1;
            logger.debug(
              `rendezvous: stream patch #${streamCount} text_len=${lastText.length} ` +
              `thinking_len=${currentThinking.length} tools=${currentToolUses.length}`,
            );
          }
        } else if (state.kind === 'blocked-needs') {
          // bg 又问新问题: 提前结束轮询, caller 会基于 onPoll 已设的 lastState
          // 判定 reason='new_needs'。卡片 patch 留给 caller 在终态统一处理
          // (调 patchWaitingCard 而不是 cancel, 避免"已取消"误报)。
          return 'stop';
        } else {
          // v2.4.1: pre-state-change (stale done/stopped) 或 terminal 中间状态。
          // 也调一次 updateStream 维持 card elapsed time 滚动 (让用户知道 bot 活着)。
          // 内容为空 (等 bg 真正写 turn 后再显示), 只是时间刷新。
          // CardUpdater.updateStream 内部 5s 节流, 不会真每 500ms 都 patch。
          await cardUpdater.updateStream(
            '', '', Date.now() - startTime, [],
          ).catch(err => logger.warn(`rendezvous: updateStream failed (pre-active): ${err?.message ?? err}`));
        }
      },
    });

    // 终态 patch
    if (rendezvousResult.ok && rendezvousResult.reason === 'done') {
      // v2.4.1: 用 polling 替代固定 500ms delay + 立即 read。
      // poll JSONL 直到 text 与 preBaselineText 不同 (即 bg 写完新 turn),
      // 否则 timeout 兜底。处理 state.json → JSONL flush 的 race condition。
      const waitResult = eligibility.jsonlPath
        ? await waitForNewAssistantTurn(eligibility.jsonlPath, preBaselineText)
        : { turn: null, foundNew: false };
      const lastTurn = waitResult.turn;
      // 优先级: poll 拿到的新 turn → 流式已捕获的 lastText → fallback
      const responseText = lastTurn?.text ?? lastText ?? '(bg 完成，请在 Agent View 查看完整回复)';
      const tokens = lastTurn?.usage ?? {
        input_tokens: 0, output_tokens: 0,
        cache_creation_input_tokens: null, cache_read_input_tokens: null,
      };
      try {
        await cardUpdater.complete(
          responseText,
          tokens.input_tokens ?? 0,
          tokens.output_tokens ?? 0,
          (rendezvousResult.durationMs ?? Date.now() - startTime),
          1,
        );
      } catch (err: any) {
        logger.warn(`rendezvous: cardUpdater.complete 失败: ${err?.message ?? err}`);
      }
      logger.info(
        `rendezvous: ok reason=done ` +
        `duration=${Date.now() - startTime}ms ` +
        `tokens_out=${tokens.output_tokens ?? 0} ` +
        `stream_patches=${streamCount} ` +
        `found_new=${waitResult.foundNew}`,
      );
    } else if (rendezvousResult.ok && rendezvousResult.reason === 'new_needs') {
      // bg 又问新问题 — patch 卡回"等待输入" 状态(黄色 header + [取消等待]
      // 按钮)。语义: bg 没死没被停, 只是发完一个 turn 后又问下一个。
      // 之前 v2.4.x 简化版用 cardUpdater.cancel() 会显示 "🛑 已取消" 灰色卡,
      // 让用户误以为 bg 没了, UX 错乱。
      // v2.4.1: 同样用 waitForNewAssistantTurn poll JSONL, 避免 state.json → JSONL
      // flush race 拿到旧 turn 文本显示在"等待输入"卡的 recentOutput 里。
      try {
        // 从 state.json 读最新 needs + name
        const stateObj = await readJobState(short, eligibility.stateJsonPath!);
        const waitResult = eligibility.jsonlPath
          ? await waitForNewAssistantTurn(eligibility.jsonlPath, preBaselineText)
          : { turn: null, foundNew: false };
        if (stateObj) {
          await cardUpdater.patchWaitingCard({
            name: stateObj.state.name ?? short,
            status: 'waiting',
            waitingFor: stateObj.state.needs ?? undefined,
            cwd: stateObj.state.cwd ?? '',
            recentOutput: waitResult.turn?.text,
            outputFormat: 'markdown',
          });
        } else {
          // 兜底: state.json 没了(daemon 异常), 降级用 cancel 文案
          await cardUpdater.cancel('bg 已就绪，等待你的下一步指令');
        }
      } catch (err: any) {
        logger.warn(`rendezvous: patchWaitingCard 失败: ${err?.message ?? err}`);
      }
      logger.info(`rendezvous: ok reason=new_needs, 卡 patch 回"等待输入", bg 在等用户新输入`);
      bgAskedNewQuestion = true;  // 让 caller re-set expectedReply
    } else {
      // 失败分类 (跟 v2.3.5 fallback 同样的语义)
      if (
        rendezvousResult.reason === 'socket_closed' ||
        rendezvousResult.reason === 'daemon_error'
      ) {
        logger.warn(
          `rendezvous: reason=${rendezvousResult.reason} ` +
          `→ falling back to v2.3.5 auto-stop + SDK resume`,
        );
        // 不发错误消息, 让 v2.3.5 路径发"处理中"卡 + SDK 完成回复
        // 这里没有"撤掉处理中卡", v2.3.5 会在原卡上覆盖 (也合理:
        // 跟 chat-text "Claude daemon 已停止" 误报对比, 这是过渡版, 下次大改再做)
        return { handled: false, bgAskedNewQuestion: false, cardMessageId: null };
      }
      try {
        const errMsg = rendezvousResult.reason === 'timeout'
          ? `⏱ bg 处理超时（${Math.round(timeoutMs / 1000)}s 内未完成）`
          : `❌ Reply 失败：${rendezvousResult.reason}`;
        await cardUpdater.error(errMsg);
      } catch (err: any) {
        logger.warn(`rendezvous: cardUpdater.error 失败: ${err?.message ?? err}`);
      }
      logger.error(
        `rendezvous: inject failed reason=${rendezvousResult.reason} (no fallback)`,
      );
    }

    // v2.4.x: 终态 patch 完必须 cancelPending, 否则 5s 节流的 pending timer
    // 会在终态后 fire, 把卡片从"↩️ 回复"/"✅ 完成"/"❌ 错误" revert 回
    // "💭 处理中"。用户就看到卡片卡在 3s 不刷新 (因为 revert 时刻的
    // elapsed 正是 3s 左右)。
    cardUpdater.cancelPending();

    // 不发 chat-text, 卡片已经是反馈

    // Spool finalize — idempotent with handleReply's caller
    if (messageId) {
      this.spoolQueue.markReplied(messageId, sessionUuid);
      this.spoolQueue.markDone(messageId, sessionUuid);
    }

    return {
      handled: true,
      bgAskedNewQuestion,
      cardMessageId: cardUpdater.getCardMessageId(),
    };
  }

  /**
   * SDK-driven chat streaming lifecycle (public, reusable from Agent View reply).
   *
   * Drives the full SDK streaming pipeline: processing card → streaming updates →
   * permission card interactive prompts → completion / fallback to text → registry
   * upsert → spool finalization. Used by:
   *   1. `handleChat` (the original SpoolMessage path) — constructs params and calls.
   *   2. `AgentViewManager.handleReply` (T18) — calls directly with isNew=false to
   *      inject a reply into a `claude agents` background session.
   *
   * IMPORTANT: This method depends on `this.feishuClient`, `this.activePermissionHandlers`,
   * `this.cancelledMessageIds`, `this.activePermissionCardTimeouts`, `this.registry`,
   * `this.spoolQueue`, `this.replyFn`, `this.getSettingsPathForUser`, etc. So
   * `setAgentView` MUST overwrite `deps.runChatSDK` with an arrow function that
   * captures `this` (the FeishuBot instance) — otherwise a bare method reference
   * would lose `this` binding and crash at runtime.
   *
   * @param params.openId       Feishu openId (for card recipient + reply routing)
   * @param params.sessionUuid  Target session UUID (or null when isNew=true)
   * @param params.cwd          Working directory for the Claude process
   * @param params.settingsPath Optional ~/.claude/settings.json override
   * @param params.promptText   Prompt body (already with image references inlined)
   * @param params.serialKey    SpoolQueue serial key (sessionUuid or `new:${openId}`)
   * @param params.isNew        True for new-session creation path
   * @returns { result, handler, cardMessageId } — result for callers that need cost/tokens
   *   or sessionId; handler for permission state inspection; cardMessageId for downstream
   *   "find this card and patch it" operations.
   */
  public async runChatSDK(params: {
    openId: string;
    sessionUuid: string;
    cwd: string;
    settingsPath?: string;
    promptText: string;
    serialKey: string;
    isNew?: boolean;
    /** Spool messageId — used for cancellation check against cancelledMessageIds. */
    messageId?: string;
    /**
     * v2.3.5: 标记这是 AgentView 触发的 reply 路径(用户在飞书侧点 [Reply] 按钮表达
     * "接管 bg session" 意图)。若 true 且 bg conflict 检测到 live worker,
     * **自动** `claude stop` + 3s wait + 递归 runChatSDK 一次(skipBgConflict: true),
     * 不弹 3 按钮冲突卡。
     *
     * 第二次 reply 时 bg worker 已被停,conflict 检查不命中,直接 SDK。
     * 普通 chat 路径(没设此 flag)行为不变,3 按钮让用户决策。
     */
    fromAgentViewReply?: boolean;
    /**
     * v2.4.x (Attach path): 标记这是 attached-chat 路径(用户在飞书侧 attached 到
     * bg session 后直接发文本)。若 true 且 bg rendezvous-eligible (canUse=true),
     * **自动** 走 tryRendezvousReply 路径(可能 respawn bg)。否则 fall through 到
     * 原 v2.2.11 busy-check + v2.3.5/3.6 auto-stop + SDK 路径。
     */
    fromAttachedChat?: boolean;
  }): Promise<{
    result: SendMessageResult;
    handler: PermissionHandler;
    cardMessageId: string | null;
    rendezvousHandled?: boolean;
    /**
     * v2.4.x: bg 处理完一轮又问新问题 (new_needs)。true 时, 处理中卡
     * 已 transition 成"↩️ 回复" 新等待卡, caller (handleReply) 应该
     * 重新 set expectedReply, 让用户可以直接在 chat 接着回, 不用再点 [Reply]。
     * false 时 bg 真跑完 (done) / 报失败 (error) / 超时 / 走 v2.3.5, 保持 cleared。
     */
    bgAskedNewQuestion?: boolean;
  }> {
    const { openId, sessionUuid: inputSessionUuid, cwd, settingsPath, promptText, serialKey, isNew = false, messageId, fromAgentViewReply = false, fromAttachedChat = false } = params;

    // v2.4 rendezvous-first: short-circuit for Agent View Reply OR Attach-chat
    if (
      (fromAgentViewReply || fromAttachedChat) &&
      config.get<boolean>('agent_view.rendezvous_enabled', false)
    ) {
      const rv = await this.tryRendezvousReply({
        openId, sessionUuid: inputSessionUuid, promptText,
        cwd,  // inputSessionUuid 解构里已含 cwd (bot.ts:1820)
        messageId,
      });
      if (rv.handled) {
        // Reply already sent, spool already finalized. Return sentinel.
        return {
          result: null as unknown as SendMessageResult,
          handler: null as unknown as PermissionHandler,
          cardMessageId: rv.cardMessageId,
          rendezvousHandled: true,
          bgAskedNewQuestion: rv.bgAskedNewQuestion,
        };
      }
      // eligibility failed → fall through to existing v2.3.5/3.6 path
    }

    // v2.2.14: defense-in-depth —— UserManager.sessionUuid 可能是 8 字符 short hash
    // (历史 settled bg 走旧 snapshot-fetcher 路径时种下),`claude -p --resume <short>`
    // 会被 SDK 拒(报 "Provided value ... is not a UUID")。handleAttach 已尝试
    // short→full 转换,但 runChatSDK 也可能被 Reply / 旧 UserManager entry
    // 直接调用,所以这里再做一次保险转换,顺便 CAS 回写 UserManager。
    let sessionUuid = inputSessionUuid;
    if (sessionUuid && /^[0-9a-f]{8}$/.test(sessionUuid)) {
      try {
        const { JsonlIndex } = await import('../agent-view/jsonl-name');
        const idx = new JsonlIndex();
        const path = idx.lookup(sessionUuid);
        if (path) {
          const base = path.split('/').pop() ?? '';
          const full = base.replace(/\.jsonl$/, '');
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(full)) {
            logger.info(
              `runChatSDK: sessionUuid=${sessionUuid} 是 short hash,通过 JsonlIndex 展开为 ${full}`,
            );
            sessionUuid = full;
            // CAS 回写 UserManager:用 inputSessionUuid(short) 跟 oldEntry 比,匹配才更新。
            // 注意:此时 sessionUuid 已经是 full,直接比 sessionUuid 会跟 oldEntry 不匹配。
            const oldEntry = this.userManager.getEntry(openId);
            if (oldEntry?.type === 'session' && oldEntry.sessionUuid === inputSessionUuid) {
              const newEntry = { ...oldEntry, sessionUuid: full };
              await this.userManager.compareAndSwap(openId, oldEntry, newEntry);
            }
          }
        }
      } catch (err: any) {
        logger.debug(`runChatSDK: short→full 展开失败 (graceful): ${err?.message ?? err}`);
      }
    }
    const startTime = Date.now();
    let thinking = '';
    let text = '';
    let cardUpdater: CardUpdater | null = null;
    let cardMessageId: string | null = null;
    let cardInitFailed = false;
    let currentHandler: PermissionHandler | null = null;
    // Track ALL permission card messageIds created during this operation.
    // Previously a single `permCardMessageId` variable was overwritten by each
    // subsequent permission prompt, leaving earlier cards stuck in "⏳ 处理中".
    const permCardMessageIds = new Set<string>();

    try {
      if (this.feishuClient) {
        cardUpdater = new CardUpdater(this.feishuClient, {
          throttle_ms: config.get<number>('stream.throttle_ms', 1500),
          max_card_bytes: config.get<number>('stream.max_card_bytes', 25000),
          show_thinking: config.get<boolean>('stream.show_thinking', true),
        });
        cardMessageId = await cardUpdater.startProcessing(openId);
      }
    } catch (err: any) {
      logger.warn(`SDK Stream: 发送处理中卡片失败: ${err}`);
      cardInitFailed = true;
    }

    try {
      // v2.2.11: bg-worker 并发 **拒绝**(取代 v2.2.10 silent swap-to-parent)。
      //
      // 旧行为(v2.2.10):探测到 sessionUuid 仍被 bg worker 持有时,silently swap
      // 到 parent JSONL 让消息能发出去。问题:JSONL 是隔离了,但**两个 claude 进程
      // 共享同一个 cwd**,如果 bg worker 正在改代码 + 飞书 SDK 也开始改代码,
      // filesystem 副作用(Edit/Write/Bash 改文件、git commit 等)互相覆盖,真实
      // 风险是丢失改动,不是 JSONL 错乱。
      //
      // 新行为(v2.2.11):探测到冲突 → 不调 SDK,直接发拒绝卡(buildBgConflictCard)
      // 让用户选 [🛑 停 bg 后继续发送] / [🌿 开新会话发送] / [❌ 取消]。
      // 把决定权交给用户,默认 safe。
      //
      // v2.3.5 修正:AgentView reply 路径(fromAgentViewReply: true)下用户已经点
      // [Reply] 表达"接管 bg session"意图,弹冲突卡反 UX — 改成自动 `claude stop`
      // + 3s wait + 递归 SDK 一次。第二次 reply 时 bg 已被停,直接走 SDK。
      if (sessionUuid && !isNew) {
        // v2.3.5 pre-step:AgentView reply 路径下,若 bg conflict 探测到 live worker,
        // **提前** 自动 stop + 3s wait,等一切就绪后才走 SDK。原 SDK 流程(同一个
        // CardUpdater)继续 → 只发 1 张"处理中"卡,不再有递归 SDK 引发的双卡问题。
        // 第二次 reply 时 bg 已被停,conflict check 直接 pass,直接走 SDK。
        // 普通 chat 路径(没设 fromAgentViewReply)行为不变,3 按钮让用户决策。
        if (fromAgentViewReply) {
          const roster = _bgConflictHooks.readRoster();
          const short = sessionUuid.slice(0, 8);
          const worker = roster?.workers?.[short];
          if (worker) {
            logger.info(
              `runChatSDK: reply 路径自动 stop bg worker ${short}(pid=${worker.pid}),` +
                `等 3s 让 supervisor 释放 cwd 锁`,
            );
            try {
              await new Promise<void>((resolve, reject) => {
                require('node:child_process').execFile(
                  'claude', ['stop', short],
                  (err: any) => {
                    // v2.2.19: "No job matching" 算成功(bg 已自然 settle)
                    const msg = err?.stderr || err?.message || String(err);
                    if (err && !/No job matching/i.test(msg)) {
                      logger.warn(`runChatSDK: reply 路径 claude stop 失败 (graceful continue): ${msg}`);
                    }
                    resolve();
                  },
                );
              });
              // v2.2.19 / v2.3.5:1s 升 3s,治新 bg worker 太快 respawn 的 race
              await new Promise(r => setTimeout(r, 3000));
            } catch {
              // 任何意外都让原 SDK 流程继续(可能再触发 conflict 弹卡,acceptable)
            }
          }
        }
        const roster = _bgConflictHooks.readRoster();
        const short = sessionUuid.slice(0, 8);
        const worker = roster?.workers?.[short];
        if (worker) {
          // v2.3.8:reply 路径在 pre-step 已 stop bg + 3s wait。即便 supervisor 重启 worker
          // 残留(roster 还有记录),reply 路径下我们不弹 3 按钮冲突卡(用户已表达"接管"
          // 意图 + 我们已尽力 stop 过),直接 fall through 调 SDK。bypass 的副作用是
          // 真冲突(cwd 锁未释放)SDK 仍会失败,但届时 SDK 自己的 error result 会
          // 报到 bot 然后 patch 错误卡(可接受)。
          if (fromAgentViewReply) {
            logger.info(
              `runChatSDK: reply 路径跳过冲突卡,bg 已 pre-step stop(roster 残留 worker=${short} ` +
                `pid=${worker.pid}),直接调 SDK`,
            );
            // 跳过弹卡,直接 fall through 到 SDK spawn
          } else {
          const workerPid = (worker as any).pid;
          const workerName = (worker as any).dispatch?.seed?.name || short;
          // v2.2.13: 在拒绝时 pre-compute parent UUID(从 roster.launch.sessionId 提取
          // basename),stash 到 conflict card 的 stop_and_send button value 上。
          // 这样 handleStopAndSend 不需要再读 roster —— 因为 `claude stop` 一执行
          // worker 就会被从 roster 移除,二次查必然查不到 parent。
          // 没 parent 的 raw-slash bg(罕见)就让 handler 直接 resume bg 自身。
          let parentUuid: string | null = null;
          try {
            const parentPath = _bgConflictHooks.lookupResumeFromPath(roster, short);
            if (parentPath) {
              const id = parentPath.split('/').pop()?.replace(/\.jsonl$/, '') ?? '';
              if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
                parentUuid = id;
              }
            }
          } catch {
            // ignore
          }
          logger.info(
            `runChatSDK: 拒绝向 live bg worker ${short} 发消息(pid=${workerPid}),` +
              `弹冲突卡(parent=${parentUuid?.slice(0, 8) ?? 'none'})`,
          );
          if (cardUpdater) {
            // 之前已经发了"💭 处理中"卡,把它 patch 成冲突卡(text 同上,占位防卡片悬挂)
            await cardUpdater
              .complete(`⚠️ 该 session 仍有 bg worker 在跑(pid=${workerPid}),已弹卡询问下一步`, 0, 0, 0, 0)
              .catch(() => {});
            cardUpdater.dispose();
            cardUpdater = null;
          }
          if (this.cardReplyFn) {
            const conflictCard = buildBgConflictCard({
              name: workerName,
              shortId: short,
              sessionId: sessionUuid,
              cwd,
              text: promptText,
              workerPid,
              parentUuid,
            });
            try {
              await this.cardReplyFn(JSON.parse(conflictCard), { openId });
            } catch (err: any) {
              logger.warn(`runChatSDK: 冲突卡发送失败 (graceful): ${err?.message ?? err}`);
            }
          }
          // 同时把 spool / cancelled state 清理一下(没有 SDK 调用要 abort)
          if (messageId) this.cancelledMessageIds.delete(messageId);
          // 方案 B(2026-06-09):把 sessionStatus 改 'active' 而非 'degraded'。
          // 原行为把 session 标 degraded 触发 /switch 阻断,但实际 session JSONL 仍完整、
          // bg worker 是另一个 daemon 进程,user 选 3-button 之一后:
          //   - 停bg → claude stop 杀掉 bg,parent/原 session resume 同 JSONL
          //   - 新会话 → handleNewAndSend 另起 parent,旧 bg worker 继续独立
          //   - 取消 → 啥都不发
          // 标 degraded 给用户错误信号(让 /switch 阻、说"自动修复"),其实不需要。
          // 改 'active' + error:undefined 后:registry writer 写入 'active' + last_error:null,
          // /switch 不会再被自己的卡弹阻,last_error 也不留误导信号。
          return {
            result: {
              response: '(bg worker 冲突,已弹卡询问下一步)',
              costUsd: 0,
              durationMs: 0,
              sessionId: sessionUuid,
              jsonlPath: null,
              sessionStatus: 'active' as const,  // 方案 B:从 'degraded' 改 'active'
              // error: undefined, // 显式不写 → caller 写 last_error:null,避免'bg_worker_conflict'被误读为真错
            },
            handler: new PermissionHandler({ allowedTools: [], disallowedTools: [] }),
            cardMessageId,
          };
          }  // close reply-path skip
        }  // close if (worker)
      }

      const { result, handler } = await this.sessionManager.sendSDKMessage(
        sessionUuid, promptText, cwd,
        (chunk: StreamChunk) => {
          if (cardInitFailed || !cardUpdater) return;
          if (chunk.type === 'thinking') thinking += chunk.content;
          else if (chunk.type === 'text') text += chunk.content;
          const elapsed = Date.now() - startTime;
          cardUpdater.updateStream(
            config.get<boolean>('stream.show_thinking', true) ? thinking : '',
            text, elapsed
          ).catch(e => logger.warn(`SDK Stream: update failed: ${e}`));
        },
        async (prompt: PermissionPrompt, sdkHandler: PermissionHandler) => {
          if (!this.feishuClient || cardInitFailed) {
            // Cannot show card — deny immediately rather than hanging until timeout
            sdkHandler.resolveUserDecision(prompt.index, false);
            return;
          }
          const permCardUpdater = new CardUpdater(this.feishuClient, { throttle_ms: 0 });
          const actionText = this.getPermissionActionText(prompt);
          // Store handler BEFORE await so user clicks during card creation are handled
          this.activePermissionHandlers.set(sdkHandler.getHandlerId(), sdkHandler);
          try {
            const createdId = await permCardUpdater.createPermissionCard(
              openId, prompt.toolName, actionText, prompt.index, sdkHandler.getHandlerId(),
            );
            if (createdId) permCardMessageIds.add(createdId);
          } catch (err: any) {
            logger.error(`SDK Stream: 权限卡片创建失败: ${err}`);
            // Auto-deny if card cannot be shown to user
            sdkHandler.resolveUserDecision(prompt.index, false);
            // Clean up immediately if no more pending prompts
            if (sdkHandler.getUnresolvedCount() === 0) {
              this.activePermissionHandlers.delete(sdkHandler.getHandlerId());
            }
          }
        },
        isNew, serialKey, settingsPath,
      );
      currentHandler = handler;

      // Defensive: if streaming text is empty but result.response has content,
      // fall back to result.response (e.g. when SDK partial messages are not emitted).
      const finalText = text || result.response || '(空回复)';

      if (cardUpdater) {
        const wasCancelled = messageId ? this.cancelledMessageIds.has(messageId) : false;
        if (wasCancelled) {
          await cardUpdater.cancel();
        } else if (cardUpdater.shouldFallbackToText(finalText)) {
          const truncated = cardUpdater.truncateContent(finalText);
          await cardUpdater.complete(truncated, result.tokensIn ?? 0, result.tokensOut ?? 0, result.durationMs, 1);
          const remainder = finalText.slice(truncated.length);
          if (remainder && config.get<boolean>('stream.fallback_to_text', true)) {
            for (const chunk of splitReplyText(remainder, 3900)) {
              await this.replyFn(chunk, { openId });
            }
          }
        } else {
          await cardUpdater.complete(finalText, result.tokensIn ?? 0, result.tokensOut ?? 0, result.durationMs, 1);
        }
        cardMessageId = cardUpdater.getCardMessageId();
        cardUpdater.dispose();
      }

      // Update ALL permission cards to completed state after operation finishes.
      // Keep the 1200ms delay so this fires AFTER any still-pending click-handler
      // patches (which run at click-time + 1200ms). For each card we also cancel
      // the click handler's pending timer — otherwise it could fire after us and
      // overwrite "✅ 已完成" with "⏳ 处理中".
      if (permCardMessageIds.size > 0 && this.feishuClient) {
        setTimeout(async () => {
          for (const cardId of permCardMessageIds) {
            const pending = this.activePermissionCardTimeouts.get(cardId);
            if (pending) {
              clearTimeout(pending);
              this.activePermissionCardTimeouts.delete(cardId);
            }
            try {
              const permCardUpdater = new CardUpdater(this.feishuClient!, { throttle_ms: 0 });
              permCardUpdater.setCardMessageId(cardId);
              await permCardUpdater.updatePermissionCardToCompleted();
            } catch (e: any) {
              logger.warn(`SDK Stream: permission card completion update failed (${cardId}): ${e}`);
            }
          }
        }, 1200);
      }

      // Spool finalization skipped: Agent View reply (T18) calls this method
      // outside the SpoolQueue, so there is no SpoolMessage to update. Callers
      // that DO have a SpoolMessage (handleChat) handle the spool update inline.

      // P1-4: SDK fallback path for Agent View Reply — send a chat-text reply
      // ONLY when the card failed to initialize (cardInitFailed=true).
      // When card succeeded, cardUpdater.complete() already delivered response +
      // token stats via the interactive card — no need for a duplicate chat-text.
      if (fromAgentViewReply && result?.response && cardInitFailed) {
        const tokenCount = (result.tokensIn ?? 0) + (result.tokensOut ?? 0);
        const sdkReplyText = `✅ Claude 已处理完你的消息。\n\n${result.response}\n\n` +
          `⏱ ${result.durationMs}ms · ${formatTokenCount(tokenCount)} · 1 轮数`;
        if (messageId) {
          await this.replyFn(sdkReplyText, { messageId, openId, requestUuid: stableUuid(messageId) });
        } else {
          await this.replyFn(sdkReplyText, { openId, requestUuid: uniqueUuid() });
        }
      }

      return { result, handler, cardMessageId, rendezvousHandled: false };
    } catch (err: any) {
      logger.error(`runChatSDK 失败: ${err?.message ?? err}`);
      if (cardUpdater) {
        await cardUpdater.error(err.message ?? 'Unknown error');
        cardMessageId = cardUpdater.getCardMessageId();
        cardUpdater.dispose();
      } else if (!cardInitFailed && this.feishuClient) {
        // No card was ever created — surface a text error reply
        await this.replyFn(`处理失败: ${err.message ?? err}`, { openId });
      }
      throw err;
    } finally {
      // Only delete handler when all permission prompts are resolved.
      // If a prompt is still awaiting user input, keep the handler so the click can resolve.
      if (currentHandler && currentHandler.getUnresolvedCount() === 0) {
        this.activePermissionHandlers.delete(currentHandler.getHandlerId());
      }
    }
  }

  /**
   * Set the Agent View manager. Wires `mgr.deps.runChatSDK` to an arrow function
   * that captures this FeishuBot instance so `runChatSDK` can be called from
   * outside the bot (e.g. by AgentViewManager.handleReply) without losing
   * `this` binding.
   *
   * v2.2 critical fix: the deps object passed to AgentViewManager is already
   * constructed. We MUST overwrite `deps.runChatSDK` with an arrow function —
   * a bare method reference (`this.runChatSDK`) would lose `this` and crash
   * when the manager invokes it, because `runChatSDK` reads `this.feishuClient`,
   * `this.activePermissionHandlers`, etc.
   */
  setAgentView(mgr: AgentViewManager): void {
    this.agentView = mgr;
    // v2.2 fix: arrow function captures `this` (the FeishuBot instance)
    mgr.deps.runChatSDK = (params) => this.runChatSDK(params);
  }

  private getPermissionActionText(prompt: PermissionPrompt): string {
    if (prompt.toolName === 'Bash') {
      return (prompt.toolInput as any).command ?? String(prompt.toolInput);
    }
    if (prompt.toolName === 'Edit' || prompt.toolName === 'Write' || prompt.toolName === 'Read') {
      return (prompt.toolInput as any).file_path ?? String(prompt.toolInput);
    }
    if (prompt.toolName === 'WebFetch') {
      return (prompt.toolInput as any).url ?? String(prompt.toolInput);
    }
    return JSON.stringify(prompt.toolInput);
  }

  /**
   * Shared error handling for all streaming/SDK paths.
   * Distinguishes user-initiated cancellation from real errors,
   * updates card state, records delivery, and moves spool message to failed.
   * Returns the final cardMessageId (may differ from input if cardUpdater created one).
   */
  private async _handleStreamError(
    msg: SpoolMessage,
    err: any,
    cardUpdater: CardUpdater | null,
    cardInitFailed: boolean,
    cardMessageId: string | null,
    isNewSession: boolean,
  ): Promise<string | null> {
    const isCancelled = this.cancelledMessageIds.has(msg.messageId);
    if (isCancelled) this.cancelledMessageIds.delete(msg.messageId);

    let finalCardId = cardMessageId;
    if (cardUpdater) {
      if (isCancelled) {
        await cardUpdater.cancel();
      } else {
        await cardUpdater.error(err.message ?? 'Unknown error');
      }
      finalCardId = cardUpdater.getCardMessageId();
      cardUpdater.dispose();
    } else if (!cardInitFailed) {
      const replyText = isCancelled
        ? (isNewSession ? '创建已取消。' : '处理已取消。')
        : (isNewSession ? `创建失败: ${err.message}` : `处理失败: ${err.message}`);
      await this.replyFn(replyText, { messageId: msg.messageId, openId: msg.openId });
    }
    if (finalCardId) {
      this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, finalCardId, 1);
    }
    this.spoolQueue.markReplied(msg.messageId, msg.serialKey, finalCardId ?? undefined);
    this.spoolQueue.markFailed(msg.messageId, msg.serialKey, isCancelled ? '用户已取消' : String(err));
    return finalCardId;
  }

  /** Streaming path for new session creation */
  private async createSessionFromPromptStreaming(
    msg: SpoolMessage,
    cwd: string,
    claimMessageId: string,
    prompt: string,
  ): Promise<void> {
    const startTime = Date.now();
    let thinking = '';
    let text = '';
    let cardUpdater: CardUpdater | null = null;
    let cardMessageId: string | null = null;
    let cardInitFailed = false;

    try {
      if (this.feishuClient) {
        cardUpdater = new CardUpdater(this.feishuClient, {
          throttle_ms: config.get<number>('stream.throttle_ms', 1500),
          max_card_bytes: config.get<number>('stream.max_card_bytes', 25000),
          show_thinking: config.get<boolean>('stream.show_thinking', true),
        });
        cardMessageId = await cardUpdater.startProcessing(msg.openId);
      }
    } catch (err: any) {
      logger.warn(`Stream: 发送处理中卡片失败: ${err}`);
      cardInitFailed = true;
    }

    try {
      const settingsPath = this.getSettingsPathForUser(msg.openId);
      const promptText = buildPromptWithImages(prompt, msg.imagePaths ?? []);
      const result = await this.sessionManager.sendStreamingMessage(
        null, promptText, cwd,
        (chunk: StreamChunk) => {
          if (cardInitFailed || !cardUpdater) return;
          if (chunk.type === 'thinking') thinking += chunk.content;
          else if (chunk.type === 'text') text += chunk.content;
          const elapsed = Date.now() - startTime;
          cardUpdater.updateStream(
            config.get<boolean>('stream.show_thinking', true) ? thinking : '',
            text, elapsed
          ).catch(e => logger.warn(`Stream: update failed: ${e}`));
        },
        true, `new:${msg.openId}`, settingsPath,
      );

      if (!result.sessionId) {
        await this.userManager.rollbackClaim(msg.openId, claimMessageId);
        if (cardUpdater) {
          await cardUpdater.error(result.error ?? 'Claude 未返回 session_id');
          cardMessageId = cardUpdater.getCardMessageId();
          cardUpdater.dispose();
        }
        throw new Error(result.error || `Claude 未返回 session_id (响应: ${result.response})`);
      }

      const now = new Date().toISOString();
      const bound = await this.userManager.bindSessionToClaim(msg.openId, claimMessageId, result.sessionId, cwd);
      if (!bound) {
        if (cardUpdater) {
          await cardUpdater.error('新会话已创建，但映射绑定失败');
          cardMessageId = cardUpdater.getCardMessageId();
          cardUpdater.dispose();
        }
        throw new Error('新会话已创建，但映射绑定失败');
      }

      // Finalize card
      if (cardUpdater) {
        const wasCancelled = this.cancelledMessageIds.has(msg.messageId);
        if (wasCancelled) {
          this.cancelledMessageIds.delete(msg.messageId);
          await cardUpdater.cancel();
        } else if (cardUpdater.shouldFallbackToText(text)) {
          const truncated = cardUpdater.truncateContent(text);
          await cardUpdater.complete(truncated, result.tokensIn ?? 0, result.tokensOut ?? 0, result.durationMs, 1);
          const remainder = text.slice(truncated.length);
          if (remainder && config.get<boolean>('stream.fallback_to_text', true)) {
            for (const chunk of splitReplyText(remainder, 3900)) {
              await this.replyFn(chunk, { messageId: msg.messageId, openId: msg.openId });
            }
          }
        } else {
          await cardUpdater.complete(text, result.tokensIn ?? 0, result.tokensOut ?? 0, result.durationMs, 1);
        }
        cardMessageId = cardUpdater.getCardMessageId();
        cardUpdater.dispose();
      }

      // Update registry
      this.registry.upsert(result.sessionId, {
        origin: 'feishu',
        cwd,
        project_name: basename(cwd),
        title: buildSessionTitle(prompt),
        message_count: Math.max(this.registry.get(result.sessionId)?.message_count ?? 0, 1),
        created_at: this.registry.get(result.sessionId)?.created_at ?? now,
        last_active: now,
        last_message_preview: preview(prompt) || (msg.imagePaths?.length ? '[图片]' : ''),
        status: result.sessionStatus,
        jsonl_path: result.jsonlPath,
        pending_jsonl_resolve: !result.jsonlPath,
        last_error: result.error ?? null,
        feishu_user_id: msg.openId,
        lastKnownProvider: this.getCurrentProviderAliasForUser(msg.openId),
      });
      await this.registry.flush();

      // Finalize spool
      this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, {
        responseText: result.response || '(空回复)',
        target: {
          type: 'session',
          sessionUuid: result.sessionId,
          cwd,
          openId: msg.openId,
          mappingVersion: this.userManager.getVersion(),
        },
      });
      if (cardMessageId) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, cardMessageId, 1);
      }
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey, cardMessageId ?? undefined);

      // JSONL repair
      if (result.jsonlPath) { try { repairJsonlLastPrompt(result.jsonlPath); } catch {} }

      this.cancelledMessageIds.delete(msg.messageId);
    } catch (err: any) {
      cardMessageId = await this._handleStreamError(msg, err, cardUpdater, cardInitFailed, cardMessageId, true);
    }
  }

  /** SDK path for new session creation (supports permission interaction) */
  private async createSessionFromPromptSDK(
    msg: SpoolMessage,
    cwd: string,
    claimMessageId: string,
    prompt: string,
  ): Promise<void> {
    const startTime = Date.now();
    let thinking = '';
    let text = '';
    let cardUpdater: CardUpdater | null = null;
    let cardMessageId: string | null = null;
    let cardInitFailed = false;
    let currentHandler: PermissionHandler | null = null;
    // Track ALL permission card messageIds created during this new-session operation.
    // The completion block (previously MISSING in this code path) patches all of
    // them to "✅ 已完成" after the operation finishes.
    const permCardMessageIds = new Set<string>();

    try {
      if (this.feishuClient) {
        cardUpdater = new CardUpdater(this.feishuClient, {
          throttle_ms: config.get<number>('stream.throttle_ms', 1500),
          max_card_bytes: config.get<number>('stream.max_card_bytes', 25000),
          show_thinking: config.get<boolean>('stream.show_thinking', true),
        });
        cardMessageId = await cardUpdater.startProcessing(msg.openId);
      }
    } catch (err: any) {
      logger.warn(`SDK Stream: 发送处理中卡片失败: ${err}`);
      cardInitFailed = true;
    }

    try {
      const settingsPath = this.getSettingsPathForUser(msg.openId);
      const promptText = buildPromptWithImages(prompt, msg.imagePaths ?? []);
      const { result, handler } = await this.sessionManager.sendSDKMessage(
        null, promptText, cwd,
        (chunk: StreamChunk) => {
          if (cardInitFailed || !cardUpdater) return;
          if (chunk.type === 'thinking') thinking += chunk.content;
          else if (chunk.type === 'text') text += chunk.content;
          const elapsed = Date.now() - startTime;
          cardUpdater.updateStream(
            config.get<boolean>('stream.show_thinking', true) ? thinking : '',
            text, elapsed
          ).catch(e => logger.warn(`SDK Stream: update failed: ${e}`));
        },
        async (prompt: PermissionPrompt, sdkHandler: PermissionHandler) => {
          if (!this.feishuClient || cardInitFailed) {
            // Cannot show card — deny immediately rather than hanging until timeout
            sdkHandler.resolveUserDecision(prompt.index, false);
            return;
          }
          const permCardUpdater = new CardUpdater(this.feishuClient, { throttle_ms: 0 });
          const actionText = this.getPermissionActionText(prompt);
          // Store handler BEFORE await so user clicks during card creation are handled
          this.activePermissionHandlers.set(sdkHandler.getHandlerId(), sdkHandler);
          try {
            const createdId = await permCardUpdater.createPermissionCard(
              msg.openId, prompt.toolName, actionText, prompt.index, sdkHandler.getHandlerId(),
            );
            if (createdId) permCardMessageIds.add(createdId);
          } catch (err: any) {
            logger.error(`SDK Stream: 权限卡片创建失败: ${err}`);
            // Auto-deny if card cannot be shown to user
            sdkHandler.resolveUserDecision(prompt.index, false);
            // Clean up immediately if no more pending prompts
            if (sdkHandler.getUnresolvedCount() === 0) {
              this.activePermissionHandlers.delete(sdkHandler.getHandlerId());
            }
          }
        },
        true, `new:${msg.openId}`, settingsPath,
      );
      currentHandler = handler;

      if (!result.sessionId) {
        await this.userManager.rollbackClaim(msg.openId, claimMessageId);
        if (cardUpdater) {
          await cardUpdater.error(result.error ?? 'Claude 未返回 session_id');
          cardMessageId = cardUpdater.getCardMessageId();
          cardUpdater.dispose();
        }
        throw new Error(result.error || `Claude 未返回 session_id (响应: ${result.response})`);
      }

      const now = new Date().toISOString();
      const bound = await this.userManager.bindSessionToClaim(msg.openId, claimMessageId, result.sessionId, cwd);
      if (!bound) {
        if (cardUpdater) {
          await cardUpdater.error('新会话已创建，但映射绑定失败');
          cardMessageId = cardUpdater.getCardMessageId();
          cardUpdater.dispose();
        }
        throw new Error('新会话已创建，但映射绑定失败');
      }

      // Defensive: if streaming text is empty but result.response has content,
      // fall back to result.response (e.g. when SDK partial messages are not emitted).
      const finalText = text || result.response || '(空回复)';

      if (cardUpdater) {
        const wasCancelled = this.cancelledMessageIds.has(msg.messageId);
        if (wasCancelled) {
          this.cancelledMessageIds.delete(msg.messageId);
          await cardUpdater.cancel();
        } else if (cardUpdater.shouldFallbackToText(finalText)) {
          const truncated = cardUpdater.truncateContent(finalText);
          await cardUpdater.complete(truncated, result.tokensIn ?? 0, result.tokensOut ?? 0, result.durationMs, 1);
          const remainder = finalText.slice(truncated.length);
          if (remainder && config.get<boolean>('stream.fallback_to_text', true)) {
            for (const chunk of splitReplyText(remainder, 3900)) {
              await this.replyFn(chunk, { messageId: msg.messageId, openId: msg.openId });
            }
          }
        } else {
          await cardUpdater.complete(finalText, result.tokensIn ?? 0, result.tokensOut ?? 0, result.durationMs, 1);
        }
        cardMessageId = cardUpdater.getCardMessageId();
        cardUpdater.dispose();
      }

      // Update ALL permission cards to completed state after operation finishes.
      // (Previously this block did NOT exist in createSessionFromPromptSDK, so
      // permission cards created during new-session creation were never patched
      // to "✅ 已完成" — they stayed at "⏳ 处理中" forever.)
      if (permCardMessageIds.size > 0 && this.feishuClient) {
        setTimeout(async () => {
          for (const cardId of permCardMessageIds) {
            const pending = this.activePermissionCardTimeouts.get(cardId);
            if (pending) {
              clearTimeout(pending);
              this.activePermissionCardTimeouts.delete(cardId);
            }
            try {
              const permCardUpdater = new CardUpdater(this.feishuClient!, { throttle_ms: 0 });
              permCardUpdater.setCardMessageId(cardId);
              await permCardUpdater.updatePermissionCardToCompleted();
            } catch (e: any) {
              logger.warn(`SDK Stream (new): permission card completion update failed (${cardId}): ${e}`);
            }
          }
        }, 1200);
      }

      this.registry.upsert(result.sessionId, {
        origin: 'feishu',
        cwd,
        project_name: basename(cwd),
        title: buildSessionTitle(prompt),
        message_count: Math.max(this.registry.get(result.sessionId)?.message_count ?? 0, 1),
        created_at: this.registry.get(result.sessionId)?.created_at ?? now,
        last_active: now,
        last_message_preview: preview(prompt) || (msg.imagePaths?.length ? '[图片]' : ''),
        status: result.sessionStatus,
        jsonl_path: result.jsonlPath,
        pending_jsonl_resolve: !result.jsonlPath,
        last_error: result.error ?? null,
        feishu_user_id: msg.openId,
        lastKnownProvider: this.getCurrentProviderAliasForUser(msg.openId),
      });
      await this.registry.flush();

      this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, {
        responseText: result.response || '(空回复)',
        target: {
          type: 'session',
          sessionUuid: result.sessionId,
          cwd,
          openId: msg.openId,
          mappingVersion: this.userManager.getVersion(),
        },
      });
      if (cardMessageId) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, cardMessageId, 1);
      }
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey, cardMessageId ?? undefined);

      if (result.jsonlPath) { try { repairJsonlLastPrompt(result.jsonlPath); } catch {} }

      this.cancelledMessageIds.delete(msg.messageId);
    } catch (err: any) {
      cardMessageId = await this._handleStreamError(msg, err, cardUpdater, cardInitFailed, cardMessageId, true);
    } finally {
      // Only delete handler when all permission prompts are resolved.
      // If a prompt is still awaiting user input, keep the handler so the click can resolve.
      if (currentHandler && currentHandler.getUnresolvedCount() === 0) {
        this.activePermissionHandlers.delete(currentHandler.getHandlerId());
      }
    }
  }

  private async handleList(msg: SpoolMessage): Promise<void> {
    await this.doCardList(msg.openId, msg.messageId, msg);
  }

  private async handleListDir(msg: SpoolMessage): Promise<void> {
    await this.doListDir(msg.openId, msg.messageId, msg);
  }

  private async handleNew(msg: SpoolMessage, rawArgs: string): Promise<void> {
    const { cwd: rawCwd, prompt, providerAlias } = parseNewCommand(rawArgs);
    const defaultCwd = config.get<string>('feishu_bot.default_cwd', '');
    const existingCwd = this.userManager.getEntry(msg.openId)?.cwd;
    const cwd = normalizeCwd(rawCwd || existingCwd || defaultCwd);

    // If --model specified, set defaultProvider first
    if (providerAlias) {
      const provider = this.providerManager.resolve(providerAlias);
      if (!provider) {
        await this.replyAndFinalize(msg, `未知模型: "${providerAlias}"\n请使用 /model 查看可用列表`);
        return;
      }

      const entry = this.userManager.getEntry(msg.openId);
      const newEntry = entry
        ? { ...entry, defaultProvider: provider.alias }
        : {
            type: 'pending_new_session' as const,
            sessionUuid: null,
            createdAt: new Date().toISOString(),
            defaultProvider: provider.alias,
          };
      await this.userManager.compareAndSwap(msg.openId, entry ?? null, newEntry);
    }

    if (!cwd) {
      await this.replyAndFinalize(msg, '请使用 /new <cwd>，或在配置里设置 feishu_bot.default_cwd。');
      return;
    }

    const validationError = validateCwd(cwd);
    if (validationError) {
      await this.replyAndFinalize(msg, validationError);
      return;
    }

    if (!prompt) {
      const currentEntry = this.userManager.getEntry(msg.openId);
      if (currentEntry?.type === 'pending_new_session_claimed') {
        await this.replyAndFinalize(msg, '⚠️ /new 正在处理中，请稍后再试。');
        return;
      }

      const swapped = await this.userManager.compareAndSwap(
        msg.openId,
        currentEntry ?? null,
        {
          ...currentEntry,
          type: 'pending_new_session',
          sessionUuid: null,
          createdAt: currentEntry?.createdAt ?? new Date().toISOString(),
          cwd,
        },
      );

      // BUG-5 修复：统一 CAS 失败消息为"会话状态已被其他操作变更"
      // 之前是"⚠️ 会话状态冲突，请稍后重试"——和 doSwitch 风格不一致且对用户晦涩。
      // 详见 review finding "unify /new CAS error"（第三轮 review BUG-5）。
      await this.replyAndFinalize(
        msg,
        swapped ? '✅ 已设置新会话目录，请继续发送第一条消息。' : '⚠️ /new 失败：会话状态已被其他操作变更，请稍后重试。',
      );
      return;
    }

    const currentEntry = this.userManager.getEntry(msg.openId);
    if (currentEntry?.type === 'pending_new_session_claimed') {
      await this.replyAndFinalize(msg, '⚠️ /new 正在处理中，请稍后再试。');
      return;
    }

    const now = new Date().toISOString();
    const swapped = await this.userManager.compareAndSwap(
      msg.openId,
      currentEntry ?? null,
      {
        ...currentEntry,
        type: 'pending_new_session_claimed',
        sessionUuid: null,
        createdAt: currentEntry?.createdAt ?? now,
        cwd,
        claimedByMessageId: msg.messageId,
        claimedAt: now,
      },
    );

    if (!swapped) {
      await this.replyAndFinalize(msg, '⚠️ /new 失败：会话状态已被其他操作变更，请稍后重试。');
      return;
    }

    const useSDK = config.get<boolean>('sdk.enabled', true);
    if (useSDK) {
      await this.createSessionFromPromptSDK(msg, cwd, msg.messageId, prompt);
    } else if (config.get<boolean>('stream.enabled', false)) {
      await this.createSessionFromPromptStreaming(msg, cwd, msg.messageId, prompt);
    } else {
      await this.createSessionFromPrompt(msg, cwd, msg.messageId, prompt);
    }
  }

  private async handleSwitch(msg: SpoolMessage, target: string): Promise<void> {
    if (!target) {
      await this.replyAndFinalize(msg, '用法: /switch <序号或 UUID>');
      return;
    }

    const index = parseInt(target, 10);
    const uuid = Number.isNaN(index)
      ? (this.registry.findByPrefix(target)?.[0] ?? null)
      : this.listSnapshotManager.resolveIndex(index, msg.openId);

    if (!uuid) {
      await this.replyAndFinalize(msg, `未找到 "${target}" 对应的会话（或匹配到多个），请先执行 /list 查看完整列表。`);
      return;
    }

    await this.doSwitch(msg.openId, uuid, msg.messageId, msg);
  }

  private async handleResume(msg: SpoolMessage, target: string): Promise<void> {
    if (!target) {
      await this.replyAndFinalize(msg, '用法: /resume <序号或 UUID>');
      return;
    }

    const index = parseInt(target, 10);
    const uuid = Number.isNaN(index)
      ? (this.registry.findByPrefix(target)?.[0] ?? null)
      : this.listSnapshotManager.resolveIndex(index, msg.openId);

    if (!uuid) {
      await this.replyAndFinalize(msg, `未找到 "${target}" 对应的会话（或匹配到多个），请先执行 /list 查看完整列表。`);
      return;
    }

    await this.doResumeReply(msg.openId, uuid, msg);
  }

  private async handleStatus(msg: SpoolMessage): Promise<void> {
    const reply = await this.doStatus(msg.openId, msg.messageId);
    if (reply) await this.replyAndFinalize(msg, reply);
  }

  /**
   * Stop the user's current processing: kill Claude process (even during
   * `/new` flow where sessionUuid is still null), mark processing messages
   * as cancelled, stop live watcher.
   * Returns { stopped: boolean, hasTarget: boolean }.
   */
  private async _stopUserSession(openId: string): Promise<{ stopped: boolean; hasTarget: boolean }> {
    const entry = this.userManager.getEntry(openId);
    logger.info(`[stop] _stopUserSession: openId=${openId}, entry.type=${entry?.type ?? 'none'}, sessionUuid=${entry?.type === 'session' ? entry.sessionUuid?.slice(0, 8) : 'n/a'}`);
    const sessionUuid = entry?.type === 'session' ? entry.sessionUuid : null;
    const hasTarget = Boolean(sessionUuid) || entry?.type === 'pending_new_session_claimed';

    if (!hasTarget) {
      logger.info(`[stop] no target entry, returning early`);
      return { stopped: false, hasTarget: false };
    }

    let stopped = false;
    if (sessionUuid) {
      logger.info(`[stop] calling stopSession(${sessionUuid})`);
      stopped = this.sessionManager.stopSession(sessionUuid);
      logger.info(`[stop] stopSession result: ${stopped}`);
    }
    // If no sessionUuid yet (e.g. /new flow mid-creation), kill all active
    // processes. Single-user instance — only one Claude process at a time.
    if (!stopped) {
      logger.info(`[stop] calling stopAllSessions`);
      const killed = this.sessionManager.stopAllSessions('user_stop');
      stopped = killed > 0;
      logger.info(`[stop] stopAllSessions killed ${killed} processes`);
    }

    const serialKeyForCancel = sessionUuid ?? `new:${openId}`;
    const processingMsgs = this.spoolQueue.listProcessing()
      .filter(m => m.serialKey === serialKeyForCancel && m.openId === openId);
    logger.info(`[stop] found ${processingMsgs.length} processing message(s) for serialKey=${serialKeyForCancel}`);
    for (const pMsg of processingMsgs) {
      this.cancelledMessageIds.add(pMsg.messageId);
      this.spoolQueue.markFailed(pMsg.messageId, pMsg.serialKey, '用户已取消');
    }

    await this.stopLiveWatcher(openId, 'user_stop');
    return { stopped, hasTarget: true };
  }

  private async handleStop(msg: SpoolMessage): Promise<void> {
    const { stopped, hasTarget } = await this._stopUserSession(msg.openId);

    if (!hasTarget) {
      await this.replyAndFinalize(msg, '⚠️ 当前没有活跃会话，无需停止。');
      return;
    }

    const reply = stopped
      ? '✅ 已停止当前会话的处理。'
      : 'ℹ️ 当前会话没有正在运行的处理任务。';
    await this.replyAndFinalize(msg, reply);
  }

  private async handleModel(msg: SpoolMessage, target: string): Promise<void> {
    if (!target) {
      const entry = this.userManager.getEntry(msg.openId);
      const currentAlias = entry?.defaultProvider ?? null;
      const providers = this.providerManager.list();

      if (providers.length === 0) {
        const lines = [
          '当前默认模型: 未设置（跟随 Claude 全局配置）',
          '',
          '未检测到可切换模型。',
          '请安装 CC Switch 或手动创建 ~/.claude/providers/*.json',
        ];
        await this.replyAndFinalize(msg, lines.join('\n'));
        return;
      }

      const card = buildModelCard(providers, currentAlias);
      const replyId = await this.cardReplyFn(card, { messageId: msg.messageId, openId: msg.openId });

      if (replyId) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, replyId, 1);
        this.spoolQueue.markReplied(msg.messageId, msg.serialKey, replyId);
        this.spoolQueue.markDone(msg.messageId, msg.serialKey, replyId);
      } else {
        // Fallback to text
        const lines: string[] = [];
        if (currentAlias) {
          const provider = this.providerManager.resolve(currentAlias);
          lines.push(`当前默认模型: ${provider?.name ?? currentAlias}`);
        } else {
          lines.push('当前默认模型: 未设置（跟随 Claude 全局配置）');
        }
        lines.push('');
        lines.push('可用模型:');
        providers.forEach((p, i) => {
          const marker = p.alias === currentAlias ? '●' : ' ';
          lines.push(`  ${marker} ${i + 1}. ${p.name}  (${p.alias})`);
        });
        lines.push('');
        lines.push('用法:');
        lines.push('  /model <序号|别名>        设置默认模型');
        lines.push('  /model --clear            清除默认设置');
        lines.push('  /new /path --model <别名>  创建会话时指定模型');
        await this.replyAndFinalize(msg, lines.join('\n'));
      }
      return;
    }

    if (target === '--clear') {
      const entry = this.userManager.getEntry(msg.openId);
      if (!entry) {
        await this.replyAndFinalize(msg, '⚠️ 无当前会话状态，无需清除');
        return;
      }
      const swapped = await this.userManager.compareAndSwap(
        msg.openId, entry,
        { ...entry, defaultProvider: undefined }
      );
      await this.replyAndFinalize(
        msg,
        swapped ? '✅ 已清除默认模型设置' : '⚠️ 清除失败，请重试'
      );
      return;
    }

    const provider = this.providerManager.resolve(target);
    if (!provider) {
      await this.replyAndFinalize(msg, `未知模型: "${target}"\n请使用 /model 查看可用列表`);
      return;
    }

    const entry = this.userManager.getEntry(msg.openId);
    const newEntry = entry
      ? { ...entry, defaultProvider: provider.alias }
      : {
          type: 'pending_new_session' as const,
          sessionUuid: null,
          createdAt: new Date().toISOString(),
          defaultProvider: provider.alias,
        };

    const swapped = await this.userManager.compareAndSwap(
      msg.openId, entry ?? null, newEntry
    );

    await this.replyAndFinalize(
      msg,
      swapped
        ? `✅ 默认模型已设置为 ${provider.name} (${provider.alias})`
        : '⚠️ 设置失败，请重试'
    );
  }

  private helpText(): string {
    return [
      '可用命令:',
      '  /help                              - 显示此帮助',
      '  /list                              - 列出会话',
      '  /listDir                            - 浏览目录',
      '  /new [路径] [-- prompt]            - 创建新会话',
      '  /new [路径] --model <别名> [-- p]  - 指定模型创建会话',
      '  /switch <序号|UUID>                - 切换会话',
      '  /stop                              - 停止当前会话的处理 (硬杀进程)',
      '  /cancel                            - 取消 Agent View 等待输入状态 (软退出, bg 继续跑)',
      '  /model                             - 查看可用模型和默认设置',
      '  /model <序号|别名>                  - 设置默认模型',
      '  /model --clear                     - 清除默认设置',
      '  /resume <序号|UUID>                - 获取安全恢复建议',
      '  /status                            - 查看状态',
      '  /whoami                            - 获取你的 open_id',
      '  /agents                            - 查看 agent 列表 (Agent View)',
    ].join('\n');
  }

  private async resolveChatTarget(openId: string, messageId: string): Promise<TargetSnapshot> {
    const entry = this.userManager.getEntry(openId);
    const mappingVersion = this.userManager.getVersion();

    if (!entry) {
      return { type: 'no_target', openId, mappingVersion };
    }

    if (entry.type === 'session' && entry.sessionUuid) {
      return {
        type: 'session',
        sessionUuid: entry.sessionUuid,
        cwd: entry.cwd || this.registry.get(entry.sessionUuid)?.cwd,
        openId,
        mappingVersion,
      };
    }

    if (entry.type === 'pending_new_session') {
      return {
        type: 'new_session_claim',
        openId,
        cwd: entry.cwd,
        claimMessageId: messageId,
        mappingVersion,
      };
    }

    if (entry.type === 'pending_new_session_claimed') {
      return {
        type: 'new_session_creating',
        openId,
        cwd: entry.cwd,
        claimedByMessageId: entry.claimedByMessageId,
        mappingVersion,
      };
    }

    return { type: 'no_target', openId, mappingVersion };
  }

  private async createSessionFromPrompt(
    msg: SpoolMessage,
    cwd: string,
    claimMessageId: string,
    prompt = msg.text,
  ): Promise<void> {
    const settingsPath = this.getSettingsPathForUser(msg.openId);
    const promptText = buildPromptWithImages(prompt, msg.imagePaths ?? []);
    const result = await this.sessionManager.sendMessage(null, promptText, cwd, true, `new:${msg.openId}`, settingsPath);

    if (!result.sessionId) {
      await this.userManager.rollbackClaim(msg.openId, claimMessageId);
      throw new Error(result.error || `Claude 未返回 session_id (响应: ${result.response})`);
    }

    const now = new Date().toISOString();
    const bound = await this.userManager.bindSessionToClaim(msg.openId, claimMessageId, result.sessionId, cwd);
    if (!bound) {
      throw new Error('新会话已创建，但映射绑定失败');
    }

    this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, {
      responseText: result.response || '(空回复)',
      target: {
        type: 'session',
        sessionUuid: result.sessionId,
        cwd,
        openId: msg.openId,
        mappingVersion: this.userManager.getVersion(),
      },
    });

    this.registry.upsert(result.sessionId, {
      origin: 'feishu',
      cwd,
      project_name: basename(cwd),
      title: buildSessionTitle(prompt),
      message_count: Math.max(this.registry.get(result.sessionId)?.message_count ?? 0, 1),
      created_at: this.registry.get(result.sessionId)?.created_at ?? now,
      last_active: now,
      last_message_preview: preview(prompt) || (msg.imagePaths?.length ? '[图片]' : ''),
      status: result.sessionStatus,
      jsonl_path: result.jsonlPath,
      pending_jsonl_resolve: !result.jsonlPath,
      last_error: result.error ?? null,
      feishu_user_id: msg.openId,
      lastKnownProvider: this.getCurrentProviderAliasForUser(msg.openId),
    });
    await this.registry.flush();

    await this.replyAndFinalize(msg, result.response || '(空回复)');
  }

  private async replyAndFinalize(msg: SpoolMessage, text: string): Promise<void> {
    const outcome = await this.replyTo(msg, text);
    if (!outcome.completed) {
      throw new ReplyDeliveryPendingError(computeRetryDelay(msg.retryCount ?? 0));
    }

    this.spoolQueue.markReplied(msg.messageId, msg.serialKey, outcome.replyMessageId ?? undefined);
    this.spoolQueue.markDone(msg.messageId, msg.serialKey, outcome.replyMessageId ?? undefined);
  }

  private async replyTo(msg: SpoolMessage, text: string): Promise<{ replyMessageId: string | null; completed: boolean }> {
    const MAX_CHUNK_BYTES = 3900;
    const chunks = splitReplyText(text, MAX_CHUNK_BYTES);
    const totalChunks = chunks.length;
    const delivery = this.spoolQueue.getDelivery(msg.messageId);
    let replyId = delivery?.chunks?.find(chunk => chunk.feishuMessageId)?.feishuMessageId ?? null;

    for (const [chunkIndex, chunk] of chunks.entries()) {
      const existingChunk = delivery?.chunks?.find(item => item.index === chunkIndex);
      if (existingChunk?.status === 'sent') {
        replyId = replyId ?? existingChunk.feishuMessageId ?? null;
        continue;
      }

      const uuid = stableUuid(msg.messageId, chunkIndex);
      this.spoolQueue.recordDelivery(msg.messageId, 'sending', uuid, chunkIndex, undefined, totalChunks);
      const id = await this.replyFn(chunk, {
        messageId: msg.messageId,
        openId: msg.openId,
        requestUuid: uuid,
        chunkIndex,
      });
      if (!id) {
        logger.warn(`飞书回复失败 (chunk ${chunkIndex + 1}): ${msg.messageId}`);
        return { replyMessageId: replyId, completed: false };
      }
      this.spoolQueue.recordDelivery(msg.messageId, 'sent', uuid, chunkIndex, id, totalChunks);
      if (!replyId) replyId = id;
    }

    return { replyMessageId: replyId, completed: this.spoolQueue.hasSentDelivery(msg.messageId) };
  }

  // ===== Card action handlers (called from both text commands and card callbacks) =====

  private async doCardList(openId: string, messageId?: string, msg?: SpoolMessage): Promise<void> {
    await syncBeforeCommand(this.registry);

    // v0.4.1: 过滤掉 Task tool 派生的 subagent sessions(和 Agent View 的
    // filterUserDispatched 思路一致 —— Agent View 滤 source='spare',
    // /list 滤 is_subagent=true)。老 entry 没 is_subagent 字段 = 当 false 处理
    // (不激进清空,下次扫描会补)。
    const allSessions = Object.entries(this.registry.sessions)
      .filter(([_, entry]) => entry.is_subagent !== true)
      .sort((a, b) => b[1].last_active.localeCompare(a[1].last_active));

    const MAX_LIST_ITEMS = 10;
    const sessions = allSessions.slice(0, MAX_LIST_ITEMS);
    const hasMore = allSessions.length > MAX_LIST_ITEMS;

    const snapshotEntries: ListSnapshotEntry[] = sessions.map(([uuid, entry], index) => ({
      index: index + 1,
      uuid,
      title: entry.title ?? 'Untitled',
    }));
    this.listSnapshotManager.saveSnapshot(openId, snapshotEntries);

    const runningUuids = new Set(
      this.sessionManager.listSessions()
        .map(s => s.sessionId)
        .filter((id): id is string => Boolean(id))
    );

    const card = buildListCard(
      sessions as Array<[string, SessionEntry]>,
      allSessions.length,
      hasMore,
      runningUuids,
    );
    const replyId = await this.cardReplyFn(card, { messageId, openId });

    if (replyId) {
      if (msg) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, replyId, 1);
        this.spoolQueue.markReplied(msg.messageId, msg.serialKey, replyId);
        this.spoolQueue.markDone(msg.messageId, msg.serialKey, replyId);
      } else {
        this.spoolQueue.recordReceipt(messageId ?? '');
      }
    } else {
      // Fallback to text（卡片与 text 必须展示相同的运行中状态，保持 UX 一致）
      const lines = [`📋 我的会话（最近 ${sessions.length} 个，共 ${allSessions.length} 个）`, ''];
      for (const [index, [uuid, session]] of sessions.entries()) {
        const providerTag = session.lastKnownProvider
          ? ` [${session.lastKnownProvider}]`
          : '';
        const runningTag = runningUuids.has(uuid) ? ' [运行中]' : '';
        lines.push(`${index + 1}. ${session.title ?? 'Untitled'}${providerTag}${runningTag}`);
        lines.push(`   ID: ${uuid.slice(0, 8)}`);
        lines.push(`   ${formatOrigin(session.origin, session.status)} | ${session.message_count}条 | ${formatTimeAgo(session.last_active)} | ${session.project_name ?? basename(session.cwd)}`);
        lines.push('');
      }
      if (hasMore) lines.push(`... 还有 ${allSessions.length - MAX_LIST_ITEMS} 个更早的会话未显示`);
      lines.push('━━━━━━━━━━━━━━━━');
      // BUG-4 修复：空状态不输出"回复 恢复 2"（无意义）。有 >= 2 个 session 时才输出索引提示。
      // 详见 review finding "doCardList text 降级空状态误导"（第三轮 review BUG-4）。
      if (sessions.length >= 2) {
        lines.push('💡 点击卡片上的按钮快速切换/恢复，或回复 "恢复 2" 获取恢复指引');
      } else if (sessions.length === 1) {
        lines.push('💡 点击卡片上的按钮快速切换/恢复');
      }
      // 【P0 修复】msg 在 card action 路径（handleCardAction 调用）是 undefined，原 msg! 会在 replyTo 抛 TypeError
      if (msg) {
        await this.replyAndFinalize(msg, lines.join('\n'));
      } else {
        await this.replyFn(lines.join('\n'), { messageId, openId, requestUuid: uniqueUuid() });
        this.spoolQueue.recordReceipt(messageId ?? '');
      }
    }
  }

  private async doCardNew(openId: string, messageId?: string): Promise<void> {
    const currentEntry = this.userManager.getEntry(openId);
    if (currentEntry?.type === 'pending_new_session_claimed') {
      await this.replyFn('⚠️ /new 正在处理中，请稍后再试。', { messageId, openId, requestUuid: uniqueUuid() });
      this.spoolQueue.recordReceipt(messageId ?? '');
      return;
    }

    const defaultCwd = config.get<string>('feishu_bot.default_cwd', '');
    const cwd = normalizeCwd(currentEntry?.cwd || defaultCwd || process.env.HOME || '');
    if (!cwd) {
      await this.replyFn('未配置默认工作目录，请先在 config.toml 中设置 feishu_bot.default_cwd。', { messageId, openId, requestUuid: uniqueUuid() });
      this.spoolQueue.recordReceipt(messageId ?? '');
      return;
    }
    const validationError = validateCwd(cwd);
    if (validationError) {
      await this.replyFn(validationError, { messageId, openId, requestUuid: uniqueUuid() });
      this.spoolQueue.recordReceipt(messageId ?? '');
      return;
    }

    const swapped = await this.userManager.compareAndSwap(
      openId,
      currentEntry ?? null,
      {
        ...currentEntry,
        type: 'pending_new_session',
        sessionUuid: null,
        createdAt: currentEntry?.createdAt ?? new Date().toISOString(),
        cwd,
      },
    );

    await this.replyFn(
      swapped ? '✅ 已设置新会话目录，请发送第一条消息来创建会话。' : '⚠️ /new 失败：会话状态已被其他操作变更，请稍后重试。',
      { messageId, openId, requestUuid: uniqueUuid() },
    );
    this.spoolQueue.recordReceipt(messageId ?? '');
  }

  private async doSwitch(openId: string, uuid: string, messageId?: string, msg?: SpoolMessage): Promise<string> {
    const session = this.registry.get(uuid);
    if (!session) {
      const reply = '未找到对应会话，请先执行 /list。';
      if (msg) await this.replyAndFinalize(msg, reply);
      else await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
      this.spoolQueue.recordReceipt(messageId ?? '');
      return reply;
    }

    const currentEntry = this.userManager.getEntry(openId);

    // status 检查：corrupted/provisioning/degraded/archived session 不允许切换
    // 与 doResume 行为一致（line 2157-2160），避免用户切到坏会话后发消息 Claude 端失败。
    // 详见 review finding "doSwitch 应该检查 session.status"（第三轮 review BUG-2）。
    if (session.status && session.status !== 'active') {
      const status = session.status;
      const failReply =
        status === 'corrupted'
          ? `⚠️ 会话 ${uuid.slice(0, 8)} 已损坏，不能直接切换。建议先在终端运行 \`cc-linker repair\` 修复。`
          : status === 'provisioning'
            ? `⚠️ 会话 ${uuid.slice(0, 8)} 正在等待系统自动修复，请稍后再试。`
            : status === 'degraded'
              ? `⚠️ 会话 ${uuid.slice(0, 8)} 处于降级状态，建议先保持 cc-linker 运行让系统自动修复。`
              : status === 'archived'
                ? `⚠️ 会话 ${uuid.slice(0, 8)} 已归档，不能直接切换。`
                : `⚠️ 会话 ${uuid.slice(0, 8)} 状态为 ${status}，无法切换。`;
      if (msg) await this.replyAndFinalize(msg, failReply);
      else await this.replyFn(failReply, { messageId, openId, requestUuid: uniqueUuid() });
      this.spoolQueue.recordReceipt(messageId ?? '');
      return 'failed';
    }

    const swapped = await this.userManager.compareAndSwap(
      openId,
      currentEntry ?? null,
      {
        ...currentEntry,
        type: 'session',
        sessionUuid: uuid,
        createdAt: currentEntry?.createdAt ?? new Date().toISOString(),
        cwd: session.cwd,
      },
    );

    // swapped=false 时发"切换失败"消息（不发 overview 卡片，避免误导用户）
    if (!swapped) {
      // 记录 CAS 冲突到日志，便于运维监控（cmd: serialKey 启用后并发场景增多）
      // 上线后监控指标建议：CAS 冲突频率 > X 次/分钟触发告警
      logger.warn(
        `CAS race on doSwitch: openId=${openId}, uuid=${uuid}, ` +
        `currentMappingVersion=${currentEntry ? this.userManager.getVersion() : 'none'}`,
      );
      const failReply = '⚠️ 切换失败：会话状态已被其他操作变更，请稍后重试';
      if (msg) await this.replyAndFinalize(msg, failReply);
      else await this.replyFn(failReply, { messageId, openId, requestUuid: uniqueUuid() });
      this.spoolQueue.recordReceipt(messageId ?? '');
      return 'failed';
    }

    // swapped=true：判断目标 session 是否正在处理（飞书 in-memory + CLI marker 统一）
    const isRunning = await isSessionProcessing(uuid, session, this);

    // 发概览卡片
    const card = buildSessionOverviewCard(uuid, session, isRunning);
    const replyId = await this.cardReplyFn(card, { messageId, openId });

    if (replyId) {
      if (msg) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, replyId, 1);
        this.spoolQueue.markReplied(msg.messageId, msg.serialKey, replyId);
        this.spoolQueue.markDone(msg.messageId, msg.serialKey, replyId);
      } else {
        this.spoolQueue.recordReceipt(messageId ?? '');
      }

      // 【live progress】总是先停止旧 watcher (防止 /switch A→B 后 A 的 watcher 残留)
      this.stopLiveWatcher(openId, 'new_switch').catch(err =>
        logger.error(`stopLiveWatcher(new_switch) failed: ${err}`),
      );

      // 启动新 watcher（仅 isRunning=true 时）
      if (isRunning) {
        const watcher = new LiveProgressWatcher({
          uuid,
          openId,
          cardMessageId: replyId,
          feishuClient: this.feishuClient,
          bot: this,
          config: this.liveConfig,
          onStop: (oid, _reason, w) => {
            // Identity check: 旧 watcher A 可能在 in-flight (5s race), 期间
            // /switch B 已 set 进 map. A 的 onStop 触发时, 如果 map 里的 oid
            // 已不是 A 而是 B, 删 oid 会误删 B. 必须 identity 比较.
            if (this.liveWatchers.get(oid) === w) {
              this.liveWatchers.delete(oid);
            }
          },
        });
        this.liveWatchers.set(openId, watcher);
        watcher.start();
      }
    } else {
      // 降级到 text
      const reply = `✅ 已切换到 ${uuid.slice(0, 8)}\n💬 最后提问：${session.last_user_preview ?? '无'}\n🤖 最后回复：${session.last_assistant_preview ?? '无'}\n📊 ${session.message_count} 条消息${session.last_active ? ' · ' + formatTimeAgo(session.last_active) : ''}`;
      if (msg) await this.replyAndFinalize(msg, reply);
      else await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
      this.spoolQueue.recordReceipt(messageId ?? '');  // 【review 必加】补回 recordReceipt,避免 card action 路径同 messageId 重复入队
    }
    return 'switched';
  }

  private async doSelectModel(openId: string, alias: string, messageId?: string): Promise<string> {
    const provider = this.providerManager.resolve(alias);
    if (!provider) {
      return `未知模型: "${alias}"\n请使用 /model 查看可用列表`;
    }

    const entry = this.userManager.getEntry(openId);
    const newEntry = entry
      ? { ...entry, defaultProvider: provider.alias }
      : {
          type: 'pending_new_session' as const,
          sessionUuid: null,
          createdAt: new Date().toISOString(),
          defaultProvider: provider.alias,
        };

    const swapped = await this.userManager.compareAndSwap(openId, entry ?? null, newEntry);
    if (!swapped) return '⚠️ 设置失败，请重试';

    this.spoolQueue.recordReceipt(messageId ?? '');
    return `✅ 默认模型已设置为 ${provider.name} (${provider.alias})`;
  }

  private async doClearModel(openId: string, messageId?: string): Promise<string> {
    const entry = this.userManager.getEntry(openId);
    if (!entry) {
      this.spoolQueue.recordReceipt(messageId ?? '');
      return '⚠️ 无当前会话状态，无需清除';
    }
    const swapped = await this.userManager.compareAndSwap(
      openId, entry,
      { ...entry, defaultProvider: undefined }
    );
    this.spoolQueue.recordReceipt(messageId ?? '');
    return swapped ? '✅ 已清除默认模型设置' : '⚠️ 清除失败，请重试';
  }

  private async doListDir(openId: string, messageId?: string, msg?: SpoolMessage): Promise<void> {
    const cwd = this.getCwdForUser(openId);
    if (!cwd) {
      const reply = '未配置工作目录，请先在 config.toml 中设置 feishu_bot.default_cwd，或使用 /new <路径>。';
      if (msg) await this.replyAndFinalize(msg, reply);
      else await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
      return;
    }

    const normalized = normalizeCwd(cwd);
    const validationError = validateCwd(normalized);
    if (validationError) {
      if (msg) await this.replyAndFinalize(msg, validationError);
      else await this.replyFn(validationError, { messageId, openId, requestUuid: uniqueUuid() });
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(normalized, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    } catch (err: any) {
      const reply = `❌ 无法读取目录: ${err.message}`;
      if (msg) await this.replyAndFinalize(msg, reply);
      else await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
      return;
    }

    const hasMore = entries.length > MAX_DIR_LIST_ITEMS;
    const displayDirs = entries.slice(0, MAX_DIR_LIST_ITEMS);

    const parent = normalized !== dirname(normalized) ? dirname(normalized) : null;

    const card = buildDirListCard(normalized, displayDirs, parent, hasMore, entries.length);
    const replyId = await this.cardReplyFn(card, { messageId, openId });

    if (replyId) {
      if (msg) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, replyId, 1);
        this.spoolQueue.markReplied(msg.messageId, msg.serialKey, replyId);
        this.spoolQueue.markDone(msg.messageId, msg.serialKey, replyId);
      } else {
        this.spoolQueue.recordReceipt(messageId ?? '');
      }
    } else {
      const lines = [`📂 目录浏览: ${normalized}`, ''];
      if (parent) lines.push(`⬆️ 上级目录: ${parent}`);
      if (displayDirs.length === 0) {
        lines.push('📁 当前目录下没有子目录');
      } else {
        for (const dir of displayDirs) {
          lines.push(`📁 ${dir}`);
        }
      }
      if (hasMore) lines.push(`\n... 还有 ${entries.length - MAX_DIR_LIST_ITEMS} 个子目录未显示`);
      lines.push('\n💡 使用 /new <路径> 切换到指定目录');
      if (msg) await this.replyAndFinalize(msg, lines.join('\n'));
      else await this.replyFn(lines.join('\n'), { messageId, openId, requestUuid: uniqueUuid() });
    }
  }

  private async doSelectDir(openId: string, path: string, messageId?: string): Promise<string> {
    if (!path) {
      const reply = '参数错误：缺少目录路径';
      await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
      return reply;
    }

    const normalized = normalizeCwd(path);
    const validationError = validateCwd(normalized);
    if (validationError) {
      await this.replyFn(validationError, { messageId, openId, requestUuid: uniqueUuid() });
      return validationError;
    }

    const currentEntry = this.userManager.getEntry(openId);
    const swapped = await this.userManager.compareAndSwap(
      openId,
      currentEntry ?? null,
      {
        ...currentEntry,
        type: 'pending_new_session',
        sessionUuid: null,
        createdAt: currentEntry?.createdAt ?? new Date().toISOString(),
        cwd: normalized,
      },
    );

    if (!swapped) {
      const reply = '⚠️ 操作冲突，请重试';
      await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
      return reply;
    }

    this.spoolQueue.recordReceipt(messageId ?? '');
    const reply = `✅ 已切换到 ${normalized}\n发送消息即可在该目录创建新会话。`;
    await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
    return reply;
  }

  /** Check if a session is currently being processed by Claude (in active processes). */
  private isSessionRunning(uuid: string): boolean {
    return this.sessionManager.listSessions().some(s => s.sessionId === uuid);
  }

  private async doResume(openId: string, uuid: string, messageId?: string): Promise<string> {
    const entry = this.registry.get(uuid);
    if (!entry) return '未找到对应会话，请先执行 /list。';
    if (entry.status === 'corrupted') return `会话 ${uuid.slice(0, 8)} 已损坏，不能直接恢复。`;
    if (entry.status === 'provisioning' || entry.status === 'degraded') {
      return `会话 ${uuid.slice(0, 8)} 状态为 ${entry.status}，建议先保持 cc-linker 运行让系统自动修复。`;
    }
    return `在终端执行: cc-linker resume ${uuid.slice(0, 8)}`;
  }

  private async doResumeReply(openId: string, uuid: string, msg: SpoolMessage): Promise<void> {
    const reply = await this.doResume(openId, uuid);
    await this.replyAndFinalize(msg, reply);
  }

  private async doStatus(openId: string, messageId?: string): Promise<string> {
    const entry = this.userManager.getEntry(openId);
    const queueSize = this.spoolQueue.queueSize();
    const sessions = Object.values(this.registry.sessions);

    const provider = entry?.defaultProvider
      ? this.providerManager.resolve(entry.defaultProvider)
      : null;

    return [
      'cc-linker 状态',
      '─'.repeat(30),
      `队列消息: ${queueSize}`,
      `总会话数: ${sessions.length}`,
      `CLI 会话: ${sessions.filter(s => s.origin === 'cli').length}`,
      `飞书会话: ${sessions.filter(s => s.origin === 'feishu').length}`,
      `当前会话: ${entry?.type === 'session' ? entry.sessionUuid?.slice(0, 8) : '无'}`,
      `映射状态: ${entry?.type ?? 'none'}`,
      `默认模型: ${provider ? `${provider.name} (${provider.alias})` : '未设置（跟随 Claude 全局配置）'}`,
    ].join('\n');
  }

  /** Handle stop action from card button. Returns card for WS response. */
  private async doStop(openId: string, _messageId?: string): Promise<string | Record<string, unknown> | null> {
    logger.info(`[stop] doStop called: openId=${openId}, messageId=${_messageId}`);
    const { stopped, hasTarget } = await this._stopUserSession(openId);
    logger.info(`[stop] doStop result: hasTarget=${hasTarget}, stopped=${stopped}`);

    if (!hasTarget) {
      return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'ℹ️ 无需停止' }, template: 'grey' },
        elements: [{ tag: 'markdown', content: '当前没有活跃会话。' }],
      };
    }

    if (stopped) {
      return {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '✅ 已停止' }, template: 'green' },
        elements: [{ tag: 'markdown', content: '已停止当前会话的处理。\n\n你可以随时发送新消息继续对话。' }],
      };
    }

    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'ℹ️ 无运行中任务' }, template: 'grey' },
      elements: [{ tag: 'markdown', content: '当前会话没有正在运行的处理任务。' }],
    };
  }
}

/** Build a session list card with switch/resume action buttons */
function buildListCard(
  sessions: Array<[string, SessionEntry]>,
  total: number,
  hasMore: boolean,
  runningUuids: Set<string>,
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];

  if (sessions.length === 0) {
    elements.push({ tag: 'markdown', content: '当前没有可用会话。\n可使用 **✨ 新建会话** 创建新会话。' });
  } else {
    for (const [i, [uuid, entry]] of sessions.entries()) {
      const index = i + 1;  // 1-based,与 text fallback (line 1888) 和 snapshot (line 1852) 一致
      const runningMark = runningUuids.has(uuid) ? '🔴 ' : '';
      // esc() 必须在 preview() 之后调用,避免 preview 截断把 &lt; 切到一半
      // (例如 '<' + 截断会变成 '<' 单独一个被误读)
      const aiPreviewLine = entry.last_assistant_preview
        ? `\n🤖 ${esc(preview(entry.last_assistant_preview, 60))}`
        : '';
      // truncateTitleForCard: 防御性截断（与 scanner 的 truncateTitle 对齐）
      const safeTitle = esc(truncateTitleForCard(entry.title));
      elements.push({
        tag: 'markdown',
        content: `**${index}. ${runningMark}${safeTitle}**\nID: \`${uuid.slice(0, 8)}\` | ${entry.message_count}条 | ${formatTimeAgo(entry.last_active)} | ${formatOrigin(entry.origin, entry.status)} | ${esc(entry.project_name ?? '')}\n📁 \`${esc(entry.cwd ?? '-')}\`${aiPreviewLine}`,
      });
      elements.push({
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '🔄 切换' }, type: 'primary', value: { tag: 'switch', sessionId: uuid } },
          { tag: 'button', text: { tag: 'plain_text', content: '📖 恢复' }, type: 'default', value: { tag: 'resume', sessionId: uuid } },
        ],
      });
      // <hr> 只在 session 之间插入(不是最后一条之后)
      if (i < sessions.length - 1) {
        elements.push({ tag: 'hr' });
      }
    }
    if (hasMore) {
      elements.push({ tag: 'markdown', content: `... 还有 ${total - sessions.length} 个更早的会话未显示` });
    }
  }

  return {
    config: { wide_screen_mode: true },
    elements,
    header: { title: { tag: 'plain_text', content: `📋 我的会话（${sessions.length}/${total}）` }, template: 'blue' },
  };
}

/** Build an overview card for the user to see session progress after switch. */
interface OverviewCardOverrides {
  lastUserPreview?: string;
  lastAssistantPreview?: string;
  elapsedMs?: number;
  sinceLastOutputMs?: number;
}

function buildSessionOverviewCard(
  uuid: string,
  entry: Pick<SessionEntry, 'title' | 'cwd' | 'message_count' | 'last_active' | 'origin' | 'status' | 'last_user_preview' | 'last_assistant_preview'>,
  isRunning: boolean,
  overrides: OverviewCardOverrides = {},
): Record<string, unknown> {
  const lastUser = overrides.lastUserPreview ?? entry.last_user_preview;
  const lastAssistant = overrides.lastAssistantPreview ?? entry.last_assistant_preview;
  const liveHint = isRunning ? ' _(实时)_' : '';

  const runningTag = isRunning ? '🔴 处理中 · ' : '';
  const titlePrefix = `${runningTag}${esc(truncateTitleForCard(entry.title))}`;

  // 构建状态提示行（运行时间 / 输出等待提示）
  const statusLines: string[] = [];
  if (isRunning && overrides.elapsedMs !== undefined) {
    statusLines.push(`⏱️ 已运行 ${formatDuration(overrides.elapsedMs)}`);
  }
  if (isRunning && overrides.sinceLastOutputMs !== undefined && overrides.sinceLastOutputMs > 30_000) {
    statusLines.push(`⏳ ${formatDuration(overrides.sinceLastOutputMs)} 未收到新输出`);
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: isRunning ? '🔄 处理中会话' : '🔄 已切换会话' },
      template: isRunning ? 'orange' : 'blue',
    },
    elements: [
      { tag: 'markdown', content: `**${titlePrefix}${liveHint}**\nID: \`${uuid.slice(0, 8)}\`\n📁 \`${esc(entry.cwd ?? '-')}\`` },
      ...(statusLines.length > 0 ? [{ tag: 'markdown', content: statusLines.join(' · ') }] : []),
      ...(lastUser ? [{ tag: 'markdown', content: `**💬 最后提问：**\n> ${esc(lastUser)}` }] : []),
      ...(lastAssistant ? [{ tag: 'markdown', content: `**🤖 最后回复：**\n> ${esc(lastAssistant)}` }] : []),
      ...(isRunning && !lastAssistant ? [{ tag: 'markdown', content: `**🤖 最后回复：**\n> ⏳ 正在处理中，请稍候...` }] : []),
      { tag: 'hr' },
      // 元信息行：消息数 + 时间 + 来源/状态（与 list 卡片保持一致）
      // 非 active status 显示中文标签（如 '已损坏'）—— ITEM-6 修复
      // 使用 formatMetaStats helper 避免与 list 卡片漂移（ITEM-3 修复）
      { tag: 'markdown', content: `📊 ${formatMetaStats(entry)}\n\n💡 直接发送消息即可继续此会话` },
      { tag: 'hr' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '📖 恢复指引' }, type: 'default', value: { tag: 'resume', sessionId: uuid } },
      ]},
    ],
  };
}

/** Build a model selection card with select/clear action buttons */
function buildModelCard(
  providers: Array<{ alias: string; name: string }>,
  currentAlias: string | null,
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];

  if (currentAlias) {
    const current = providers.find(p => p.alias === currentAlias);
    elements.push({
      tag: 'markdown',
      content: `**当前默认:** ${esc(current?.name ?? currentAlias ?? '')} (\`${esc(currentAlias)}\`)`,
    });
    elements.push({ tag: 'hr' });
  }

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const isCurrent = p.alias === currentAlias;
    elements.push({
      tag: 'markdown',
      content: `${i + 1}. **${esc(p.name)}**  \`${esc(p.alias)}\`${isCurrent ? '  ✅' : ''}`,
    });
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: isCurrent ? '✅ 已选择' : '🎯 选择' },
          type: isCurrent ? 'default' : 'primary',
          value: { tag: 'select_model', sessionId: p.alias },
        },
      ],
    });
    if (i < providers.length - 1) {
      elements.push({ tag: 'hr' });
    }
  }

  if (currentAlias) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🧹 清除默认' },
          type: 'danger',
          value: { tag: 'clear_model', sessionId: '' },
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    elements,
    header: { title: { tag: 'plain_text', content: '🤖 模型选择' }, template: 'blue' },
  };
}

const MAX_DIR_LIST_ITEMS = 15;

/** Build a directory listing card with enter/parent action buttons */
function buildDirListCard(
  cwd: string,
  dirs: string[],
  parent: string | null,
  hasMore?: boolean,
  total?: number,
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];

  elements.push({
    tag: 'markdown',
    content: `**当前路径：**\n\`${esc(cwd)}\``,
  });

  if (parent) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '⬆️ 上级目录' },
        type: 'default',
        value: { tag: 'select_dir', sessionId: parent },
      }],
    });
  }

  if (dirs.length === 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: '📁 当前目录下没有子目录' });
  } else {
    elements.push({ tag: 'hr' });
    for (const dir of dirs) {
      elements.push({
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: `📁 ${dir}` },
          type: 'primary',
          value: { tag: 'select_dir', sessionId: join(cwd, dir) },
        }],
      });
    }
  }

  if (hasMore && total !== undefined) {
    elements.push({
      tag: 'markdown',
      content: `\n... 还有 ${total - dirs.length} 个子目录未显示`,
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📂 目录浏览' }, template: 'blue' },
    elements,
  };
}

function preview(text: string, maxLength = 80): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function buildSessionTitle(text: string): string {
  return preview(text, 60) || 'Untitled';
}

/** 渲染时截断 title 到 50 字符（防御性，与 scanner 的 truncateTitle 行为对齐）。
 *  registry 里可能有历史超长 title（未截断的旧 entry / 手动编辑 / 第三方工具写入），
 *  card 渲染时必须再次截断以避免 Feishu 4KB 元素限制。*/
function truncateTitleForCard(s: string | null | undefined): string {
  if (!s) return 'Untitled';
  return s.length > 50 ? s.slice(0, 50) + '...' : s;
}

/** Format milliseconds into Chinese human-readable duration.
 *  Used by live progress card to show elapsed time / stale hints. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours} 小时 ${mins} 分` : `${hours} 小时`;
}

function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) return '';
  if (trimmed === '~') return process.env.HOME ?? trimmed;
  if (trimmed.startsWith('~/')) {
    return resolve(process.env.HOME ?? '', trimmed.slice(2));
  }
  return resolve(trimmed);
}

function validateCwd(cwd: string): string | null {
  const allowedRoots = config.get<string[]>('security.allowed_roots', []).map(normalizeCwd).filter(Boolean);
  const deniedRoots = config.get<string[]>('security.denied_roots', []).map(normalizeCwd).filter(Boolean);

  if (allowedRoots.length > 0) {
    const isAllowed = allowedRoots.some(root => cwd === root || cwd.startsWith(`${root}/`));
    if (!isAllowed) {
      return `❌ 目录 ${cwd} 不在允许列表中`;
    }
  }

  const denied = deniedRoots.find(root => cwd === root || cwd.startsWith(`${root}/`));
  if (denied) {
    return `❌ 目录 ${cwd} 被禁止使用`;
  }

  if (!existsSync(cwd)) {
    return `❌ 目录 ${cwd} 不存在，请先创建该目录`;
  }

  return null;
}

function parseNewCommand(rawArgs: string): { cwd: string; prompt: string; providerAlias?: string } {
  let args = rawArgs.trim();
  let providerAlias: string | undefined;

  // Extract --model alias
  const modelMatch = args.match(/--model\s+(\S+)/);
  if (modelMatch) {
    providerAlias = modelMatch[1];
    args = args.replace(/--model\s+\S+/, '').trim();
  }

  if (!args) {
    return { cwd: '', prompt: '', providerAlias };
  }

  if (args.startsWith('-- ')) {
    return { cwd: '', prompt: args.slice(3).trim(), providerAlias };
  }

  const separator = args.indexOf(' -- ');
  if (separator >= 0) {
    return {
      cwd: args.slice(0, separator).trim(),
      prompt: args.slice(separator + 4).trim(),
      providerAlias,
    };
  }

  return { cwd: args, prompt: '', providerAlias };
}

/** Status 中文映射表（ITEM-6 修复）—— 把 session.status 英文术语翻译成中文卡片标签。 */
const STATUS_LABELS: Record<string, string> = {
  provisioning: '等待修复中',
  degraded: '已降级',
  archived: '已归档',
  corrupted: '已损坏',
};

function formatOrigin(origin: string, status?: string): string {
  if (status && status !== 'active') {
    return STATUS_LABELS[status] ?? status;
  }
  return origin === 'feishu' ? '飞书' : '终端';
}

/** 格式化元信息行（ITEM-3 修复）—— 提取 list/overview 卡片共用的统计部分。
 *  list 卡片用 ` | ` 分隔，overview 卡片用 ` · ` 分隔——helper 返回拼接好的字符串，
 *  调用方决定是否替换分隔符。*/
function formatMetaStats(entry: { message_count: number; last_active?: string; origin: string; status?: string }): string {
  const timePart = entry.last_active ? formatTimeAgo(entry.last_active) : '';
  return `${entry.message_count} 条消息${timePart ? ' · ' + timePart : ''} · ${formatOrigin(entry.origin, entry.status)}`;
}

export function splitReplyText(text: string, maxBytes: number): string[] {
  if (!text) {
    return [''];
  }

  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let end = remaining.length;
    while (end > 0 && encoder.encode(remaining.slice(0, end)).length > maxBytes) {
      end--;
    }
    if (end === 0) end = 1;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return chunks;
}

function computeRetryDelay(retryCount: number): number {
  return Math.min(30_000, 500 * Math.pow(2, retryCount));
}

import { basename, dirname, join, resolve } from 'path';
import { existsSync, readdirSync } from 'fs';
import { UserManager } from './mapping';
import { ListSnapshotManager, ListSnapshotEntry } from './list-snapshot';
import { SpoolQueue, SpoolMessage, TargetSnapshot } from '../queue/spool';
import { ClaudeSessionManager, SendMessageResult } from '../proxy/session';
import { sessionManager as defaultSessionManager } from '../proxy/session';
import type { AgentViewManager } from '../agent-view/manager';
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
    const { tag, value } = action;
    const messageId = message?.message_id;

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

    const sessionId = value as string;

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

    if (!updated) return null;

    // 移回 pending/ 目录，让 worker 下一轮 dispatch 重新 claim
    // 重新 claim 时会看到 skipActivityCheck=true，跳过活跃检测直接处理
    const requeued = this.spoolQueue.requeueFromProcessing(
      targetMsg.messageId,
      targetMsg.serialKey
    );
    if (!requeued) {
      logger.warn(`强制发送后移回 pending 失败: ${targetMsg.serialKey}:${targetMsg.messageId}`);
      return null;
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

  /** Dispatch a `/` command message to the appropriate handler. */
  async handleCommand(msg: SpoolMessage): Promise<void> {
    const parts = msg.text.split(/\s+/);
    const cmd = parts[0]?.replace(/^\/+/, '')?.toLowerCase();

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
        await this.agentView.handleList(msg.openId, msg.messageId);
        return;

      default:
        await this.replyAndFinalize(msg, `未知命令: /${cmd}\n\n${this.helpText()}`);
        return;
    }
  }

  private async handleChat(msg: SpoolMessage): Promise<void> {
    switch (msg.target.type) {
      case 'session': {
        const sessionUuid = msg.target.sessionUuid ?? '';
        const currentEntry = this.registry.get(sessionUuid);
        const cwd = msg.target.cwd || currentEntry?.cwd || process.env.HOME || '/';

        if (!msg.skipActivityCheck && currentEntry) {
          try {
            const status = await isSessionActive(
              currentEntry,
              this.sessionManager.activityCache ?? new SessionActivityCache(),
              'feishu-detects-cli'
            );
            if (status.isProcessing && status.confidence !== 'low') {
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
    const cardUpdater = new CardUpdater(this.feishuClient, { throttle_ms: 0 });
    return await cardUpdater.createCLIBusyCard(
      msg.openId,
      entry?.title ?? '未命名会话',
      status
    );
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
  }): Promise<{ result: SendMessageResult; handler: PermissionHandler; cardMessageId: string | null }> {
    const { openId, sessionUuid, cwd, settingsPath, promptText, serialKey, isNew = false } = params;
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
        const wasCancelled = this.cancelledMessageIds.has(serialKey);
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

      return { result, handler, cardMessageId };
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
      '  /stop                              - 停止当前会话的处理',
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

    const allSessions = Object.entries(this.registry.sessions)
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

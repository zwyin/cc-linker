import { basename, resolve } from 'path';
import { existsSync } from 'fs';
import { UserManager } from './mapping';
import { ListSnapshotManager, ListSnapshotEntry } from './list-snapshot';
import { SpoolQueue, SpoolMessage, TargetSnapshot } from '../queue/spool';
import { ClaudeSessionManager } from '../proxy/session';
import { sessionManager as defaultSessionManager } from '../proxy/session';
import { StreamChunk } from '../proxy/stream-parser';
import { CardUpdater } from './card-updater';
import { RegistryManager } from '../registry';
import { syncBeforeCommand } from '../scanner';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { repairJsonlLastPrompt } from '../utils/jsonl-repair';
import { formatTimeAgo } from '../cli/output';
import { ProviderManager } from '../utils/providers';

export type FeishuMessageEvent = {
  open_id: string;
  message_id: string;
  content: string;
  chat_type: 'p2p' | 'group';
  message_type: 'text';
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
  action: { tag: string; value: string };
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

    if (event.message_type !== 'text') {
      logger.debug(`忽略非文本消息: ${event.message_id} (message_type=${event.message_type})`);
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
    try {
      const content = JSON.parse(event.content);
      text = content.text ?? '';
    } catch {
      text = event.content;
    }

    text = text.trim();
    if (!text) return;

    // P0-2: 消息长度限制
    const MAX_MESSAGE_LENGTH = 10000;
    if (text.length > MAX_MESSAGE_LENGTH) {
      await this.replyFn(
        `消息过长（${text.length} 字符），请控制在 ${MAX_MESSAGE_LENGTH} 字符以内，或将内容分段发送。`,
        { messageId: event.message_id, openId: event.open_id, requestUuid: stableUuid(event.message_id) },
      );
      return;
    }

    const target = text.startsWith('/bridge')
      ? { type: 'no_target' as const, openId: event.open_id, mappingVersion: this.userManager.getVersion() }
      : await this.resolveChatTarget(event.open_id, event.message_id);

    const serialKey = target.type === 'session' && target.sessionUuid
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
    };

    const enqueued = this.spoolQueue.enqueue(spoolMsg);
    if (!enqueued) {
      logger.warn(`消息入队失败: ${event.message_id}`);
      await this.replyFn('消息处理队列已满，请稍后重试。', {
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

        await Promise.race(this.activeWorkers);
      }
    } finally {
      this.running = false;
    }
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

  /** Handle card action callback from Feishu (card.action.trigger via WSClient) */
  async handleCardAction(payload: FeishuBotCardAction): Promise<string | null> {
    const { open_id: openId, action, message } = payload;
    const { tag, value } = action;
    const messageId = message?.message_id;

    if (!openId || !tag) {
      logger.warn(`卡片回调缺少必要字段: tag=${tag}, openId=${openId}`);
      return null;
    }

    const sessionId = value;

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
      case 'status': {
        const reply = await this.doStatus(openId);
        await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
        return reply;
      }
      default: {
        const reply = `未知操作: ${tag}`;
        await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
        return reply;
      }
    }
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

  /** Process a claimed message (already moved to processing dir). */
  private async handleClaimed(msg: SpoolMessage): Promise<void> {
    if (this.spoolQueue.hasSentDelivery(msg.messageId)) {
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey, msg.replyMessageId);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey, msg.replyMessageId);
      return;
    }

    try {
      if (msg.responseText) {
        await this.replyAndFinalize(msg, msg.responseText);
      } else if (msg.text.startsWith('/bridge')) {
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

  private async handleCommand(msg: SpoolMessage): Promise<void> {
    const parts = msg.text.split(/\s+/);
    const cmd = parts[1]?.toLowerCase();

    switch (cmd) {
      case 'help':
        await this.replyAndFinalize(msg, this.helpText());
        return;

      case 'list':
        await this.handleList(msg);
        return;

      case 'new':
        await this.handleNew(msg, msg.text.replace(/^\/bridge\s+new\s*/i, ''));
        return;

      case 'switch':
        await this.handleSwitch(msg, parts.slice(2).join(' '));
        return;

      case 'model':
        await this.handleModel(msg, parts.slice(2).join(' '));
        return;

      case 'resume':
        await this.handleResume(msg, parts.slice(2).join(' '));
        return;

      case 'status':
        await this.handleStatus(msg);
        return;

      case 'whoami':
        await this.replyAndFinalize(msg, `你的 open_id: ${msg.openId}\n\n将其填入 config.toml 的 feishu_bot.owner_open_id 可限制仅你本人使用。`);
        return;

      default:
        await this.replyAndFinalize(msg, `未知命令: /bridge ${cmd}\n\n${this.helpText()}`);
        return;
    }
  }

  private async handleChat(msg: SpoolMessage): Promise<void> {
    switch (msg.target.type) {
      case 'session': {
        const sessionUuid = msg.target.sessionUuid ?? '';
        const currentEntry = this.registry.get(sessionUuid);
        const cwd = msg.target.cwd || currentEntry?.cwd || process.env.HOME || '/';

        if (config.get<boolean>('stream.enabled', false)) {
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
          await this.replyAndFinalize(msg, '新会话正在创建，请稍后重试，或执行 /bridge list 查看是否已生成。');
          return;
        }

        if (claimResult.status !== 'claimed') {
          await this.replyAndFinalize(msg, '新会话创建入口已失效，请重新执行 /bridge new。');
          return;
        }

        if (config.get<boolean>('stream.enabled', false)) {
          await this.createSessionFromPromptStreaming(msg, msg.target.cwd ?? claimResult.entry.cwd ?? '', claimMessageId, msg.text);
        } else {
          await this.createSessionFromPrompt(msg, msg.target.cwd ?? claimResult.entry.cwd ?? '', claimMessageId, msg.text);
        }
        return;
      }

      case 'new_session_creating':
        await this.replyAndFinalize(msg, '新会话正在创建，请稍后重试，或执行 /bridge list 查看是否已生成。');
        return;

      case 'no_target':
      default:
        await this.replyAndFinalize(msg, [
          '当前没有活跃会话。',
          '请先执行以下任一命令：',
          '1. /bridge list',
          '2. /bridge switch <ID>',
          '3. /bridge new [cwd] [-- prompt]',
        ].join('\n'));
        return;
    }
  }

  /** Non-streaming path for existing session messages (extracted from original handleChat session case) */
  private async handleChatNonStreaming(
    msg: SpoolMessage, sessionUuid: string, cwd: string, currentEntry: any,
  ): Promise<void> {
    const result = await this.sessionManager.sendMessage(sessionUuid, msg.text, cwd, false, msg.serialKey);

    this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, {
      responseText: result.response || '(空回复)',
    });

    this.registry.upsert(sessionUuid, {
      cwd,
      last_active: new Date().toISOString(),
      last_message_preview: preview(msg.text),
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
      const result = await this.sessionManager.sendStreamingMessage(
        sessionUuid, msg.text, cwd,
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
        false, msg.serialKey,
      );

      // Finalize card
      if (cardUpdater) {
        if (cardUpdater.shouldFallbackToText(text)) {
          const truncated = cardUpdater.truncateContent(text);
          await cardUpdater.complete(truncated, result.costUsd, result.durationMs, 1);
          const remainder = text.slice(truncated.length);
          if (remainder && config.get<boolean>('stream.fallback_to_text', true)) {
            for (const chunk of splitReplyText(remainder, 3900)) {
              await this.replyFn(chunk, { messageId: msg.messageId, openId: msg.openId });
            }
          }
        } else {
          await cardUpdater.complete(text, result.costUsd, result.durationMs, 1);
        }
        cardMessageId = cardUpdater.getCardMessageId();
        cardUpdater.dispose();
      }

      // Update registry
      this.registry.upsert(sessionUuid, {
        cwd, last_active: new Date().toISOString(), last_message_preview: preview(msg.text),
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
    } catch (err: any) {
      if (cardUpdater) {
        await cardUpdater.error(err.message ?? 'Unknown error');
        cardMessageId = cardUpdater.getCardMessageId();
        cardUpdater.dispose();
      } else if (!cardInitFailed) {
        await this.replyFn(`处理失败: ${err.message}`, { messageId: msg.messageId, openId: msg.openId });
      }
      if (cardMessageId) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, cardMessageId, 1);
      }
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
      this.spoolQueue.markFailed(msg.messageId, msg.serialKey, String(err));
    }
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
      const result = await this.sessionManager.sendStreamingMessage(
        null, prompt, cwd,
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
        true, `new:${msg.openId}`,
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
        if (cardUpdater.shouldFallbackToText(text)) {
          const truncated = cardUpdater.truncateContent(text);
          await cardUpdater.complete(truncated, result.costUsd, result.durationMs, 1);
          const remainder = text.slice(truncated.length);
          if (remainder && config.get<boolean>('stream.fallback_to_text', true)) {
            for (const chunk of splitReplyText(remainder, 3900)) {
              await this.replyFn(chunk, { messageId: msg.messageId, openId: msg.openId });
            }
          }
        } else {
          await cardUpdater.complete(text, result.costUsd, result.durationMs, 1);
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
        last_message_preview: preview(prompt),
        status: result.sessionStatus,
        jsonl_path: result.jsonlPath,
        pending_jsonl_resolve: !result.jsonlPath,
        last_error: result.error ?? null,
        feishu_user_id: msg.openId,
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
    } catch (err: any) {
      if (cardUpdater) {
        await cardUpdater.error(err.message ?? 'Unknown error');
        cardMessageId = cardUpdater.getCardMessageId();
        cardUpdater.dispose();
      } else if (!cardInitFailed) {
        await this.replyFn(`创建失败: ${err.message}`, { messageId: msg.messageId, openId: msg.openId });
      }
      if (cardMessageId) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, cardMessageId, 1);
      }
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
      this.spoolQueue.markFailed(msg.messageId, msg.serialKey, String(err));
    }
  }

  private async handleList(msg: SpoolMessage): Promise<void> {
    await this.doCardList(msg.openId, msg.messageId, msg);
  }

  private async handleNew(msg: SpoolMessage, rawArgs: string): Promise<void> {
    const { cwd: rawCwd, prompt, providerAlias } = parseNewCommand(rawArgs);
    const defaultCwd = config.get<string>('feishu_bot.default_cwd', '');
    const cwd = normalizeCwd(rawCwd || defaultCwd);

    // If --model specified, set defaultProvider first
    if (providerAlias) {
      const provider = this.providerManager.resolve(providerAlias);
      if (!provider) {
        await this.replyAndFinalize(msg, `未知模型: "${providerAlias}"\n请使用 /bridge model 查看可用列表`);
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
      await this.replyAndFinalize(msg, '请使用 /bridge new <cwd>，或在配置里设置 feishu_bot.default_cwd。');
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
        await this.replyAndFinalize(msg, '当前已有新会话正在创建，请稍后再试。');
        return;
      }

      const swapped = await this.userManager.compareAndSwap(
        msg.openId,
        currentEntry ?? null,
        {
          type: 'pending_new_session',
          sessionUuid: null,
          createdAt: currentEntry?.createdAt ?? new Date().toISOString(),
          cwd,
        },
      );

      await this.replyAndFinalize(
        msg,
        swapped ? '✅ 已设置新会话目录，请继续发送第一条消息。' : '⚠️ 会话状态冲突，请稍后重试。',
      );
      return;
    }

    const currentEntry = this.userManager.getEntry(msg.openId);
    if (currentEntry?.type === 'pending_new_session_claimed') {
      await this.replyAndFinalize(msg, '当前已有新会话正在创建，请稍后再试。');
      return;
    }

    const now = new Date().toISOString();
    const swapped = await this.userManager.compareAndSwap(
      msg.openId,
      currentEntry ?? null,
      {
        type: 'pending_new_session_claimed',
        sessionUuid: null,
        createdAt: currentEntry?.createdAt ?? now,
        cwd,
        claimedByMessageId: msg.messageId,
        claimedAt: now,
      },
    );

    if (!swapped) {
      await this.replyAndFinalize(msg, '⚠️ 无法创建新会话，请稍后重试。');
      return;
    }

    if (config.get<boolean>('stream.enabled', false)) {
      await this.createSessionFromPromptStreaming(msg, cwd, msg.messageId, prompt);
    } else {
      await this.createSessionFromPrompt(msg, cwd, msg.messageId, prompt);
    }
  }

  private async handleSwitch(msg: SpoolMessage, target: string): Promise<void> {
    if (!target) {
      await this.replyAndFinalize(msg, '用法: /bridge switch <序号或 UUID>');
      return;
    }

    const index = parseInt(target, 10);
    const uuid = Number.isNaN(index)
      ? (this.registry.findByPrefix(target)?.[0] ?? null)
      : this.listSnapshotManager.resolveIndex(index, msg.openId);

    if (!uuid) {
      await this.replyAndFinalize(msg, `未找到 "${target}" 对应的会话（或匹配到多个），请先执行 /bridge list 查看完整列表。`);
      return;
    }

    await this.doSwitch(msg.openId, uuid, msg.messageId, msg);
  }

  private async handleResume(msg: SpoolMessage, target: string): Promise<void> {
    if (!target) {
      await this.replyAndFinalize(msg, '用法: /bridge resume <序号或 UUID>');
      return;
    }

    const index = parseInt(target, 10);
    const uuid = Number.isNaN(index)
      ? (this.registry.findByPrefix(target)?.[0] ?? null)
      : this.listSnapshotManager.resolveIndex(index, msg.openId);

    if (!uuid) {
      await this.replyAndFinalize(msg, `未找到 "${target}" 对应的会话（或匹配到多个），请先执行 /bridge list 查看完整列表。`);
      return;
    }

    await this.doResumeReply(msg.openId, uuid, msg);
  }

  private async handleStatus(msg: SpoolMessage): Promise<void> {
    const reply = await this.doStatus(msg.openId, msg.messageId);
    if (reply) await this.replyAndFinalize(msg, reply);
  }

  private async handleModel(msg: SpoolMessage, target: string): Promise<void> {
    if (!target) {
      const entry = this.userManager.getEntry(msg.openId);
      const currentAlias = entry?.defaultProvider ?? null;
      const lines: string[] = [];

      if (currentAlias) {
        const provider = this.providerManager.resolve(currentAlias);
        lines.push(`当前默认模型: ${provider?.name ?? currentAlias}`);
      } else {
        lines.push('当前默认模型: 未设置（跟随 Claude 全局配置）');
      }

      const providers = this.providerManager.list();
      if (providers.length > 0) {
        lines.push('');
        lines.push('可用模型:');
        providers.forEach((p, i) => {
          const marker = p.alias === currentAlias ? '●' : ' ';
          lines.push(`  ${marker} ${i + 1}. ${p.name}  (${p.alias})`);
        });
      } else {
        lines.push('');
        lines.push('未检测到可切换模型。');
        lines.push('请安装 CC Switch 或手动创建 ~/.claude/providers/*.json');
      }

      lines.push('');
      lines.push('用法:');
      lines.push('  /bridge model <序号|别名>        设置默认模型');
      lines.push('  /bridge model --clear            清除默认设置');
      lines.push('  /bridge new /path --model <别名>  创建会话时指定模型');

      await this.replyAndFinalize(msg, lines.join('\n'));
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
      await this.replyAndFinalize(msg, `未知模型: "${target}"\n请使用 /bridge model 查看可用列表`);
      return;
    }

    const entry = this.userManager.getEntry(msg.openId);
    const newEntry = entry
      ? { ...entry, defaultProvider: provider.alias }
      : {
          type: 'session' as const,
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
      '  /bridge help                              - 显示此帮助',
      '  /bridge list                              - 列出会话',
      '  /bridge new [路径] [-- prompt]            - 创建新会话',
      '  /bridge new [路径] --model <别名> [-- p]  - 指定模型创建会话',
      '  /bridge switch <序号|UUID>                - 切换会话',
      '  /bridge model                             - 查看可用模型和默认设置',
      '  /bridge model <序号|别名>                  - 设置默认模型',
      '  /bridge model --clear                     - 清除默认设置',
      '  /bridge resume <序号|UUID>                - 获取安全恢复建议',
      '  /bridge status                            - 查看状态',
      '  /bridge whoami                            - 获取你的 open_id',
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
    const result = await this.sessionManager.sendMessage(null, prompt, cwd, true, `new:${msg.openId}`);

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
      last_message_preview: preview(prompt),
      status: result.sessionStatus,
      jsonl_path: result.jsonlPath,
      pending_jsonl_resolve: !result.jsonlPath,
      last_error: result.error ?? null,
      feishu_user_id: msg.openId,
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

    const card = buildListCard(
      sessions as Array<[string, { title?: string; origin: string; message_count: number; last_active: string; status?: string; project_name?: string; cwd?: string }]>,
      allSessions.length,
      hasMore,
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
      // Fallback to text
      const lines = [`📋 我的会话（最近 ${sessions.length} 个，共 ${allSessions.length} 个）`, ''];
      for (const [index, [uuid, entry]] of sessions.entries()) {
        const providerTag = (entry as any).lastKnownProvider
          ? ` [${(entry as any).lastKnownProvider}]`
          : '';
        lines.push(`${index + 1}. ${entry.title ?? 'Untitled'}${providerTag}`);
        lines.push(`   ID: ${uuid.slice(0, 8)}`);
        lines.push(`   ${formatOrigin(entry.origin, entry.status)} | ${entry.message_count}条 | ${formatTimeAgo(entry.last_active)} | ${entry.project_name ?? basename(entry.cwd)}`);
        lines.push('');
      }
      if (hasMore) lines.push(`... 还有 ${allSessions.length - MAX_LIST_ITEMS} 个更早的会话未显示`);
      lines.push('━━━━━━━━━━━━━━━━');
      lines.push('💡 点击卡片上的按钮快速切换/恢复，或回复 "恢复 2" 获取恢复指引');
      await this.replyAndFinalize(msg!, lines.join('\n'));
    }
  }

  private async doCardNew(openId: string, messageId?: string): Promise<void> {
    const currentEntry = this.userManager.getEntry(openId);
    if (currentEntry?.type === 'pending_new_session_claimed') {
      await this.replyFn('当前已有新会话正在创建，请稍后再试。', { messageId, openId, requestUuid: uniqueUuid() });
      this.spoolQueue.recordReceipt(messageId ?? '');
      return;
    }

    const defaultCwd = config.get<string>('feishu_bot.default_cwd', '');
    const cwd = defaultCwd || process.env.HOME || '';
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
        type: 'pending_new_session',
        sessionUuid: null,
        createdAt: currentEntry?.createdAt ?? new Date().toISOString(),
        cwd,
      },
    );

    await this.replyFn(
      swapped ? '✅ 已设置新会话目录，请发送第一条消息来创建会话。' : '⚠️ 会话状态冲突，请稍后重试。',
      { messageId, openId, requestUuid: uniqueUuid() },
    );
    this.spoolQueue.recordReceipt(messageId ?? '');
  }

  private async doSwitch(openId: string, uuid: string, messageId?: string, msg?: SpoolMessage): Promise<string> {
    const session = this.registry.get(uuid);
    if (!session) {
      const reply = '未找到对应会话，请先执行 /bridge list。';
      if (msg) await this.replyAndFinalize(msg, reply);
      else await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
      return reply;
    }

    const currentEntry = this.userManager.getEntry(openId);
    const swapped = await this.userManager.compareAndSwap(
      openId,
      currentEntry ?? null,
      {
        type: 'session',
        sessionUuid: uuid,
        createdAt: currentEntry?.createdAt ?? new Date().toISOString(),
        cwd: session.cwd,
      },
    );

    const reply = swapped ? `✅ 已切换到会话 ${uuid.slice(0, 8)}` : '⚠️ 切换失败，会话可能已被修改';
    if (msg) await this.replyAndFinalize(msg, reply);
    else await this.replyFn(reply, { messageId, openId, requestUuid: uniqueUuid() });
    this.spoolQueue.recordReceipt(messageId ?? '');
    return reply;
  }

  private async doResume(openId: string, uuid: string, messageId?: string): Promise<string> {
    const entry = this.registry.get(uuid);
    if (!entry) return '未找到对应会话，请先执行 /bridge list。';
    if (entry.status === 'corrupted') return `会话 ${uuid.slice(0, 8)} 已损坏，不能直接恢复。`;
    if (entry.status === 'provisioning' || entry.status === 'degraded') {
      return `会话 ${uuid.slice(0, 8)} 状态为 ${entry.status}，建议先保持 cc-bridge 运行让系统自动修复。`;
    }
    return `在终端执行: cc-bridge resume ${uuid.slice(0, 8)}`;
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
      'cc-bridge 状态',
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
}

/** Build a session list card with switch/resume action buttons */
function buildListCard(sessions: Array<[string, { title?: string; origin: string; message_count: number; last_active: string; status?: string; project_name?: string; cwd?: string }]>, total: number, hasMore: boolean): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];

  if (sessions.length === 0) {
    elements.push({ tag: 'markdown', content: '当前没有可用会话。\n可使用 **✨ 新建会话** 创建新会话。' });
  } else {
    for (const [uuid, entry] of sessions) {
      const index = sessions.findIndex(s => s[0] === uuid) + 1;
      elements.push({
        tag: 'markdown',
        content: `**${index}. ${entry.title ?? 'Untitled'}**\nID: \`${uuid.slice(0, 8)}\` | ${entry.message_count}条 | ${formatTimeAgo(entry.last_active)} | ${formatOrigin(entry.origin, entry.status)} | ${entry.project_name ?? ''}\n📁 \`${entry.cwd ?? '-'}\``,
      });
      elements.push({
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '🔄 切换' }, type: 'primary', value: { tag: 'switch', sessionId: uuid } },
          { tag: 'button', text: { tag: 'plain_text', content: '📖 恢复' }, type: 'default', value: { tag: 'resume', sessionId: uuid } },
        ],
      });
      if (index < sessions.length) {
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

function preview(text: string, maxLength = 80): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function buildSessionTitle(text: string): string {
  return preview(text, 60) || 'Untitled';
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

function formatOrigin(origin: string, status?: string): string {
  if (status && status !== 'active') {
    return status;
  }
  return origin === 'feishu' ? '飞书' : '终端';
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

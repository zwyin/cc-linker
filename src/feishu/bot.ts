import { createHash } from 'crypto';
import { resolve } from 'path';
import { UserManager } from './mapping';
import { MappingEntry } from './mapping';
import { ListSnapshotManager, ListSnapshotEntry } from './list-snapshot';
import { SpoolQueue, SpoolMessage, TargetSnapshot, TargetSnapshotType } from '../queue/spool';
import { ClaudeSessionManager, SendMessageResult } from '../proxy/session';
import { sessionManager as defaultSessionManager } from '../proxy/session';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

export type FeishuMessageEvent = {
  open_id: string;
  message_id: string;
  content: string; // JSON string
  chat_type: 'p2p' | 'group';
  message_type: 'text';
};

export type FeishuReplyFn = (text: string, messageId?: string) => Promise<string | null>;

/** Generate stable UUID for outbound idempotency */
function stableUuid(messageId: string, chunkIndex = 0): string {
  return `msg-${createHash('sha256').update(`${messageId}:${chunkIndex}`).digest('hex').slice(0, 32)}`;
}

export class FeishuBot {
  private userManager: UserManager;
  private listSnapshotManager: ListSnapshotManager;
  private spoolQueue: SpoolQueue;
  private sessionManager: ClaudeSessionManager;
  private replyFn: FeishuReplyFn;
  private running = false;
  private stopRequested = false;

  constructor(opts: {
    userManager: UserManager;
    listSnapshotManager: ListSnapshotManager;
    spoolQueue: SpoolQueue;
    sessionManager?: ClaudeSessionManager;
    replyFn?: FeishuReplyFn;
  }) {
    this.userManager = opts.userManager;
    this.listSnapshotManager = opts.listSnapshotManager;
    this.spoolQueue = opts.spoolQueue;
    this.sessionManager = opts.sessionManager ?? defaultSessionManager;
    this.replyFn = opts.replyFn ?? (async () => null);
  }

  /**
   * Handle incoming Feishu message.
   * Called by WSClient callback.
   */
  async onMessage(event: FeishuMessageEvent): Promise<void> {
    // Private chat validation
    if (event.chat_type !== 'p2p') {
      logger.debug(`忽略非私聊消息: ${event.message_id} (chat_type=${event.chat_type})`);
      return;
    }

    // Owner validation
    if (!this.userManager.validateOwner(event.open_id)) {
      await this.replyFn('无权访问', event.message_id);
      return;
    }

    // Idempotency check
    if (this.spoolQueue.hasReceipt(event.message_id)) {
      logger.debug(`消息已处理，跳过: ${event.message_id}`);
      return;
    }

    // Parse content
    let text = '';
    try {
      const content = JSON.parse(event.content);
      text = content.text ?? '';
    } catch {
      text = event.content;
    }

    text = text.trim();
    if (!text) return;

    // Determine target snapshot
    const target = this.resolveTarget(event.open_id, text);

    // Build spool message
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
    if (enqueued) {
      logger.debug(`消息已入队: ${event.message_id}`);
    }
  }

  /**
   * Dispatcher: process spool queue.
   * Called periodically or on demand.
   */
  async dispatch(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const pending = this.spoolQueue.listPending();
      for (const msg of pending) {
        if (this.stopRequested) break;
        await this.processMessage(msg);
      }
    } finally {
      this.running = false;
    }
  }

  /** Signal dispatcher to stop after current message */
  requestStop(): void {
    this.stopRequested = true;
  }

  /** Check if dispatcher is running */
  isRunning(): boolean {
    return this.running;
  }

  private async processMessage(msg: SpoolMessage): Promise<void> {
    if (this.stopRequested) return;

    const claimed = this.spoolQueue.claimNext(msg.serialKey);
    if (!claimed) return; // already claimed by another worker

    try {
      if (claimed.text.startsWith('/bridge')) {
        await this.handleCommand(claimed);
      } else {
        await this.handleChat(claimed);
      }
    } catch (err: any) {
      this.spoolQueue.markFailed(claimed.messageId, claimed.serialKey, err.message);
      try {
        await this.replyFn(`处理失败: ${err.message}`, claimed.messageId);
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
        await this.replyTo(msg, this.helpText());
        break;

      case 'list':
        await this.handleList(msg);
        break;

      case 'new':
        await this.handleNew(msg, parts.slice(2).join(' '));
        break;

      case 'switch':
        await this.handleSwitch(msg, parts[2]);
        break;

      case 'resume':
        await this.handleResume(msg, parts.slice(2).join(' '));
        break;

      case 'status':
        await this.handleStatus(msg);
        break;

      default:
        await this.replyTo(msg, `未知命令: /bridge ${cmd}\n\n${this.helpText()}`);
        break;
    }
  }

  private async handleChat(msg: SpoolMessage): Promise<void> {
    // Check if mapping is pending_new_session_claimed
    const entry = this.userManager.getEntry(msg.openId);
    if (entry?.type === 'pending_new_session_claimed') {
      await this.replyTo(msg, '新会话正在创建中，请稍候...');
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      return;
    }

    // Check for no_target — no valid session to route to
    if (msg.target.type === 'no_target') {
      await this.replyTo(msg, '未找到可路由的会话。使用 /bridge new <路径> 创建新会话');
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      return;
    }

    // C4: Use HOME as default cwd for Feishu messages (not process.cwd())
    const cwd = process.env.HOME ?? '/';

    const targetUuid = msg.target.sessionUuid ?? null;
    const isNew = !targetUuid;

    const result = await this.sessionManager.sendMessage(targetUuid, msg.text, cwd, isNew);

    // Reply with response
    const replyId = await this.replyTo(msg, result.response || '(空回复)');

    // Update mapping for new sessions
    if (isNew && result.sessionId) {
      const currentEntry = this.userManager.getEntry(msg.openId);
      if (!currentEntry || currentEntry.type === 'pending_new_session') {
        await this.userManager.compareAndSwap(
          msg.openId,
          currentEntry ?? null,
          {
            type: 'session',
            sessionUuid: result.sessionId,
            createdAt: new Date().toISOString(),
          }
        );
      }

      // Update registry
      if (result.jsonlPath) {
        // Would update registry here in Round 5
      }
    }

    this.spoolQueue.markDone(msg.messageId, msg.serialKey, replyId ?? undefined);
  }

  private async handleList(msg: SpoolMessage): Promise<void> {
    const entry = this.userManager.getEntry(msg.openId);
    const sessionUuid = entry?.type === 'session' ? entry.sessionUuid : null;

    // For now, just show current session info
    // In full implementation, this would query Registry for all sessions
    let text = '当前会话:\n';
    if (sessionUuid) {
      text += `  UUID: ${sessionUuid.slice(0, 8)}...\n`;
    } else {
      text += '  无活跃会话\n';
    }

    // Create snapshot for /bridge switch
    const entries: ListSnapshotEntry[] = [];
    if (sessionUuid) {
      entries.push({ index: 1, uuid: sessionUuid, title: 'Current Session' });
    }
    this.listSnapshotManager.saveSnapshot(msg.openId, entries);
    text += '\n使用 /bridge switch <序号> 切换会话\n';
    text += '使用 /bridge new <路径> 创建新会话\n';

    await this.replyTo(msg, text);
  }

  private async handleNew(msg: SpoolMessage, cwd: string): Promise<void> {
    // Security: validate cwd against allowed/denied roots
    // Use resolve() + trailing separator to prevent prefix bypass attacks
    const allowedRoots = config.get<string[]>('security.allowed_roots', []);
    const deniedRoots = config.get<string[]>('security.denied_roots', []);

    const normalizedCwd = resolve(cwd);

    if (allowedRoots.length > 0) {
      const isAllowed = allowedRoots.some(r => {
        const normalizedRoot = resolve(r);
        return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(normalizedRoot + '/');
      });
      if (!isAllowed) {
        const confirmRisky = config.get<boolean>('security.confirm_risky_actions', true);
        if (confirmRisky) {
          await this.replyTo(msg, `⚠️ 目录 ${cwd} 不在允许列表中，需要管理员确认`);
        } else {
          await this.replyTo(msg, `❌ 目录 ${cwd} 不在允许列表中`);
          this.spoolQueue.markDone(msg.messageId, msg.serialKey);
          return;
        }
      }
    }

    for (const denied of deniedRoots) {
      const normalizedDenied = resolve(denied);
      if (normalizedCwd === normalizedDenied || normalizedCwd.startsWith(normalizedDenied + '/')) {
        await this.replyTo(msg, `❌ 目录 ${cwd} 被禁止使用`);
        this.spoolQueue.markDone(msg.messageId, msg.serialKey);
        return;
      }
    }

    // Set pending_new_session
    const currentEntry = this.userManager.getEntry(msg.openId);
    if (!currentEntry || currentEntry.type === 'session' || currentEntry.type === 'pending_new_session') {
      const swapped = await this.userManager.compareAndSwap(
        msg.openId,
        currentEntry ?? null,
        {
          type: 'pending_new_session',
          sessionUuid: null,
          createdAt: new Date().toISOString(),
        }
      );

      if (swapped) {
        await this.replyTo(msg, '✅ 已准备好创建新会话，请发送您的第一条消息');
      } else {
        await this.replyTo(msg, '⚠️ 会话状态冲突，请稍后重试');
      }
    } else {
      await this.replyTo(msg, '⚠️ 请先完成当前会话或切换到其他会话');
    }

    this.spoolQueue.markDone(msg.messageId, msg.serialKey);
  }

  private async handleSwitch(msg: SpoolMessage, target: string): Promise<void> {
    if (!target) {
      await this.replyTo(msg, '用法: /bridge switch <序号或UUID>');
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      return;
    }

    // Try to resolve index from snapshot
    const index = parseInt(target, 10);
    let uuid: string | null = null;
    if (!isNaN(index)) {
      uuid = this.listSnapshotManager.resolveIndex(index, msg.openId);
    } else {
      uuid = target;
    }

    if (!uuid) {
      await this.replyTo(msg, `未找到序号 ${target} 对应的会话，请先执行 /bridge list`);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      return;
    }

    // Update mapping
    const currentEntry = this.userManager.getEntry(msg.openId);
    const swapped = await this.userManager.compareAndSwap(
      msg.openId,
      currentEntry ?? null,
      {
        type: 'session',
        sessionUuid: uuid,
        createdAt: new Date().toISOString(),
      }
    );

    if (swapped) {
      await this.replyTo(msg, `✅ 已切换到会话 ${uuid.slice(0, 8)}`);
    } else {
      await this.replyTo(msg, '⚠️ 切换失败，会话可能已被修改');
    }

    this.spoolQueue.markDone(msg.messageId, msg.serialKey);
  }

  private async handleResume(msg: SpoolMessage, target: string): Promise<void> {
    if (!target) {
      await this.replyTo(msg, '用法: /bridge resume <UUID>');
      this.spoolQueue.markDone(msg.messageId, msg.serialKey);
      return;
    }

    // Update mapping to target session
    const currentEntry = this.userManager.getEntry(msg.openId);
    const swapped = await this.userManager.compareAndSwap(
      msg.openId,
      currentEntry ?? null,
      {
        type: 'session',
        sessionUuid: target,
        createdAt: new Date().toISOString(),
      }
    );

    if (swapped) {
      await this.replyTo(msg, `✅ 已恢复到会话 ${target.slice(0, 8)}\n\n在终端执行: cc-bridge resume ${target.slice(0, 8)}`);
    } else {
      await this.replyTo(msg, '⚠️ 恢复失败');
    }

    this.spoolQueue.markDone(msg.messageId, msg.serialKey);
  }

  private async handleStatus(msg: SpoolMessage): Promise<void> {
    const entry = this.userManager.getEntry(msg.openId);
    const queueSize = this.spoolQueue.queueSize();

    let text = 'cc-bridge 状态\n';
    text += '─'.repeat(30) + '\n';
    text += `队列消息: ${queueSize}\n`;
    text += `当前会话: ${entry?.type === 'session' ? entry.sessionUuid?.slice(0, 8) : '无'}\n`;
    text += `映射状态: ${entry?.type ?? 'none'}\n`;

    await this.replyTo(msg, text);
    this.spoolQueue.markDone(msg.messageId, msg.serialKey);
  }

  private helpText(): string {
    return [
      '可用命令:',
      '  /bridge help        - 显示此帮助',
      '  /bridge list         - 列出会话',
      '  /bridge new <路径>   - 创建新会话',
      '  /bridge switch <序号> - 切换会话',
      '  /bridge resume <UUID> - 恢复指定会话',
      '  /bridge status       - 查看状态',
    ].join('\n');
  }

  /** Resolve target snapshot for a message */
  private resolveTarget(openId: string, text: string): TargetSnapshot {
    const entry = this.userManager.getEntry(openId);

    if (!entry || entry.type === 'pending_new_session' || entry.type === 'pending_new_session_claimed') {
      return {
        type: entry?.type === 'pending_new_session_claimed' ? 'new_session_creating' : 'new_session_claim',
        openId,
      };
    }

    if (entry.type === 'session' && entry.sessionUuid) {
      return { type: 'session', sessionUuid: entry.sessionUuid, openId };
    }

    return { type: 'no_target', openId };
  }

  /** Send reply with chunking for long messages */
  private async replyTo(msg: SpoolMessage, text: string): Promise<string | null> {
    // Conservative chunk limit. Feishu API limit is 150KB; 2000 chars is a safe conservative default.
    const MAX_CHUNK = 2000;

    if (text.length <= MAX_CHUNK) {
      const uuid = stableUuid(msg.messageId);
      this.spoolQueue.recordDelivery(msg.messageId, 'sending', uuid);
      const replyId = await this.replyFn(text, msg.messageId);
      if (replyId) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', uuid);
      } else {
        // replyFn failed — delivery stays "sending" for reconciler to handle (Round 5)
      }
      return replyId;
    }

    // Chunk long messages
    let replyId: string | null = null;
    let chunkIndex = 0;
    while (text.length > 0) {
      const chunk = text.slice(0, MAX_CHUNK);
      text = text.slice(MAX_CHUNK);
      const uuid = stableUuid(msg.messageId, chunkIndex++);
      this.spoolQueue.recordDelivery(msg.messageId, 'sending', uuid);
      const id = await this.replyFn(chunk, msg.messageId);
      if (id && !replyId) replyId = id;
      if (id) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', uuid);
      }
    }
    return replyId;
  }
}

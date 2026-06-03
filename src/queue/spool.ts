import {
  readFileSync, writeFileSync, renameSync, existsSync, mkdirSync,
  readdirSync, statSync, unlinkSync
} from 'fs';
import { join } from 'path';
import {
  SPOOL_DIR, SPOOL_PENDING_DIR, SPOOL_PROCESSING_DIR,
  SPOOL_REPLIED_DIR, SPOOL_DONE_DIR, SPOOL_FAILED_DIR, SPOOL_RECEIPTS_DIR, SPOOL_DELIVERIES_DIR
} from '../utils/paths';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { withLock } from '../utils/lock';

// Message states
export type SpoolStatus = 'pending' | 'processing' | 'replied' | 'done' | 'failed';

// Target snapshot types
export type TargetSnapshotType = 'session' | 'new_session_claim' | 'new_session_creating' | 'no_target';

export interface TargetSnapshot {
  type: TargetSnapshotType;
  sessionUuid?: string;
  openId?: string;
  cwd?: string;
  claimMessageId?: string;
  claimedByMessageId?: string;
  mappingVersion?: number;
}

export interface SpoolMessage {
  messageId: string;
  openId: string;
  text: string;
  target: TargetSnapshot;
  serialKey: string;
  status: SpoolStatus;
  createdAt: string;
  updatedAt: string;
  replyMessageId?: string; // outbound Feishu message ID
  responseText?: string;
  retryCount?: number;
  nextAttemptAt?: string;
  error?: string;
  imagePaths?: string[];
  skipActivityCheck?: boolean;    // 强制发送标记
  awaitingForceSend?: boolean;    // 等待用户决策
  busySinceAt?: string;           // 等待开始时间 (Issue 2.1 orphan timeout)
}

export interface Receipt {
  messageId: string;
  receivedAt: string;
}

export interface Delivery {
  spoolMessageId: string;
  status: 'sending' | 'sent';
  requestUuid: string;
  updatedAt: string;
  chunkCount: number;
  chunks?: Array<{
    index: number;
    requestUuid: string;
    status: 'sending' | 'sent';
    feishuMessageId?: string;
  }>;
  createdAt: string;
}

const DEFAULT_MAX_QUEUE_SIZE = 100;

export class SpoolQueue {
  private pendingDir: string;
  private processingDir: string;
  private repliedDir: string;
  private doneDir: string;
  private failedDir: string;
  private receiptsDir: string;
  private deliveriesDir: string;

  constructor(baseDir?: string) {
    this.pendingDir = baseDir ? join(baseDir, 'pending') : SPOOL_PENDING_DIR;
    this.processingDir = baseDir ? join(baseDir, 'processing') : SPOOL_PROCESSING_DIR;
    this.repliedDir = baseDir ? join(baseDir, 'replied') : SPOOL_REPLIED_DIR;
    this.doneDir = baseDir ? join(baseDir, 'done') : SPOOL_DONE_DIR;
    this.failedDir = baseDir ? join(baseDir, 'failed') : SPOOL_FAILED_DIR;
    this.receiptsDir = baseDir ? join(baseDir, 'receipts') : SPOOL_RECEIPTS_DIR;
    this.deliveriesDir = baseDir ? join(baseDir, 'deliveries') : SPOOL_DELIVERIES_DIR;

    this.ensureDirs();
  }

  private ensureDirs(): void {
    for (const dir of [this.pendingDir, this.processingDir, this.repliedDir, this.doneDir, this.failedDir, this.receiptsDir, this.deliveriesDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /** Check if message was already received (inbound idempotency) */
  hasReceipt(messageId: string): boolean {
    return existsSync(join(this.receiptsDir, `${messageId}.json`));
  }

  /** Record inbound receipt */
  recordReceipt(messageId: string): void {
    const receipt: Receipt = { messageId, receivedAt: new Date().toISOString() };
    this.writeAtomic(join(this.receiptsDir, `${messageId}.json`), receipt);
  }

  /** Check outbound delivery status */
  getDelivery(spoolMessageId: string): Delivery | null {
    const path = join(this.deliveriesDir, `${spoolMessageId}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Delivery;
    } catch {
      return null;
    }
  }

  /** Record outbound delivery (idempotent) */
  recordDelivery(
    spoolMessageId: string,
    status: 'sending' | 'sent',
    requestUuid: string,
    chunkIndex = 0,
    feishuMessageId?: string,
    totalChunks?: number,
  ): void {
    const path = join(this.deliveriesDir, `${spoolMessageId}.json`);
    const existing = this.getDelivery(spoolMessageId);
    const chunks = existing?.chunks ? [...existing.chunks] : [];
    const currentChunk = chunks.find(chunk => chunk.index === chunkIndex);

    if (currentChunk) {
      currentChunk.status = status;
      currentChunk.requestUuid = requestUuid;
      currentChunk.feishuMessageId = feishuMessageId ?? currentChunk.feishuMessageId;
    } else {
      chunks.push({
        index: chunkIndex,
        requestUuid,
        status,
        feishuMessageId,
      });
    }

    const chunkCount = totalChunks ?? existing?.chunkCount ?? Math.max(chunkIndex + 1, chunks.length);
    const allChunksSent =
      chunkCount > 0 &&
      chunks.length >= chunkCount &&
      chunks.filter(chunk => chunk.status === 'sent').length >= chunkCount;

    const delivery: Delivery = {
      spoolMessageId,
      status: allChunksSent ? 'sent' : 'sending',
      requestUuid: existing?.requestUuid ?? requestUuid,
      updatedAt: new Date().toISOString(),
      chunkCount,
      chunks,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.writeAtomic(path, delivery);
  }

  hasSentDelivery(spoolMessageId: string): boolean {
    return this.getDelivery(spoolMessageId)?.status === 'sent';
  }

  /**
   * Enqueue a message atomically.
   * Returns false if queue is full or already received.
   */
  enqueue(msg: SpoolMessage): boolean {
    // I1: Atomic receipt write with exclusive flag to prevent race
    const receiptPath = join(this.receiptsDir, `${msg.messageId}.json`);
    const receipt: Receipt = { messageId: msg.messageId, receivedAt: new Date().toISOString() };

    // Try to claim the receipt atomically via exclusive write
    try {
      writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
    } catch {
      // File already exists — another request won the CAS
      logger.debug(`消息已接收（CAS 失败），跳过: ${msg.messageId}`);
      return false;
    }

    // Queue size check (after claiming receipt to avoid TOCTOU)
    const pendingCount = readdirSync(this.pendingDir).length;
    const processingCount = readdirSync(this.processingDir).length;
    const maxSize = config.get<number>('queue.max_pending', DEFAULT_MAX_QUEUE_SIZE);
    if (pendingCount + processingCount >= maxSize) {
      logger.warn(`队列已满 (${pendingCount + processingCount}/${maxSize})，拒绝: ${msg.messageId}`);
      // Revert receipt
      try { unlinkSync(receiptPath); } catch {}
      return false;
    }

    // 新消息到达：取代同 serialKey 的旧 awaitingForceSend 消息
    // 用户的"等待决策"被新消息自动取代（用户用行动表示要继续对话）
    const processingFiles = readdirSync(this.processingDir).filter(f => f.startsWith(`${msg.serialKey}:`));
    for (const file of processingFiles) {
      const oldMsg = this.readSpoolMessage(join(this.processingDir, file));
      if (oldMsg?.awaitingForceSend) {
        logger.info(`新消息到达，旧 awaitingForceSend 消息被取代: ${oldMsg.messageId}`);
        this.markDone(oldMsg.messageId, oldMsg.serialKey);
      }
    }

    msg.status = 'pending';
    msg.createdAt = msg.createdAt || new Date().toISOString();
    msg.updatedAt = msg.updatedAt || msg.createdAt;

    const path = join(this.pendingDir, `${msg.serialKey}:${msg.messageId}.json`);
    this.writeAtomic(path, msg);

    logger.debug(`消息入队: ${msg.messageId} (key=${msg.serialKey}, target=${msg.target.type})`);
    return true;
  }

  /** Get next pending message for a serial key */
  claimNext(serialKey: string): SpoolMessage | null {
    const active = readdirSync(this.processingDir).some(f => f.startsWith(`${serialKey}:`));
    if (active) {
      return null;
    }

    const now = Date.now();
    const match = readdirSync(this.pendingDir)
      .filter(f => f.startsWith(`${serialKey}:`))
      .map(file => ({
        file,
        msg: this.readSpoolMessage(join(this.pendingDir, file)),
      }))
      .filter((entry): entry is { file: string; msg: SpoolMessage } => entry.msg !== null)
      .filter(entry => !entry.msg.nextAttemptAt || new Date(entry.msg.nextAttemptAt).getTime() <= now)
      .sort((a, b) => a.msg.createdAt.localeCompare(b.msg.createdAt))[0]?.file;
    if (!match) return null;

    const srcPath = join(this.pendingDir, match);
    const destPath = join(this.processingDir, match);

    try {
      renameSync(srcPath, destPath);
    } catch {
      // Another worker already claimed it
      return null;
    }

    const msg = this.readSpoolMessage(destPath);
    if (msg) {
      msg.status = 'processing';
      msg.updatedAt = new Date().toISOString();
      this.writeAtomic(destPath, msg);
    } else {
      // C1: If read fails, move back to pending to prevent stuck message
      logger.warn(`claimNext 读取失败，将消息移回 pending: ${destPath}`);
      try {
        renameSync(destPath, srcPath);
      } catch {
        // If move-back fails, mark as failed with a proper filename
        const failedName = `${serialKey}:unknown:error.json`;
        this.writeAtomic(join(this.failedDir, failedName), {
          messageId: 'unknown',
          openId: 'unknown',
          text: '',
          target: { type: 'no_target' },
          serialKey: serialKey,
          status: 'failed',
          error: 'read_spool_message_failed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return msg;
  }

  /** Mark message as done (move to done dir) */
  markDone(messageId: string, serialKey: string, replyMessageId?: string): void {
    this.moveMessage(messageId, serialKey, [this.repliedDir, this.processingDir], this.doneDir, 'done', replyMessageId);
  }

  /** Mark message as failed (move to failed dir) */
  markFailed(messageId: string, serialKey: string, error: string): void {
    this.moveMessage(messageId, serialKey, [this.processingDir], this.failedDir, 'failed', undefined, { error });
  }

  markReplied(messageId: string, serialKey: string, replyMessageId?: string): void {
    this.moveMessage(messageId, serialKey, [this.processingDir], this.repliedDir, 'replied', replyMessageId);
  }

  /**
   * Move a message from processing/ back to pending/ so the next dispatch cycle
   * can re-claim it. Used for force-send: after the user clicks "强制发送" on
   * a busy card, the message (which is still in processing/ with
   * awaitingForceSend=true) is moved back so the worker picks it up again
   * and skips the activity check (skipActivityCheck=true).
   */
  requeueFromProcessing(messageId: string, serialKey: string): SpoolMessage | null {
    return this.moveMessage(messageId, serialKey, [this.processingDir], this.pendingDir, 'pending');
  }

  updateProcessingMessage(messageId: string, serialKey: string, patch: Partial<SpoolMessage>): SpoolMessage | null {
    const path = join(this.processingDir, `${serialKey}:${messageId}.json`);
    if (!existsSync(path)) return null;

    const msg = this.readSpoolMessage(path);
    if (!msg) return null;

    Object.assign(msg, patch, {
      updatedAt: new Date().toISOString(),
    });
    this.writeAtomic(path, msg);
    return msg;
  }

  async updateMessageFlags(
    messageId: string,
    serialKey: string,
    flags: { skipActivityCheck?: boolean; awaitingForceSend?: boolean }
  ): Promise<boolean> {
    return withLock(this.processingDir, async () => {
      const path = join(this.processingDir, `${serialKey}:${messageId}.json`);
      if (!existsSync(path)) return false;
      try {
        const raw = readFileSync(path, 'utf8');
        const msg = JSON.parse(raw) as SpoolMessage;
        if (flags.skipActivityCheck !== undefined) msg.skipActivityCheck = flags.skipActivityCheck;
        if (flags.awaitingForceSend !== undefined) msg.awaitingForceSend = flags.awaitingForceSend;
        writeFileSync(path, JSON.stringify(msg, null, 2), { mode: 0o600 });
        return true;
      } catch (err) {
        logger.warn(`更新 SpoolMessage 标志失败: ${err}`);
        return false;
      }
    });
  }

  requeueForRetry(messageId: string, serialKey: string, error: string, delayMs: number): SpoolMessage | null {
    const moved = this.moveMessage(messageId, serialKey, [this.processingDir], this.pendingDir, 'pending');
    if (!moved) return null;

    moved.retryCount = (moved.retryCount ?? 0) + 1;
    moved.error = error;
    moved.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    moved.updatedAt = new Date().toISOString();
    this.writeAtomic(join(this.pendingDir, `${serialKey}:${messageId}.json`), moved);
    return moved;
  }

  /** List all pending messages */
  listPending(): SpoolMessage[] {
    return this.listFromDir(this.pendingDir);
  }

  /** List all processing messages */
  listProcessing(): SpoolMessage[] {
    return this.listFromDir(this.processingDir);
  }

  listReplied(): SpoolMessage[] {
    return this.listFromDir(this.repliedDir);
  }

  /** Get total queue size */
  queueSize(): number {
    return readdirSync(this.pendingDir).length + readdirSync(this.processingDir).length;
  }

  /** Get all spool directory paths (for reconciler cleanup) */
  getSpoolDirs(): string[] {
    return [this.pendingDir, this.processingDir, this.repliedDir, this.doneDir, this.failedDir, this.receiptsDir, this.deliveriesDir];
  }

  /** Archive cleanup: done 24h, failed 7d, receipts/deliveries TTL */
  cleanup(): { cleaned: number; failed: number; receipts: number; deliveries: number } {
    let cleaned = 0;
    let failed = 0;
    let receiptCleaned = 0;
    let deliveryCleaned = 0;

    const doneAfterHours = config.get<number>('queue.done_retention_hours', 24);
    const doneMaxCount = config.get<number>('queue.done_max_files', 1000);
    const failedAfterDays = config.get<number>('queue.failed_retention_days', 7);
    const failedMaxCount = config.get<number>('queue.failed_max_files', 200);
    const receiptTtlHours = config.get<number>('queue.receipt_retention_days', 7) * 24;
    const deliveryTtlDays = config.get<number>('queue.delivery_retention_days', 7);

    // Cleanup done: first by age, then by count if still over limit
    const doneFiles = readdirSync(this.doneDir).sort();
    const doneCutoff = Date.now() - doneAfterHours * 60 * 60 * 1000;
    for (const file of doneFiles) {
      const path = join(this.doneDir, file);
      const stat = statSync(path);
      if (stat.mtimeMs < doneCutoff) {
        unlinkSync(path);
        cleaned++;
      }
    }
    // If still over count limit, delete oldest regardless of age
    const remainingDone = readdirSync(this.doneDir).sort();
    if (remainingDone.length > doneMaxCount) {
      for (const file of remainingDone.slice(0, remainingDone.length - doneMaxCount)) {
        unlinkSync(join(this.doneDir, file));
        cleaned++;
      }
    }

    // Cleanup failed: first by age, then by count
    const failedFiles = readdirSync(this.failedDir).sort();
    const failedCutoff = Date.now() - failedAfterDays * 24 * 60 * 60 * 1000;
    for (const file of failedFiles) {
      const path = join(this.failedDir, file);
      const stat = statSync(path);
      if (stat.mtimeMs < failedCutoff) {
        unlinkSync(path);
        failed++;
      }
    }
    const remainingFailed = readdirSync(this.failedDir).sort();
    if (remainingFailed.length > failedMaxCount) {
      for (const file of remainingFailed.slice(0, remainingFailed.length - failedMaxCount)) {
        unlinkSync(join(this.failedDir, file));
        failed++;
      }
    }

    // Cleanup receipts (TTL + count limit for safety)
    const receiptCutoff = Date.now() - receiptTtlHours * 60 * 60 * 1000;
    const receiptMaxCount = 1000;
    const receiptFiles = readdirSync(this.receiptsDir).sort();
    for (const file of receiptFiles) {
      const path = join(this.receiptsDir, file);
      const stat = statSync(path);
      if (stat.mtimeMs < receiptCutoff) {
        unlinkSync(path);
        receiptCleaned++;
      }
    }
    // If still over count limit, delete oldest regardless of age
    const remainingReceipts = readdirSync(this.receiptsDir).sort();
    if (remainingReceipts.length > receiptMaxCount) {
      for (const file of remainingReceipts.slice(0, remainingReceipts.length - receiptMaxCount)) {
        unlinkSync(join(this.receiptsDir, file));
        receiptCleaned++;
      }
    }

    // Cleanup deliveries
    const deliveryCutoff = Date.now() - deliveryTtlDays * 24 * 60 * 60 * 1000;
    for (const file of readdirSync(this.deliveriesDir)) {
      const path = join(this.deliveriesDir, file);
      const stat = statSync(path);
      if (stat.mtimeMs < deliveryCutoff) {
        unlinkSync(path);
        deliveryCleaned++;
      }
    }

    if (cleaned > 0 || failed > 0 || receiptCleaned > 0 || deliveryCleaned > 0) {
      logger.info(`Spool 清理: ${cleaned} done, ${failed} failed, ${receiptCleaned} receipts, ${deliveryCleaned} deliveries`);
    }

    return { cleaned, failed, receipts: receiptCleaned, deliveries: deliveryCleaned };
  }

  /** Recover processing → pending on startup */
  recoverProcessing(): number {
    const files = readdirSync(this.processingDir);
    let recovered = 0;

    for (const file of files) {
      const srcPath = join(this.processingDir, file);
      const msg = this.readSpoolMessage(srcPath);
      if (!msg) continue;

      msg.status = 'pending';
      msg.updatedAt = new Date().toISOString();

      const destPath = join(this.pendingDir, file);
      try {
        // Write updated status first, then rename — ensures crash-safety:
        // if crash after rename, the file in pending/ already has status=pending.
        this.writeAtomic(srcPath, msg);
        renameSync(srcPath, destPath);
      } catch (err) {
        logger.warn(`recoverProcessing 失败: ${srcPath}: ${err}`);
        continue;
      }
      recovered++;
    }

    if (recovered > 0) {
      logger.info(`恢复 ${recovered} 条 processing → pending 消息`);
    }
    return recovered;
  }

  finalizeDeliveredMessages(): number {
    let finalized = 0;
    for (const dir of [this.processingDir, this.repliedDir]) {
      for (const file of readdirSync(dir)) {
        const msg = this.readSpoolMessage(join(dir, file));
        if (!msg) continue;
        if (!this.hasSentDelivery(msg.messageId)) continue;

        const updated = this.moveMessage(msg.messageId, msg.serialKey, [dir], this.doneDir, 'done', msg.replyMessageId);
        if (updated) {
          finalized++;
        }
      }
    }

    if (finalized > 0) {
      logger.info(`完成 ${finalized} 条已发送消息的 finalize`);
    }
    return finalized;
  }

  // Private helpers

  private listFromDir(dir: string): SpoolMessage[] {
    const files = readdirSync(dir);
    const messages: SpoolMessage[] = [];
    for (const file of files) {
      const msg = this.readSpoolMessage(join(dir, file));
      if (msg) messages.push(msg);
    }
    return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private readSpoolMessage(path: string): SpoolMessage | null {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as SpoolMessage;
    } catch {
      logger.warn(`读取 spool 消息失败: ${path}`);
      return null;
    }
  }

  private writeAtomic(path: string, data: unknown): void {
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }

  private moveMessage(
    messageId: string,
    serialKey: string,
    sourceDirs: string[],
    targetDir: string,
    status: SpoolStatus,
    replyMessageId?: string,
    extraPatch?: Record<string, unknown>,
  ): SpoolMessage | null {
    const expectedName = `${serialKey}:${messageId}.json`;

    for (const sourceDir of sourceDirs) {
      const srcPath = join(sourceDir, expectedName);
      if (!existsSync(srcPath)) continue;

      const msg = this.readSpoolMessage(srcPath);
      if (!msg) return null;

      msg.status = status;
      msg.replyMessageId = replyMessageId ?? msg.replyMessageId;
      msg.updatedAt = new Date().toISOString();
      if (extraPatch) Object.assign(msg, extraPatch);

      const destPath = join(targetDir, expectedName);
      try {
        // Write updated status to source first, then rename — crash-safe:
        // if crash after rename, the file in target/ already has correct status.
        this.writeAtomic(srcPath, msg);
        renameSync(srcPath, destPath);
      } catch {
        return null;
      }
      return msg;
    }

    return null;
  }
}

export const spoolQueue = new SpoolQueue();

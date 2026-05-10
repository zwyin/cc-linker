import {
  readFileSync, writeFileSync, renameSync, existsSync, mkdirSync,
  readdirSync, statSync, unlinkSync, rmSync
} from 'fs';
import { join } from 'path';
import {
  SPOOL_DIR, SPOOL_PENDING_DIR, SPOOL_PROCESSING_DIR,
  SPOOL_DONE_DIR, SPOOL_FAILED_DIR, SPOOL_RECEIPTS_DIR, SPOOL_DELIVERIES_DIR
} from '../utils/paths';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { MappingEntry } from '../feishu/mapping';

// Message states
export type SpoolStatus = 'pending' | 'processing' | 'done' | 'failed';

// Target snapshot types
export type TargetSnapshotType = 'session' | 'new_session_claim' | 'new_session_creating' | 'no_target';

export interface TargetSnapshot {
  type: TargetSnapshotType;
  sessionUuid?: string;
  openId?: string;
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
  error?: string;
}

export interface Receipt {
  messageId: string;
  receivedAt: string;
}

export interface Delivery {
  spoolMessageId: string;
  status: 'sending' | 'sent';
  requestUuid: string;
  createdAt: string;
}

const MAX_QUEUE_SIZE = 100;

export class SpoolQueue {
  private pendingDir: string;
  private processingDir: string;
  private doneDir: string;
  private failedDir: string;
  private receiptsDir: string;
  private deliveriesDir: string;

  constructor(baseDir?: string) {
    this.pendingDir = baseDir ? join(baseDir, 'pending') : SPOOL_PENDING_DIR;
    this.processingDir = baseDir ? join(baseDir, 'processing') : SPOOL_PROCESSING_DIR;
    this.doneDir = baseDir ? join(baseDir, 'done') : SPOOL_DONE_DIR;
    this.failedDir = baseDir ? join(baseDir, 'failed') : SPOOL_FAILED_DIR;
    this.receiptsDir = baseDir ? join(baseDir, 'receipts') : SPOOL_RECEIPTS_DIR;
    this.deliveriesDir = baseDir ? join(baseDir, 'deliveries') : SPOOL_DELIVERIES_DIR;

    this.ensureDirs();
  }

  private ensureDirs(): void {
    for (const dir of [this.pendingDir, this.processingDir, this.doneDir, this.failedDir, this.receiptsDir, this.deliveriesDir]) {
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
  recordDelivery(spoolMessageId: string, status: 'sending' | 'sent', requestUuid: string): void {
    const path = join(this.deliveriesDir, `${spoolMessageId}.json`);
    const existing = this.getDelivery(spoolMessageId);
    const delivery: Delivery = {
      spoolMessageId,
      status,
      requestUuid,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.writeAtomic(path, delivery);
  }

  /**
   * Enqueue a message atomically.
   * Returns false if queue is full or already received.
   */
  enqueue(msg: SpoolMessage): boolean {
    // Idempotency check
    if (this.hasReceipt(msg.messageId)) {
      logger.debug(`消息已接收，跳过: ${msg.messageId}`);
      return false;
    }

    // Queue size check
    const pendingCount = readdirSync(this.pendingDir).length;
    const processingCount = readdirSync(this.processingDir).length;
    const maxSize = config.get<number>('queue.max_queue_size', MAX_QUEUE_SIZE);
    if (pendingCount + processingCount >= maxSize) {
      logger.warn(`队列已满 (${pendingCount + processingCount}/${maxSize})，拒绝: ${msg.messageId}`);
      return false;
    }

    msg.status = 'pending';
    msg.createdAt = msg.createdAt || new Date().toISOString();
    msg.updatedAt = msg.updatedAt || msg.createdAt;

    const path = join(this.pendingDir, `${msg.serialKey}:${msg.messageId}.json`);
    this.writeAtomic(path, msg);
    this.recordReceipt(msg.messageId);

    logger.debug(`消息入队: ${msg.messageId} (key=${msg.serialKey}, target=${msg.target.type})`);
    return true;
  }

  /** Get next pending message for a serial key */
  claimNext(serialKey: string): SpoolMessage | null {
    const files = readdirSync(this.pendingDir);
    const match = files.find(f => f.startsWith(`${serialKey}:`));
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
    }
    return msg;
  }

  /** Mark message as done (move to done dir) */
  markDone(messageId: string, serialKey: string, replyMessageId?: string): void {
    const files = readdirSync(this.processingDir);
    const match = files.find(f => f.includes(messageId));
    if (!match) return;

    const srcPath = join(this.processingDir, match);
    const msg = this.readSpoolMessage(srcPath);
    if (!msg) return;

    msg.status = 'done';
    msg.replyMessageId = replyMessageId;
    msg.updatedAt = new Date().toISOString();

    const destPath = join(this.doneDir, match);
    try {
      renameSync(srcPath, destPath);
    } catch {
      return; // already moved by another worker
    }
    this.writeAtomic(destPath, msg);
  }

  /** Mark message as failed (move to failed dir) */
  markFailed(messageId: string, error: string): void {
    const files = readdirSync(this.processingDir);
    const match = files.find(f => f.includes(messageId));
    if (!match) return;

    const srcPath = join(this.processingDir, match);
    const msg = this.readSpoolMessage(srcPath);
    if (!msg) return;

    msg.status = 'failed';
    msg.error = error;
    msg.updatedAt = new Date().toISOString();

    const destPath = join(this.failedDir, match);
    try {
      renameSync(srcPath, destPath);
    } catch {
      return; // already moved by another worker
    }
    this.writeAtomic(destPath, msg);
  }

  /** List all pending messages */
  listPending(): SpoolMessage[] {
    return this.listFromDir(this.pendingDir);
  }

  /** List all processing messages */
  listProcessing(): SpoolMessage[] {
    return this.listFromDir(this.processingDir);
  }

  /** Get total queue size */
  queueSize(): number {
    return readdirSync(this.pendingDir).length + readdirSync(this.processingDir).length;
  }

  /** Archive cleanup: done 24h, failed 7d, receipts/deliveries TTL */
  cleanup(): { cleaned: number; failed: number; receipts: number; deliveries: number } {
    let cleaned = 0;
    let failed = 0;
    let receiptCleaned = 0;
    let deliveryCleaned = 0;

    const doneAfterHours = config.get<number>('queue.archive_done_after_hours', 24);
    const doneMaxCount = 1000;
    const failedAfterDays = config.get<number>('queue.archive_failed_after_days', 7);
    const failedMaxCount = 200;
    const receiptTtlHours = 24;
    const deliveryTtlDays = 7;

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

    // Cleanup receipts
    const receiptCutoff = Date.now() - receiptTtlHours * 60 * 60 * 1000;
    for (const file of readdirSync(this.receiptsDir)) {
      const path = join(this.receiptsDir, file);
      const stat = statSync(path);
      if (stat.mtimeMs < receiptCutoff) {
        unlinkSync(path);
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
      renameSync(srcPath, destPath);
      this.writeAtomic(destPath, msg);
      recovered++;
    }

    if (recovered > 0) {
      logger.info(`恢复 ${recovered} 条 processing → pending 消息`);
    }
    return recovered;
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
}

export const spoolQueue = new SpoolQueue();

import lockfile from 'proper-lockfile';
import { existsSync, writeFileSync } from 'fs';
import { CCBridgeError } from './errors';

// ===== 进程内读写锁 =====
// 多读单写：无活跃写时可并发读；写操作独占。
// 仅用于进程内调度，跨进程写同步由 proper-lockfile 负责。

class RWLock {
  private activeReads = 0;
  private activeWrite = false;
  private queue: Array<{
    type: 'read' | 'write';
    resolve: (v: () => void) => void;
  }> = [];

  /** 获取读锁：可并发，但若写队列非空则排队，防止写饥饿 */
  acquireRead(): Promise<() => void> {
    if (!this.activeWrite && this.queue.length === 0) {
      this.activeReads++;
      return Promise.resolve(() => this.releaseRead());
    }
    return new Promise((resolve) => {
      this.queue.push({ type: 'read', resolve: resolve as any });
    });
  }

  /** 获取写锁：等待所有读完成后再执行，同时只允许一个写 */
  acquireWrite(): Promise<() => void> {
    if (!this.activeWrite && this.activeReads === 0 && this.queue.length === 0) {
      this.activeWrite = true;
      return Promise.resolve(() => this.releaseWrite());
    }
    return new Promise((resolve) => {
      this.queue.push({ type: 'write', resolve: resolve as any });
    });
  }

  private releaseRead(): void {
    this.activeReads--;
    if (this.activeReads === 0) this.processNext();
  }

  private releaseWrite(): void {
    this.activeWrite = false;
    this.processNext();
  }

  private processNext(): void {
    if (this.queue.length === 0) return;

    // 优先处理所有排队中的写操作（写饥饿防护）
    const pendingWrites = this.queue.filter((q) => q.type === 'write');
    if (pendingWrites.length > 0) {
      const item = this.queue.find((q) => q.type === 'write')!;
      this.queue = this.queue.filter((q) => q !== item);
      this.activeWrite = true;
      item.resolve(() => this.releaseWrite());
      return;
    }

    // 无等待写时，批量放行所有排队中的读
    const pendingReads = this.queue.filter((q) => q.type === 'read');
    this.queue = this.queue.filter((q) => q.type === 'write');
    for (const item of pendingReads) {
      this.activeReads++;
      item.resolve(() => this.releaseRead());
    }
  }
}

const rwLock = new RWLock();

interface LockOptions {
  retries?: number;
  minTimeout?: number;
}

/** 写锁：进程内排队 + 跨进程 proper-lockfile */
export async function withLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const { retries = 3, minTimeout = 100 } = options;

  // 确保锁文件存在
  if (!existsSync(filePath)) {
    writeFileSync(filePath, '', { mode: 0o600 });
  }

  // 获取进程内写锁
  const releaseInner = await rwLock.acquireWrite();

  // 手动重试循环：线性退避（100ms, 200ms, 300ms），5 秒超时
  const MAX_WAIT = 5000;
  let elapsed = 0;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const release = await lockfile.lock(filePath, {
        retries: 0, // 禁用内部重试，由我们手动控制
        lockfilePath: filePath + '.lock',
      });

      try {
        return await fn();
      } finally {
        await release();
        releaseInner();
      }
    } catch (err: any) {
      if (err.code !== 'ELOCKED') {
        releaseInner();
        throw err;
      }
      elapsed += minTimeout * (attempt + 1);
      if (elapsed >= MAX_WAIT) {
        releaseInner();
        throw new CCBridgeError('E007', '注册表被锁，等待超时');
      }
      await sleep(minTimeout * (attempt + 1));
    }
  }
  releaseInner();
  throw new CCBridgeError('E007', '注册表被锁，等待超时');
}

/** 读锁：仅进程内排队，不加跨进程锁 */
export async function withReadLock<T>(
  fn: () => Promise<T>
): Promise<T> {
  const releaseRead = await rwLock.acquireRead();
  try {
    return await fn();
  } finally {
    releaseRead();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

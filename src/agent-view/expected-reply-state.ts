import { readFile } from 'fs/promises';
import type { UserManager, MappingEntry } from '../feishu/mapping';

export interface ExpectedReplyInfo {
  shortId: string;
  sessionId: string;   // = MappingEntry.sessionUuid
  cwd: string;
  // startedAt / timeoutMs 由 state 内部管理
}

interface InternalEntry {
  shortId: string;
  sessionId: string;
  cwd: string;
  startedAt: number;   // epoch ms
  timeoutMs: number;
  casToken: string;
}

export class ExpectedReplyState {
  private inMemory = new Map<string, InternalEntry>();
  private timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private userManager: UserManager,
    private defaultTimeoutMs: number = 300_000  // 5 分钟
  ) {}

  /**
   * 设置 expectedReply 状态。CAS 写入 user-mapping(同 openId 旧 entry 被覆盖)。
   * 失败抛错(让调用方决定降级)。
   */
  async set(openId: string, info: ExpectedReplyInfo): Promise<void> {
    const now = Date.now();
    const casToken = `${now}-${Math.random().toString(36).slice(2, 10)}`;
    const newEntry: MappingEntry = {
      type: 'pending_agent_reply',
      sessionUuid: info.sessionId,
      cwd: info.cwd,
      createdAt: new Date(now).toISOString(),
      startedAt: new Date(now).toISOString(),
      timeoutMs: this.defaultTimeoutMs,
      shortId: info.shortId,
      casToken,
    };
    // CAS: expected = null(覆盖任何旧 type)
    const ok = await this.userManager.compareAndSwap(openId, null, newEntry);
    if (!ok) {
      throw new Error(`Failed to set expectedReply for ${openId}: CAS failed`);
    }
    // in-memory
    const internal: InternalEntry = {
      shortId: info.shortId,
      sessionId: info.sessionId,
      cwd: info.cwd,
      startedAt: now,
      timeoutMs: this.defaultTimeoutMs,
      casToken,
    };
    this.inMemory.set(openId, internal);
    this.scheduleTimeout(openId);
  }

  /**
   * 清除 expectedReply 状态(从 user-mapping 和 in-memory 都删)。
   * reason: 'user' / 'timeout' / 'overwrite'
   */
  async clear(openId: string, _reason?: 'user' | 'timeout' | 'overwrite'): Promise<void> {
    const current = this.userManager.getEntry(openId);
    if (current?.type !== 'pending_agent_reply') return;  // 已经不在了
    const ok = await this.userManager.compareAndSwap(openId, current, null);
    if (ok) {
      this.inMemory.delete(openId);
      this.clearTimer(openId);
    }
  }

  get(openId: string): ExpectedReplyInfo | undefined {
    const e = this.inMemory.get(openId);
    if (!e) return undefined;
    return { shortId: e.shortId, sessionId: e.sessionId, cwd: e.cwd };
  }

  private scheduleTimeout(openId: string): void {
    this.clearTimer(openId);
    const e = this.inMemory.get(openId);
    if (!e) return;
    const remain = e.timeoutMs - (Date.now() - e.startedAt);
    if (remain <= 0) {
      // 已超时,立即清除
      void this.clear(openId, 'timeout');
      return;
    }
    const timer = setTimeout(() => {
      void this.clear(openId, 'timeout');
    }, remain);
    this.timeoutTimers.set(openId, timer);
  }

  private clearTimer(openId: string): void {
    const t = this.timeoutTimers.get(openId);
    if (t) {
      clearTimeout(t);
      this.timeoutTimers.delete(openId);
    }
  }

  /**
   * Bot 启动恢复(R8):
   * 遍历 user-mapping,对 `pending_agent_reply` 类型:
   * - 已超时:静默删除
   * - 未超时:in-memory 重建 + setTimeout 剩余时间
   */
  async restoreExpectedReplyStates(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(
        // @ts-ignore — 访问 private 字段仅用于 R8 启动恢复
        (this.userManager as any).mappingPath,
        'utf8'
      );
    } catch {
      return;
    }
    const parsed = JSON.parse(raw);
    const entries = parsed.entries || {};
    for (const [openId, entry] of Object.entries(entries)) {
      const e = entry as any;
      if (e.type !== 'pending_agent_reply') continue;
      const startedAt = new Date(e.startedAt).getTime();
      const elapsed = Date.now() - startedAt;
      if (elapsed >= e.timeoutMs) {
        // 已超时,静默删除
        await this.userManager.compareAndSwap(openId, e, null);
      } else {
        // 未超时,重建
        const internal: InternalEntry = {
          shortId: e.shortId,
          sessionId: e.sessionUuid,
          cwd: e.cwd || '',
          startedAt,
          timeoutMs: e.timeoutMs,
          casToken: e.casToken || '',
        };
        this.inMemory.set(openId, internal);
        this.scheduleTimeout(openId);
      }
    }
  }
}

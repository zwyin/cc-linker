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
   * 设置 expectedReply 状态。CAS 写入 user-mapping。
   *
   * v2.3.3 智能 CAS:user-mapping 当前 entry 可能是:
   *   - null → 直接写
   *   - `last_agent_list_card`(上一次 /agents 留下的 list 卡 pointer) → 自动清
   *   - `pending_agent_reply`(上一个 reply 没走完 cleanup) → 自动清
   *   - `session`,sessionUuid 跟 info.sessionId 匹配(用户已 attach 此 session,
   *     现在想"detach + 切到等用户回复"模式) → 自动清 + set
   *   - 其他 active state(不同 session 的 session / pending_new_session /
   *     pending_new_session_claimed)→ 真"另一端在操作",throw
   *
   * v2.3.3 修这个之前,用户 attach 后再点 /agents 的 Reply 永远 throw(因为
   * user-mapping 残留 session entry 但 handleReplyRequest 只清 last_agent_list_card)。
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
    // 智能 CAS:探测当前 entry
    const current = this.userManager.getEntry(openId);
    if (current) {
      const isTransient = (current.type === 'last_agent_list_card'
        || current.type === 'pending_agent_reply');
      // session entry 只有在 sessionUuid 跟目标 session 匹配时才"自切"(用户已
      // attach 同一 session,想从 attach 切到等用户回复)。其他 session /
      // pending_new_session_claimed 都是"另一端在操作"。
      const isSameSession = (current.type === 'session'
        && current.sessionUuid === info.sessionId);
      if (!isTransient && !isSameSession) {
        throw new Error(
          `Failed to set expectedReply for ${openId}: existing entry is '${current.type}' for a different session`,
        );
      }
      // 自动清(transient 或同 session)
      const cleared = await this.userManager.compareAndSwap(openId, current, null);
      if (!cleared) {
        throw new Error(`Failed to set expectedReply for ${openId}: CAS conflict on clear`);
      }
    }
    // 现在 slot 是 null 了,写 pending_agent_reply
    const ok = await this.userManager.compareAndSwap(openId, null, newEntry);
    if (!ok) {
      throw new Error(`Failed to set expectedReply for ${openId}: CAS failed on write`);
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
    if (current?.type === 'pending_agent_reply') {
      await this.userManager.compareAndSwap(openId, current, null);
    }
    // v2.2.19 fix: always clear local state. CAS 1 in handleAttach may have
    // already nulled the user-mapping entry, but in-memory + timer are stale.
    this.inMemory.delete(openId);
    this.clearTimer(openId);
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
    const entries = await this.userManager.allEntries();
    for (const [openId, entry] of entries) {
      if (entry.type !== 'pending_agent_reply') continue;
      const startedAt = new Date(entry.startedAt!).getTime();
      const elapsed = Date.now() - startedAt;
      if (elapsed >= entry.timeoutMs!) {
        // 已超时,静默删除
        await this.userManager.compareAndSwap(openId, entry, null);
      } else {
        // 未超时,重建
        const internal: InternalEntry = {
          shortId: entry.shortId!,
          sessionId: entry.sessionUuid!,
          cwd: entry.cwd || '',
          startedAt,
          timeoutMs: entry.timeoutMs!,
          casToken: entry.casToken || '',
        };
        this.inMemory.set(openId, internal);
        this.scheduleTimeout(openId);
      }
    }
  }
}

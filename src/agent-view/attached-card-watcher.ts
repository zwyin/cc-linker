// src/agent-view/attached-card-watcher.ts
/**
 * Attached Card Watcher —镜像 LiveProgressWatcher (src/feishu/live-progress.ts)
 * 的 setInterval / inFlightTick / patchFailureCount模式。
 *
 *单一职责:每 intervalMs调一次 tick(),拉最新 snapshot + recentOutput,
 * patch飞书卡;达到停止条件(idle / user_chat / superseded / user_stop /
 * patch_failed / max_ticks)时清理 setInterval 并 onStop回调。
 */
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/async';
import { AgentSnapshotFetcher } from './snapshot-fetcher';
import { buildAttachedCard } from './card';
import type { FetchResult } from './snapshot-fetcher';

export interface AttachedWatchConfig {
 intervalMs: number;
 maxTicks: number;
 maxPatchFailures: number;
}

export const DEFAULT_ATTACHED_WATCH_CONFIG: AttachedWatchConfig = {
 intervalMs:10_000,
 maxTicks:800,
 maxPatchFailures:3,
};

export interface AttachedWatchDeps {
 openId: string;
 sessionId: string;
 shortId: string;
 name: string;
 cwd: string;
 cardMessageId: string;
 patchFn: (messageId: string, card: string) => Promise<any>;
 config: AttachedWatchConfig;
 /**
 * 三层 JSONL解析(tier1 own / tier2 parent / tier3 claude logs退化),
 * 由 manager注入 this.resolvePeekContent绑定。
 */
 resolveContent: (
 shortId: string,
 maxChars: number,
 ) => Promise<{ text: string | null; format: 'markdown' | 'terminal' }>;
 onStop: (openId: string, reason: string, watcher: AttachedCardWatcher) => void;
}

export class AttachedCardWatcher {
 private intervalHandle: ReturnType<typeof setInterval> | null = null;
 private tickCount =0;
 private patchFailureCount =0;
 private stopped = false;
 private startedAt = Date.now();
 private inFlightTick: Promise<void> | null = null;

 constructor(private readonly deps: AttachedWatchDeps) {}

 start(): void {
 this.intervalHandle = setInterval(
 () => {
 // skip overlap, 同 live-progress.ts:115
 if (this.inFlightTick) return;
 this.inFlightTick = this.tick()
 .catch(err => logger.error(`AttachedCardWatcher tick error: ${err}`))
 .finally(() => {
 this.inFlightTick = null;
 });
 },
 this.deps.config.intervalMs,
 );
 logger.info(
 `AttachedCardWatcher start: openId=${this.deps.openId}, ` +
 `sessionId=${this.deps.sessionId}, cardMessageId=${this.deps.cardMessageId}, ` +
 `intervalMs=${this.deps.config.intervalMs}`,
 );
 }

 async stop(reason: string, opts?: { patchFinal?: boolean }): Promise<void> {
 if (this.stopped) return;
 this.stopped = true;
 if (this.intervalHandle) {
 clearInterval(this.intervalHandle);
 this.intervalHandle = null;
 }
 const elapsedSec = Math.floor((Date.now() - this.startedAt) /1000);
 logger.info(
 `AttachedCardWatcher stop: openId=${this.deps.openId}, ` +
 `reason=${reason}, ticks=${this.tickCount}, elapsed=${elapsedSec}s`,
 );
 this.deps.onStop(this.deps.openId, reason, this);
 //等待 in-flight tick 完成(最多5s,避免 SIGTERM截断 patchFn)
 if (this.inFlightTick) {
 await withTimeout(this.inFlightTick,5000, undefined as void | undefined);
 }
 }

 // tick() 在 Task5 实现
 async tick(): Promise<void> {
    if (this.stopped) return;
    this.tickCount++;

    // 1) snapshot
    const result: FetchResult = await AgentSnapshotFetcher.fetch();
    if (!result.ok) {
      logger.warn(`AttachedCardWatcher tick snapshot failed: ${result.reason}`);
      return; // 不 patch, 不 stop(spec §3.7)
    }

    // 2) 找 session
    const session = result.sessions.find(s => s.sessionId === this.deps.sessionId);
    if (!session) {
      // session 已不存在:patch final + stop
      const card = buildAttachedCard({
        name: this.deps.name,
        status: 'unknown',
        shortId: this.deps.shortId,
        sessionId: this.deps.sessionId,
        cwd: this.deps.cwd,
        recentOutput: '⚠️ session 已不存在',
        outputFormat: 'markdown',
        lastWatchedAt: new Date().toLocaleTimeString(),
      });
      await this.deps.patchFn(this.deps.cardMessageId, card);
      await this.stop('session_gone');
      return;
    }

    // 3) idle + completed: final + stop
    if (session.status === 'idle' && session.completed) {
      const content = await this.deps.resolveContent(this.deps.shortId, 2048);
      const card = buildAttachedCard({
        name: this.deps.name,
        status: session.status,
        completed: session.completed,
        waitingFor: session.waitingFor,
        shortId: this.deps.shortId,
        sessionId: this.deps.sessionId,
        cwd: this.deps.cwd,
        recentOutput: content.text ?? '(无可用输出)',
        outputFormat: content.format,
        lastWatchedAt: new Date().toLocaleTimeString(),
      });
      await this.deps.patchFn(this.deps.cardMessageId, card);
      await this.stop('idle_settled');
      return;
    }

    // 4) 拉 recentOutput
    const content = await this.deps.resolveContent(this.deps.shortId, 2048);

    // 5) build card(内含 25KB 智能截断)
    const card = buildAttachedCard({
      name: this.deps.name,
      status: session.status,
      completed: session.completed,
      waitingFor: session.waitingFor,
      shortId: this.deps.shortId,
      sessionId: this.deps.sessionId,
      cwd: this.deps.cwd,
      recentOutput: content.text ?? '(无可用输出)',
      outputFormat: content.format,
      lastWatchedAt: new Date().toLocaleTimeString(),
    });

    // 6) patch + 失败计数
    try {
      await this.deps.patchFn(this.deps.cardMessageId, card);
      this.patchFailureCount = 0;
    } catch (err: any) {
      this.patchFailureCount++;
      logger.warn(
        `AttachedCardWatcher patch failed (${this.patchFailureCount}/${this.deps.config.maxPatchFailures}): ` +
        `cardMessageId=${this.deps.cardMessageId}: ${err?.message ?? err}`,
      );
      if (this.patchFailureCount >= this.deps.config.maxPatchFailures) {
        await this.stop('patch_failed');
        return;
      }
    }

    // 7) maxTicks
    if (this.tickCount >= this.deps.config.maxTicks) {
      await this.stop('max_ticks');
    }
  }
}

/**
 * AttachedWatchers 管理器(per AgentViewManager 实例一个)
 */
export class AttachedWatchers {
 private watchers = new Map<string, AttachedCardWatcher>();

 constructor(
 private readonly patchFn: (messageId: string, card: string) => Promise<any>,
 private readonly resolveContentFn: (
 shortId: string,
 maxChars: number,
 ) => Promise<{ text: string | null; format: 'markdown' | 'terminal' }>,
 private readonly config: AttachedWatchConfig = DEFAULT_ATTACHED_WATCH_CONFIG,
 ) {}

 has(openId: string): boolean {
 return this.watchers.has(openId);
 }

 /**
 *取代式启动:openId已有旧 watcher 时静默 stop,再启新的。
 * cardMessageId 由调用方在调此方法前拿到(buildAttachedCard + cardReplyFn)。
 */
 async start(
 openId: string,
 opts: {
 sessionId: string;
 shortId: string;
 name: string;
 cwd: string;
 cardMessageId: string;
 },
 ): Promise<void> {
 if (this.watchers.has(openId)) {
 await this.watchers.get(openId)!.stop('superseded', { patchFinal: false });
 this.watchers.delete(openId);
 }
 const watcher = new AttachedCardWatcher({
 openId,
 sessionId: opts.sessionId,
 shortId: opts.shortId,
 name: opts.name,
 cwd: opts.cwd,
 cardMessageId: opts.cardMessageId,
 patchFn: this.patchFn,
 config: this.config,
 resolveContent: this.resolveContentFn,
 onStop: (oid, reason, w) => {
 // identity check:避免慢 in-flight tick完成后被旧 watcher clobber
 if (this.watchers.get(oid) === w) this.watchers.delete(oid);
 },
 });
 this.watchers.set(openId, watcher);
 watcher.start();
 }

 async stop(openId: string, reason: string, opts?: { patchFinal?: boolean }): Promise<void> {
 const w = this.watchers.get(openId);
 if (w) {
 await w.stop(reason, opts);
 //双重清理:onStop 已 delete一次(若 identity check命中),这里再保险
 this.watchers.delete(openId);
 }
 }

 /** bot shutdown 时清空所有 */
 async stopAll(): Promise<void> {
 await Promise.all([...this.watchers.values()].map(w => w.stop('shutdown')));
 }
}

// src/feishu/live-progress.ts
/**
 * Live progress card polling module.
 *
 * Drives the "🔄 处理中会话" overview card with 15s patches showing
 * the latest user/assistant text from JSONL tail. See:
 * docs/superpowers/specs/2026-06-06-feishu-live-progress-card-design.md
 */
import { logger } from '../utils/logger';
import { isSessionActive, SessionActivityCache } from '../utils/session-activity';
import { withTimeout } from '../utils/async';
import { parseTailForPreview } from '../scanner/jsonl';
import { CardUpdater } from './card-updater';
import type { FeishuBot } from './bot';
import type { SessionEntry } from '../registry/types';

export interface LiveProgressConfig {
  intervalMs: number;
  maxTicks: number;
  maxPatchFailures: number;
}

export const DEFAULT_LIVE_PROGRESS_CONFIG: LiveProgressConfig = {
  intervalMs: 3_000,
  maxTicks: 2667,  // 维持 ~133min wall-clock 寿命 (2667 × 3s ≈ 8001s)
  maxPatchFailures: 3,
};

/**
 * Read the last user prompt and last assistant text from JSONL tail.
 * Wraps parseTailForPreview with try/catch — never throws.
 */
export function extractLivePreview(jsonlPath: string | null): LivePreview {
  if (!jsonlPath) return {};
  try {
    return parseTailForPreview(jsonlPath);
  } catch (err) {
    logger.warn(`extractLivePreview failed: ${jsonlPath}: ${err}`);
    return {};
  }
}

/**
 * Detect if a session is currently processing.
 *
 * Priority:
 * 1. Feishu in-memory activeProcesses (zero latency, authoritative)
 * 2. CLI activity markers + CPU + child + mtime (via isSessionActive)
 */
export async function isSessionProcessing(
  uuid: string,
  entry: Pick<SessionEntry, 'cwd' | 'jsonl_path'>,
  bot: FeishuBot,
): Promise<boolean> {
  // 1) Feishu in-memory
  if ((bot as any).sessionManager.listSessions().some((s: any) => s.sessionId === uuid)) {
    return true;
  }
  // 2) CLI activity detection
  const cache = (bot as any).sessionManager.activityCache ?? new SessionActivityCache();
  const status = await isSessionActive(
    { sessionUuid: uuid, cwd: entry.cwd, jsonl_path: entry.jsonl_path },
    cache,
    'feishu-detects-cli',
  );
  return status.isProcessing && status.confidence !== 'low';
}

export interface WatcherDeps {
  uuid: string;
  openId: string;
  cardMessageId: string;
  feishuClient: any;
  bot: FeishuBot;
  config: LiveProgressConfig;
  /**
   * Called once when the watcher stops. `watcher` is the watcher instance
   * that just stopped — the implementation should compare identity with
   * the current map entry (e.g. `liveWatchers.get(oid) === watcher`) before
   * deleting, otherwise a slow in-flight tick that finishes after `/switch B`
   * can clobber B from the map.
   */
  onStop: (openId: string, reason: string, watcher: LiveProgressWatcher) => void;
}

export interface LivePreview {
  lastUser?: string;
  lastAssistant?: string;
}

/**
 * Single-card polling watcher. One instance per openId.
 *
 * Lifecycle:
 * - start()  — begins setInterval
 * - tick()   — reads JSONL tail, patches card, checks stop conditions
 * - stop()   — clearInterval, calls onStop callback (idempotent)
 */
export class LiveProgressWatcher {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private patchFailureCount = 0;
  private stopped = false;
  private startedAt = Date.now();
  /** Promise of the in-flight tick (if any), so setInterval can skip overlap
   *  and stop() can await a clean shutdown. */
  private inFlightTick: Promise<void> | null = null;

  constructor(private deps: WatcherDeps) {}

  start(): void {
    this.intervalHandle = setInterval(
      () => {
        // Skip if previous tick is still in-flight (slow patchCard etc.)
        // 否则 patchFailureCount 等共享状态会被并发 tick 竞争破坏
        if (this.inFlightTick) return;
        this.inFlightTick = this.tick()
          .catch(err => logger.error(`LiveProgressWatcher tick error: ${err}`))
          .finally(() => { this.inFlightTick = null; });
      },
      this.deps.config.intervalMs,
    );
    logger.info(
      `LiveProgressWatcher start: openId=${this.deps.openId}, uuid=${this.deps.uuid}, ` +
      `cardMessageId=${this.deps.cardMessageId}, intervalMs=${this.deps.config.intervalMs}`,
    );
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    this.tickCount++;

    // 1) session 还在吗？
    const entry = (this.deps.bot as any).registry.get(this.deps.uuid);
    if (!entry) {
      this.stop('session_gone');
      return;
    }

    // 2) 读最新 preview
    const live = extractLivePreview(entry.jsonl_path);

    // 2.5) 从 sessionManager 获取运行信息（用于展示已运行时间 / 最后输出时间）
    let elapsedMs: number | undefined;
    let sinceLastOutputMs: number | undefined;
    try {
      const sessions = (this.deps.bot as any).sessionManager.listSessions();
      const activeSession = sessions.find((s: any) => s.sessionId === this.deps.uuid);
      if (activeSession) {
        const now = Date.now();
        elapsedMs = now - activeSession.createdAt;
        sinceLastOutputMs = now - activeSession.lastOutputAt;
      } else {
        // CLI session 或 sessionManager 中无记录：用 watcher 自身启动时间估算
        elapsedMs = Date.now() - this.startedAt;
      }
    } catch {
      // sessionManager.listSessions() 可能不可用，fallback 到 watcher 启动时间
      elapsedMs = Date.now() - this.startedAt;
    }

    // 3) 重新构建卡片（isRunning=true + 实时标签）
    //    buildLiveOverviewCard 扩展第 5 参（运行时间信息）
    const card = (this.deps.bot as any).buildLiveOverviewCard(
      this.deps.uuid, entry, true, live, { elapsedMs, sinceLastOutputMs },
    );

    // 4) patch
    try {
      const updater: any = new CardUpdater(this.deps.feishuClient, { throttle_ms: 0 });
      updater.setCardMessageId(this.deps.cardMessageId);
      await updater.patchCard(card);
      this.patchFailureCount = 0;
    } catch (err) {
      this.patchFailureCount++;
      logger.warn(
        `LiveProgressWatcher patch failed (${this.patchFailureCount}/${this.deps.config.maxPatchFailures}): ` +
        `cardMessageId=${this.deps.cardMessageId}: ${err}`,
      );
      if (this.patchFailureCount >= this.deps.config.maxPatchFailures) {
        this.stop('patch_failed');
        return;
      }
    }

    // 5) maxTicks 硬上限
    if (this.tickCount >= this.deps.config.maxTicks) {
      this.stop('max_ticks');
      return;
    }

    // 6) session 闲下来：发 final + stop
    const stillProcessing = await isSessionProcessing(
      this.deps.uuid, entry, this.deps.bot,
    );
    if (!stillProcessing) {
      const finalCard = (this.deps.bot as any).buildLiveOverviewCard(
        this.deps.uuid, entry, false, live, {},
      );
      try {
        const updater: any = new CardUpdater(this.deps.feishuClient, { throttle_ms: 0 });
        updater.setCardMessageId(this.deps.cardMessageId);
        await updater.patchCard(finalCard);
      } catch (err) {
        logger.warn(`LiveProgressWatcher final patch failed: ${err}`);
      }
      this.stop('idle');
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    // 立即 log + 触发 onStop（不 await inFlightTick），避免 tick 内部调 stop() 时
    // self-deadlock (inFlightTick === 自身 promise). 让 caller 5s race 等真正完成
    // 发生在 log/onStop 之后, 但 5s 等待对调用方透明
    const elapsedSec = Math.floor((Date.now() - this.startedAt) / 1000);
    logger.info(
      `LiveProgressWatcher stop: openId=${this.deps.openId}, uuid=${this.deps.uuid}, ` +
      `reason=${reason}, ticks=${this.tickCount}, elapsed=${elapsedSec}s`,
    );
    this.deps.onStop(this.deps.openId, reason, this);

    // 等待 in-flight tick 完成 (最多 5s, 避免 SIGTERM 截断 patchCard)
    if (this.inFlightTick) {
      // withTimeout 内部 timer 会清理, 不会泄漏; 不 reject
      await withTimeout(this.inFlightTick, 5000, undefined as void | undefined);
    }
  }
}

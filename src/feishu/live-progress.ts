// src/feishu/live-progress.ts
/**
 * Live progress card polling module.
 *
 * Drives the "🔄 处理中会话" overview card with 15s patches showing
 * the latest user/assistant text from JSONL tail. See:
 * docs/superpowers/specs/2026-06-06-feishu-live-progress-card-design.md
 */
import { readFileSync, statSync, openSync, closeSync } from 'fs';
import { logger } from '../utils/logger';
import { isSessionActive, SessionActivityCache } from '../utils/session-activity';
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
  intervalMs: 15_000,
  maxTicks: 400,
  maxPatchFailures: 3,
};

/**
 * Read the last user prompt and last assistant text from JSONL tail.
 * Wraps parseTailForPreview with try/catch — never throws.
 */
export function extractLivePreview(jsonlPath: string | null): {
  lastUser?: string;
  lastAssistant?: string;
} {
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
  onStop: (openId: string, reason: string) => void;
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

  constructor(private deps: WatcherDeps) {}

  start(): void {
    this.intervalHandle = setInterval(
      () => {
        this.tick().catch(err => logger.error(`LiveProgressWatcher tick error: ${err}`));
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

    // 3) 重新构建卡片（isRunning=true + 实时标签）
    //    buildLiveOverviewCard 在 PR 2 扩展第 4 参
    const card = (this.deps.bot as any).buildLiveOverviewCard(
      this.deps.uuid, entry, true, live,
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
        this.deps.uuid, entry, false, live,
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

  stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    const elapsedSec = Math.floor((Date.now() - this.startedAt) / 1000);
    logger.info(
      `LiveProgressWatcher stop: openId=${this.deps.openId}, uuid=${this.deps.uuid}, ` +
      `reason=${reason}, ticks=${this.tickCount}, elapsed=${elapsedSec}s`,
    );
    this.deps.onStop(this.deps.openId, reason);
  }
}

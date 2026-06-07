// src/agent-view/daemon-log-reader.ts
//
// v2.2.4 新增:从 ~/.claude/daemon.log 读取最近 N 小时内 "bg settled" 事件,
// 用于在 `claude agents --json` 之外恢复"已 settled"的后台 session
// (因为 `claude agents --json` 只报 active 的,TUI 内部会自己缓存)。
//
// 解决 spec §4 描述的"Agent View 比 TUI 少行"问题——
// TUI 显示的 Completed 列表里的 session,一旦 daemon 不再持有(--json 不再返回),
// 我们的 Agent View 就看不到。读 daemon.log 拿 settled 事件做兜底。

import { readFileSync } from 'fs';
import { join } from 'path';
import { expandPath } from '../utils/paths';
import type { AgentSessionSource } from './types';

export interface CompletedSession {
  short: string;     // e.g. "3a41fe73"
  settledAt: number; // epoch ms
  status: 'done' | 'killed';
}

/**
 * Read ~/.claude/daemon.log and parse "bg settled" events from the last `withinHours` hours.
 * Returns Map<short, CompletedSession> (deduplicated, last entry wins).
 *
 * 仅匹配格式:`[<ISO timestamp>] [bg] bg settled <short> (done|killed)`
 * 其它行(spawned / supervisor / garbage)一律忽略。
 */
export function readCompletedSessions(withinHours: number = 24): Map<string, CompletedSession> {
  const logPath = join(expandPath('~'), '.claude', 'daemon.log');
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return new Map();
  }
  const cutoffMs = Date.now() - withinHours * 3600_000;
  const result = new Map<string, CompletedSession>();
  for (const line of raw.split('\n')) {
    const m = line.match(/\[([^\]]+)\] \[bg\] bg settled (\S+) \((done|killed)\)/);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (Number.isNaN(ts) || ts < cutoffMs) continue;
    const short = m[2];
    const status = m[3] as 'done' | 'killed';
    result.set(short, { short, settledAt: ts, status });
  }
  return result;
}

/**
 * v2.2.5 新增:从 ~/.claude/daemon.log 解析 "bg claimed-spare" 事件,
 * 用于推断已 settled session 的 dispatch.source(spare|slash|fleet)。
 *
 * 背景:完成后的 session 已被 daemon 从 roster.json 中清掉,
 * 直接 lookup roster 拿不到 source —— 但 daemon.log 里保留着原始的
 * claimed 事件,可以反查。
 *
 * 仅匹配格式:`[<ISO timestamp>] [bg] bg claimed-spare <short> (spare|slash|fleet)`
 * Map 用 last entry wins(同一 short 可能被多次 reclaim,以最新一次为准)。
 */
export function readClaimedSources(withinHours: number = 24): Map<string, AgentSessionSource> {
  const logPath = join(expandPath('~'), '.claude', 'daemon.log');
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return new Map();
  }
  const cutoffMs = Date.now() - withinHours * 3600_000;
  const result = new Map<string, AgentSessionSource>();
  for (const line of raw.split('\n')) {
    // "[2026-06-06T11:27:48.846Z] [bg] bg claimed-spare 273a5566 (spare)"
    const m = line.match(/\[([^\]]+)\] \[bg\] bg claimed-spare (\S+) \((spare|slash|fleet)\)/);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (Number.isNaN(ts) || ts < cutoffMs) continue;
    result.set(m[2], m[3] as AgentSessionSource);
  }
  return result;
}

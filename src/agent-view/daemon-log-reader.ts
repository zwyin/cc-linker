// src/agent-view/daemon-log-reader.ts
//
// v2.3 精简:`readCompletedSessions` 退役 — settled 探测改走 ~/.claude/jobs/<short>/state.json
// 的 `state === 'done'`(权威)。本模块只剩 `readClaimedSources`:state.json 没有
// `dispatch.source` 字段,settled 后 roster 已清,只能从 daemon.log 的 `bg claimed-spare`
// 事件 tail 反查 spare / slash / fleet,用于过滤 sub-agent。

import { readFileSync } from 'fs';
import { join } from 'path';
import { expandPath } from '../utils/paths';
import type { AgentSessionSource } from './types';

/**
 * 从 ~/.claude/daemon.log 解析 "bg claimed-spare" 事件,
 * 用于推断已 settled session 的 dispatch.source(spare|slash|fleet)。
 *
 * 背景:settled 后 session 已被 daemon 从 roster.json 中清掉,
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

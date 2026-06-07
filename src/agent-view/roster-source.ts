// src/agent-view/roster-source.ts
//
// v2.2.1 新增:从 ~/.claude/daemon/roster.json 读取 dispatch.source,
// 用于识别一个 background session 是用户派发(slash)还是 sub-agent(spare/fleet)。
// 详见 spec §3.1 "sub-agent 过滤"。
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { expandPath } from '../utils/paths';

export type RosterDispatchSource = 'slash' | 'spare' | 'fleet';

export interface RosterWorker {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  dispatch: {
    source: RosterDispatchSource;
    // 其它字段(launch / env / isolation 等)我们不关心,允许透传
    [k: string]: unknown;
  };
}

export interface Roster {
  workers: Record<string, RosterWorker>;
  updatedAt: number;
}

/** 读取 ~/.claude/daemon/roster.json。读不到/解析失败返回 null(优雅降级)。 */
export function readRoster(): Roster | null {
  try {
    const path = join(expandPath('~'), '.claude', 'daemon', 'roster.json');
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as Roster;
  } catch {
    // 静默失败:daemon 没跑、文件被锁、JSON 损坏都视作"无 roster 信息"
    return null;
  }
}

/**
 * 把 roster 压扁成 shortId → dispatch.source 的 Map。
 * 键用 short hash(8 字符),与 snapshot-fetcher / action 路由一致。
 * 失败/空 roster → 返回空 Map(此时所有 session 的 source 都会是 'unknown')。
 */
export function buildRosterSourceMap(
  roster: Roster | null,
): Map<string, RosterDispatchSource> {
  const map = new Map<string, RosterDispatchSource>();
  if (!roster || !roster.workers) return map;
  for (const [short, w] of Object.entries(roster.workers)) {
    if (w?.dispatch?.source) {
      map.set(short, w.dispatch.source);
    }
  }
  return map;
}

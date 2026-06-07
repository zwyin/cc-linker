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

/**
 * v2.2.8 新增:查 roster 拿 short → resume-from JSONL 全路径。
 *
 * 用法:bg session 自己的 JSONL 只有 metadata(典型 fork from parent 的 active
 * session)时,沿着 dispatch.launch.sessionId 回 parent 拿最后一条 assistant
 * 文本作为 Peek 内容。
 *
 * dispatch.launch.sessionId 形如:
 *   /Users/wuyujun/.claude/projects/-Users-wuyujun-Git-cc-linker/57872373-....jsonl
 * 直接是 path,不是 UUID。读不到/格式不符返回 null,调用方退化下一级。
 */
export function lookupResumeFromPath(
  roster: Roster | null,
  short: string,
): string | null {
  if (!roster || !roster.workers) return null;
  const w = roster.workers[short];
  const launch = w?.dispatch?.launch as { sessionId?: string; mode?: string } | undefined;
  if (!launch || launch.mode !== 'resume') return null;
  const p = launch.sessionId;
  if (typeof p !== 'string' || !p.endsWith('.jsonl')) return null;
  return p;
}

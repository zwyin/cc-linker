// src/agent-view/snapshot.ts
import type { AgentSession, AgentSessionStatus, AgentSessionSource } from './types';
import type { RosterDispatchSource } from './roster-source';

export function parseAgentsJson(raw: string): AgentSession[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected JSON array from `claude agents --json`');
  }
  return parsed
    .filter((s: any) => s && s.kind === 'background')
    .map((s: any): AgentSession => {
      const status: AgentSessionStatus =
        s.status === 'busy' || s.status === 'waiting' || s.status === 'idle'
          ? s.status
          : 'unknown';
      return {
        pid: Number(s.pid) || 0,
        cwd: String(s.cwd || ''),
        kind: 'background',
        startedAt: Number(s.startedAt) || 0,
        sessionId: String(s.sessionId || ''),
        name: String(s.name || 'unnamed'),
        status,
        // v2.2.1: parseAgentsJson 阶段还没法关联 roster,统一标 'unknown'。
        // 上层(snapshot-fetcher.fetch)会调 attachRosterSources 覆盖。
        source: 'unknown',
        ...(status === 'waiting' && s.waitingFor
          ? { waitingFor: String(s.waitingFor) }
          : {}),
      };
    });
}

/**
 * v2.2.1 新增:把 roster 的 dispatch.source 关联到每个 session。
 * 找不到对应 shortId 时保持 'unknown'(graceful:daemon 没跑也能正常显示)。
 */
export function attachRosterSources(
  sessions: AgentSession[],
  sourceMap: Map<string, RosterDispatchSource>,
): AgentSession[] {
  return sessions.map(s => {
    const short = s.sessionId.slice(0, 8);
    const source: AgentSessionSource = sourceMap.get(short) ?? 'unknown';
    return { ...s, source };
  });
}

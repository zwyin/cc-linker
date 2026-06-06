// src/agent-view/snapshot.ts
import type { AgentSession, AgentSessionStatus } from './types';

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
        ...(status === 'waiting' && s.waitingFor
          ? { waitingFor: String(s.waitingFor) }
          : {}),
      };
    });
}

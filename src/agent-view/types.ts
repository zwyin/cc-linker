// src/agent-view/types.ts

export type AgentSessionStatus = 'busy' | 'waiting' | 'idle' | 'unknown';

export interface AgentSession {
  pid: number;
  cwd: string;
  kind: 'background';
  startedAt: number;  // epoch ms
  sessionId: string;  // UUID
  name: string;
  status: AgentSessionStatus;
  waitingFor?: string;  // 仅 status === 'waiting' 时存在
}

export type AgentSessionGroup = {
  busy: AgentSession[];
  waiting: AgentSession[];
  idle: AgentSession[];
};

export function groupByStatus(sessions: AgentSession[]): AgentSessionGroup {
  return {
    busy: sessions.filter(s => s.status === 'busy'),
    waiting: sessions.filter(s => s.status === 'waiting'),
    idle: sessions.filter(s => s.status === 'idle'),
  };
}

// src/agent-view/types.ts

export type AgentSessionStatus = 'busy' | 'waiting' | 'idle' | 'unknown';

// v2.2.1: 来源标识 — 由 ~/.claude/daemon/roster.json 的 dispatch.source 推断
// - 'slash': 用户派发(TUI 可见,我们的 Agent View 展示)
// - 'spare': sub-agent(TUI 隐藏,我们也过滤掉)
// - 'fleet': daemon 内部任务(TUI 显示为 Completed,按 sub-agent 处理)
// - 'unknown': 找不到对应 roster 记录(daemon 未跑 / session 不在 roster 中)
export type AgentSessionSource = 'slash' | 'spare' | 'fleet' | 'unknown';

export interface AgentSession {
  pid: number;
  cwd: string;
  kind: 'background';
  startedAt: number;  // epoch ms
  sessionId: string;  // UUID
  name: string;
  status: AgentSessionStatus;
  source: AgentSessionSource;  // v2.2.1 新增
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

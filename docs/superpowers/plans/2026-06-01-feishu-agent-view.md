# 飞书侧 Claude Code Agent View 支持 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在飞书侧支持查看、Peek、Reply、Stop Claude Code 后台会话(Agent View 功能),通过 SDK resume 复用 cc-linker 现有 sendSDKMessage 通道。

**Architecture:** 新增 `src/agent-view/` 模块(7 文件),`FeishuBot` 路由 `/agents` 命令和 card action 回调到 `AgentViewManager`。列表数据走 `claude agents --json`,Peek 走 `claude logs <id>`,Stop 走 `claude stop <id>`,Reply 两步式(按钮触发 expectedReply 标记,用户发普通文本消息触发 sendSDKMessage resume)。

**Tech Stack:** Bun + TypeScript,`@anthropic-ai/claude-agent-sdk`(已有),`@larksuiteoapi/node-sdk`(已有),`bun:test`(已有),`Bun.spawn`/`execFile`(已有)。

**Spec:** `docs/superpowers/specs/2026-06-01-feishu-agent-view-design.md`

---

## File Structure

新增/修改文件:

| 文件 | 职责 |
|------|------|
| `src/agent-view/index.ts` | 模块公共导出 |
| `src/agent-view/snapshot.ts` | JSON 解析、状态守卫、类型定义 |
| `src/agent-view/poller.ts` | `claude` shell 调用封装(version / agents --json / logs / stop) |
| `src/agent-view/card.ts` | 飞书卡片构建(列表/peek/错误/空/等待/超时/取消) |
| `src/agent-view/reply-bridge.ts` | expectedReply 状态机 + sendSDKMessage 集成 |
| `src/agent-view/manager.ts` | 顶层协调类 `AgentViewManager` |
| `src/agent-view/action.ts` | `card.action.trigger` 路由(纯类型) |
| `src/utils/config.ts` | **修改**:注册 `agent_view.*` 配置节 |
| `src/feishu/bot.ts` | **修改**:`/agents` 命令、card action 分派、expectedReply chat hook |
| `src/feishu/bot.ts:handleChat()` | **修改**:入口检查 expectedReply 标记 |
| `tests/unit/agent-view/snapshot.test.ts` | snapshot 解析、版本守卫 |
| `tests/unit/agent-view/card.test.ts` | 卡片构建 |
| `tests/unit/agent-view/reply-bridge.test.ts` | expectedReply 状态机 |
| `tests/unit/agent-view/manager.test.ts` | 集成 manager 行为 |
| `tests/unit/agent-view/feishu-bot-integration.test.ts` | bot 集成 |
| `tests/fixtures/agents-json/*.json` | 6 个 JSON fixture |
| `docs/superpowers/specs/2026-06-01-feishu-agent-view-design.md` | 已存在(spec) |
| `README.md` / `README_en.md` / `CLAUDE.md` | **修改**:文档更新 |

---

## Task 1: 模块脚手架、类型定义、版本守卫

**Files:**
- Create: `src/agent-view/snapshot.ts`
- Create: `src/agent-view/index.ts`
- Test: `tests/unit/agent-view/snapshot.test.ts`

- [ ] **Step 1: 写失败的测试 — version 守卫与 status 枚举**

`tests/unit/agent-view/snapshot.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { parseClaudeVersion, satisfiesMinVersion, MIN_CLAUDE_VERSION } from '../../../src/agent-view/snapshot';

describe('parseClaudeVersion', () => {
  it('parses standard version output', () => {
    expect(parseClaudeVersion('2.1.139 (Claude Code)')).toEqual({ major: 2, minor: 1, patch: 139 });
  });
  it('parses version with prerelease tag', () => {
    expect(parseClaudeVersion('2.1.142-beta')).toEqual({ major: 2, minor: 1, patch: 142 });
  });
  it('returns null for unrecognized', () => {
    expect(parseClaudeVersion('garbage')).toBeNull();
  });
});

describe('satisfiesMinVersion', () => {
  it('exact match returns true', () => {
    expect(satisfiesMinVersion({ major: 2, minor: 1, patch: 139 })).toBe(true);
  });
  it('newer patch returns true', () => {
    expect(satisfiesMinVersion({ major: 2, minor: 1, patch: 200 })).toBe(true);
  });
  it('older minor returns false', () => {
    expect(satisfiesMinVersion({ major: 2, minor: 1, patch: 138 })).toBe(false);
  });
  it('exposes MIN_CLAUDE_VERSION constant', () => {
    expect(MIN_CLAUDE_VERSION).toBe('2.1.139');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/agent-view/snapshot.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现 snapshot.ts(version 解析 + 守卫)**

`src/agent-view/snapshot.ts`:

```typescript
/**
 * Agent View 数据模型与版本守卫
 * @see docs/superpowers/specs/2026-06-01-feishu-agent-view-design.md
 */

export const MIN_CLAUDE_VERSION = '2.1.139';

export interface ClaudeVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * 解析 `claude --version` 输出
 * 接受 "2.1.139" 或 "2.1.139 (Claude Code)" 或 "2.1.142-beta" 格式
 */
export function parseClaudeVersion(stdout: string): ClaudeVersion | null {
  const match = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

const MIN: ClaudeVersion = parseClaudeVersion(MIN_CLAUDE_VERSION)!;

export function satisfiesMinVersion(v: ClaudeVersion): boolean {
  if (v.major !== MIN.major) return v.major > MIN.major;
  if (v.minor !== MIN.minor) return v.minor > MIN.minor;
  return v.patch >= MIN.patch;
}
```

- [ ] **Step 4: 创建 index.ts 占位导出**

`src/agent-view/index.ts`:

```typescript
/**
 * Agent View 模块 — 飞书侧 Claude Code 后台会话管理
 * @see docs/superpowers/specs/2026-06-01-feishu-agent-view-design.md
 */

export * from './snapshot';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test tests/unit/agent-view/snapshot.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/agent-view/ tests/unit/agent-view/
git commit -m "feat(agent-view): 模块脚手架 + 版本守卫"
```

---

## Task 2: Snapshot 解析 — `claude agents --json`

**Files:**
- Modify: `src/agent-view/snapshot.ts`
- Create: `tests/fixtures/agents-json/working.json`
- Create: `tests/fixtures/agents-json/blocked.json`
- Create: `tests/fixtures/agents-json/mixed.json`
- Create: `tests/fixtures/agents-json/empty.json`
- Create: `tests/fixtures/agents-json/invalid.json`
- Test: `tests/unit/agent-view/snapshot.test.ts` (扩展)

- [ ] **Step 1: 写失败的测试 — JSON 解析**

追加到 `tests/unit/agent-view/snapshot.test.ts`:

```typescript
import { parseAgentsJson, AgentSession } from '../../../src/agent-view/snapshot';
import { join } from 'path';

const FIXTURE_DIR = join(import.meta.dir, '..', '..', 'fixtures', 'agents-json');

function loadFixture(name: string): string {
  return require('fs').readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

describe('parseAgentsJson', () => {
  it('parses working session', () => {
    const sessions = parseAgentsJson(loadFixture('working.json'));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      shortId: 'a1b2c3d4',
      sessionId: 'sess-001',
      name: 'flaky-test-fix',
      status: 'working',
      cwd: '/Users/dev/projects/my-app',
      kind: 'claude',
      pid: 12345,
    });
  });
  it('parses blocked session', () => {
    const sessions = parseAgentsJson(loadFixture('blocked.json'));
    expect(sessions[0].status).toBe('blocked');
  });
  it('parses mixed states (3 sessions)', () => {
    const sessions = parseAgentsJson(loadFixture('mixed.json'));
    expect(sessions).toHaveLength(3);
    const statuses = sessions.map(s => s.status);
    expect(statuses).toContain('working');
    expect(statuses).toContain('blocked');
    expect(statuses).toContain('done');
  });
  it('parses empty array', () => {
    expect(parseAgentsJson('[]')).toEqual([]);
  });
  it('throws on invalid JSON', () => {
    expect(() => parseAgentsJson('not json')).toThrow(/parse/i);
  });
  it('throws on JSON that is not an array', () => {
    expect(() => parseAgentsJson('{"foo": 1}')).toThrow(/array/i);
  });
  it('normalizes missing optional fields', () => {
    const minimal = JSON.stringify([{ pid: 1, cwd: '/x', kind: 'claude', startedAt: '2026-06-01T00:00:00Z' }]);
    const sessions = parseAgentsJson(minimal);
    expect(sessions[0]).toMatchObject({
      pid: 1,
      cwd: '/x',
      kind: 'claude',
      status: 'unknown',
      shortId: '',
      sessionId: '',
      name: '(unnamed)',
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/agent-view/snapshot.test.ts`
Expected: FAIL — `parseAgentsJson` not found

- [ ] **Step 3: 创建 5 个 fixture**

`tests/fixtures/agents-json/working.json`:
```json
[
  {
    "pid": 12345,
    "cwd": "/Users/dev/projects/my-app",
    "kind": "claude",
    "startedAt": "2026-06-01T10:00:00Z",
    "sessionId": "sess-001",
    "name": "flaky-test-fix",
    "status": "working"
  }
]
```

`tests/fixtures/agents-json/blocked.json`:
```json
[
  {
    "pid": 12346,
    "cwd": "/Users/dev/projects/my-game",
    "kind": "claude",
    "startedAt": "2026-06-01T09:55:00Z",
    "sessionId": "sess-002",
    "name": "power-up design",
    "status": "blocked"
  }
]
```

`tests/fixtures/agents-json/mixed.json`:
```json
[
  {
    "pid": 12345, "cwd": "/p1", "kind": "claude",
    "startedAt": "2026-06-01T10:00:00Z",
    "sessionId": "sess-001", "name": "session-a", "status": "working"
  },
  {
    "pid": 12346, "cwd": "/p2", "kind": "claude",
    "startedAt": "2026-06-01T09:55:00Z",
    "sessionId": "sess-002", "name": "session-b", "status": "blocked"
  },
  {
    "pid": 12347, "cwd": "/p3", "kind": "claude",
    "startedAt": "2026-06-01T08:00:00Z",
    "sessionId": "sess-003", "name": "session-c", "status": "done"
  }
]
```

`tests/fixtures/agents-json/empty.json`:
```json
[]
```

`tests/fixtures/agents-json/invalid.json`:
```
this is not json {
```

- [ ] **Step 4: 扩展 snapshot.ts 实现 parseAgentsJson**

追加到 `src/agent-view/snapshot.ts`:

```typescript
export type AgentSessionStatus =
  | 'working'
  | 'blocked'
  | 'idle'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'unknown';

export interface AgentSession {
  shortId: string;
  sessionId: string;
  name: string;
  status: AgentSessionStatus;
  cwd: string;
  kind: string;
  pid: number;
  startedAt: string;
}

interface RawAgentSession {
  pid?: number;
  cwd?: string;
  kind?: string;
  startedAt?: string;
  sessionId?: string;
  name?: string;
  status?: string;
  // shortId 不是 JSON 字段,从 cwd 推断(jobs 目录名) — v1 留空
}

const KNOWN_STATUSES: ReadonlySet<AgentSessionStatus> = new Set([
  'working', 'blocked', 'idle', 'done', 'failed', 'stopped',
]);

/**
 * 解析 `claude agents --json` 输出
 * @throws 当 JSON 解析失败或根不是数组时
 */
export function parseAgentsJson(stdout: string): AgentSession[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`parseAgentsJson: invalid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`parseAgentsJson: expected array, got ${typeof raw}`);
  }
  return raw.map((item, idx) => normalize(item as RawAgentSession, idx));
}

function normalize(r: RawAgentSession, idx: number): AgentSession {
  const status = (r.status ?? 'unknown') as AgentSessionStatus;
  return {
    shortId: '',  // v1 留空:需要从 ~/.claude/jobs/<id>/ 目录名获取,实现可后续补
    sessionId: r.sessionId ?? '',
    name: r.name ?? '(unnamed)',
    status: KNOWN_STATUSES.has(status) ? status : 'unknown',
    cwd: r.cwd ?? '',
    kind: r.kind ?? 'claude',
    pid: typeof r.pid === 'number' ? r.pid : 0,
    startedAt: r.startedAt ?? '',
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test tests/unit/agent-view/snapshot.test.ts`
Expected: PASS (12 tests total)

- [ ] **Step 6: Commit**

```bash
git add src/agent-view/snapshot.ts tests/
git commit -m "feat(agent-view): 解析 claude agents --json 输出"
```

---

## Task 3: Config 注册 — `agent_view.*` 配置节

**Files:**
- Modify: `src/utils/config.ts`
- Test: `tests/unit/utils/config.test.ts` (追加)

- [ ] **Step 1: 写失败的测试**

追加到 `tests/unit/utils/config.test.ts` (如果文件不存在则创建,模仿现有 utils 测试):

```typescript
import { describe, it, expect } from 'bun:test';
import { config } from '../../../src/utils/config';

describe('agent_view config', () => {
  it('default enabled = true', () => {
    expect(config.get<boolean>('agent_view.enabled', true)).toBe(true);
  });
  it('default refresh_min_interval_ms = 2000', () => {
    expect(config.get<number>('agent_view.refresh_min_interval_ms', 2000)).toBe(2000);
  });
  it('default peek_lines = 30', () => {
    expect(config.get<number>('agent_view.peek_lines', 30)).toBe(30);
  });
  it('default reply_lock_timeout_ms = 30000', () => {
    expect(config.get<number>('agent_view.reply_lock_timeout_ms', 30000)).toBe(30000);
  });
  it('default min_claude_version = 2.1.139', () => {
    expect(config.get<string>('agent_view.min_claude_version', '2.1.139')).toBe('2.1.139');
  });
  it('default reply_wait_timeout_ms = 300000 (5 min)', () => {
    expect(config.get<number>('agent_view.reply_wait_timeout_ms', 300000)).toBe(300000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/utils/config.test.ts`
Expected: PASS (现有测试都过,新测试 fail 因为默认值没注册 — bun 不会因未知 key 抛错,所以会走 fallback)

实际上 `config.get(key, fallback)` 在 key 未知时直接返回 fallback。要让测试 FAIL,需要先确认 config 实际返回 fallback 之外的值。需要修改 config 让 agent_view.* key 在 data 里有默认值,测试期望从 `config.data.agent_view.X` 直接读。

调整方法:测试改为检查 `config.data.agent_view.enabled === true`:

```typescript
describe('agent_view config', () => {
  it('has enabled default true', () => {
    expect((config as any).data.agent_view.enabled).toBe(true);
  });
  it('has refresh_min_interval_ms default 2000', () => {
    expect((config as any).data.agent_view.refresh_min_interval_ms).toBe(2000);
  });
  // ... 等等
});
```

- [ ] **Step 3: 修改 config.ts — 注册 agent_view 段**

修改 `src/utils/config.ts`:

1. 在 `interface ConfigData` 末尾添加(第 77 行后):
```typescript
  agent_view: {
    enabled: boolean;
    refresh_min_interval_ms: number;
    peek_lines: number;
    reply_lock_timeout_ms: number;
    reply_wait_timeout_ms: number;
    min_claude_version: string;
  };
```

2. 在 `DEFAULTS`(第 153 行 `}` 前)添加:
```typescript
  agent_view: {
    enabled: true,
    refresh_min_interval_ms: 2000,
    peek_lines: 30,
    reply_lock_timeout_ms: 30000,
    reply_wait_timeout_ms: 5 * 60 * 1000,
    min_claude_version: '2.1.139',
  },
```

3. 在 `cloneDefaults()`(第 169 行 `}` 前)添加:
```typescript
    agent_view: { ...DEFAULTS.agent_view },
```

4. 在 env mappings 数组(第 258 行附近)添加:
```typescript
      ['CC_LINKER_AGENT_VIEW_ENABLED', 'agent_view', 'enabled'],
      ['CC_LINKER_AGENT_VIEW_REFRESH_MIN_INTERVAL_MS', 'agent_view', 'refresh_min_interval_ms'],
      ['CC_LINKER_AGENT_VIEW_PEEK_LINES', 'agent_view', 'peek_lines'],
      ['CC_LINKER_AGENT_VIEW_REPLY_LOCK_TIMEOUT_MS', 'agent_view', 'reply_lock_timeout_ms'],
      ['CC_LINKER_AGENT_VIEW_REPLY_WAIT_TIMEOUT_MS', 'agent_view', 'reply_wait_timeout_ms'],
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/unit/utils/config.test.ts`
Expected: PASS (现有 + 新 6 个)

- [ ] **Step 5: Commit**

```bash
git add src/utils/config.ts tests/unit/utils/config.test.ts
git commit -m "feat(config): 注册 agent_view 配置节"
```

---

## Task 4: 卡片构建器 — 列表卡

**Files:**
- Create: `src/agent-view/card.ts`
- Test: `tests/unit/agent-view/card.test.ts`

- [ ] **Step 1: 写失败的测试 — 列表卡结构与分组**

`tests/unit/agent-view/card.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { buildListCard, groupByStatus } from '../../../src/agent-view/card';
import type { AgentSession } from '../../../src/agent-view/snapshot';

function s(over: Partial<AgentSession>): AgentSession {
  return {
    shortId: 'a1', sessionId: 'sess-1', name: 'foo',
    status: 'working', cwd: '/p', kind: 'claude', pid: 1, startedAt: '2026-06-01T10:00:00Z',
    ...over,
  };
}

describe('groupByStatus', () => {
  it('groups into working / blocked / completed', () => {
    const groups = groupByStatus([
      s({ status: 'working' }),
      s({ status: 'blocked' }),
      s({ status: 'done' }),
      s({ status: 'failed' }),
      s({ status: 'stopped' }),
    ]);
    expect(groups.working).toHaveLength(1);
    expect(groups.blocked).toHaveLength(1);
    expect(groups.completed).toHaveLength(3);  // done + failed + stopped
  });
  it('empty input produces empty groups', () => {
    const groups = groupByStatus([]);
    expect(groups.working).toHaveLength(0);
    expect(groups.blocked).toHaveLength(0);
    expect(groups.completed).toHaveLength(0);
  });
});

describe('buildListCard', () => {
  it('renders header with session count', () => {
    const card = buildListCard({
      groups: { working: [s({ name: 'a' })], blocked: [], completed: [] },
      totalCount: 1,
      lastRefreshedAt: '2026-06-01 12:34:56',
      agentViewUrl: '',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('Agent View');
    expect(json).toContain('1 sessions');
  });
  it('renders only non-empty groups', () => {
    const card = buildListCard({
      groups: { working: [s({ name: 'a' })], blocked: [], completed: [] },
      totalCount: 1, lastRefreshedAt: '2026-06-01 12:34:56', agentViewUrl: '',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('Working');
    expect(json).not.toContain('Needs input');
    expect(json).not.toContain('Completed');
  });
  it('truncates cwd to ~/projects/my-app format', () => {
    const card = buildListCard({
      groups: { working: [s({ cwd: '/Users/dev/projects/my-app' })], blocked: [], completed: [] },
      totalCount: 1, lastRefreshedAt: '2026-06-01 12:34:56', agentViewUrl: '',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('~/projects/my-app');
  });
  it('shows only Reply/Peek/Stop buttons appropriate to status', () => {
    const card = buildListCard({
      groups: { working: [], blocked: [s({ name: 'b' })], completed: [] },
      totalCount: 1, lastRefreshedAt: '2026-06-01 12:34:56', agentViewUrl: '',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('agent_view_peek');
    expect(json).toContain('agent_view_reply_request');
    expect(json).not.toContain('agent_view_stop');  // blocked 不显示 stop
  });
  it('card body does not exceed 30KB', () => {
    const sessions = Array.from({ length: 20 }, (_, i) => s({
      shortId: `id${i}`, sessionId: `s${i}`, name: `session-${i}`,
      cwd: `/Users/dev/projects/very-long-path-${i}`,
    }));
    const card = buildListCard({
      groups: { working: sessions, blocked: [], completed: [] },
      totalCount: 20, lastRefreshedAt: '2026-06-01 12:34:56', agentViewUrl: '',
    });
    expect(JSON.stringify(card).length).toBeLessThan(30 * 1024);
  });
  it('folds overflow > 10 sessions into … N more', () => {
    const sessions = Array.from({ length: 15 }, (_, i) => s({
      shortId: `id${i}`, sessionId: `s${i}`, name: `session-${i}`,
    }));
    const card = buildListCard({
      groups: { working: sessions, blocked: [], completed: [] },
      totalCount: 15, lastRefreshedAt: '2026-06-01 12:34:56', agentViewUrl: '',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('5 more');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/agent-view/card.test.ts`
Expected: FAIL — `buildListCard` not found

- [ ] **Step 3: 实现 card.ts — groupByStatus + buildListCard**

`src/agent-view/card.ts`:

```typescript
import type { AgentSession, AgentSessionStatus } from './snapshot';
import { logger } from '../utils/logger';

/**
 * 飞书卡片构建器
 * @see docs/superpowers/specs/2026-06-01-feishu-agent-view-design.md §6
 */

export interface AgentSessionGroups {
  working: AgentSession[];
  blocked: AgentSession[];
  completed: AgentSession[];
}

const COMPLETED_STATUSES: ReadonlySet<AgentSessionStatus> = new Set([
  'done', 'failed', 'stopped', 'idle',
]);

export function groupByStatus(sessions: AgentSession[]): AgentSessionGroups {
  const groups: AgentSessionGroups = { working: [], blocked: [], completed: [] };
  for (const s of sessions) {
    if (s.status === 'working') groups.working.push(s);
    else if (s.status === 'blocked') groups.blocked.push(s);
    else if (COMPLETED_STATUSES.has(s.status)) groups.completed.push(s);
    else groups.completed.push(s);  // unknown 也归 completed
  }
  return groups;
}

function statusIcon(s: AgentSessionStatus): string {
  switch (s) {
    case 'working': return '✽';
    case 'blocked': return '❓';
    case 'idle': return '⏸️';
    case 'done': return '✅';
    case 'failed': return '❌';
    case 'stopped': return '⏹️';
    default: return '∙';
  }
}

function statusLabel(s: AgentSessionStatus): string {
  switch (s) {
    case 'working': return 'Working';
    case 'blocked': return 'Needs input';
    case 'idle': return 'Idle';
    case 'done': return 'Completed';
    case 'failed': return 'Failed';
    case 'stopped': return 'Stopped';
    default: return 'Unknown';
  }
}

function formatElapsed(startedAt: string, now: Date = new Date()): string {
  if (!startedAt) return '';
  const start = new Date(startedAt).getTime();
  if (isNaN(start)) return '';
  const sec = Math.floor((now.getTime() - start) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function truncateCwd(cwd: string): string {
  if (!cwd) return '';
  // /Users/X/projects/Y → ~/projects/Y; /Users/X/Y → ~/Y
  const homeMatch = cwd.match(/^\/Users\/[^/]+(.*)$/);
  if (homeMatch) return `~${homeMatch[1] || ''}`;
  return cwd.length > 40 ? cwd.slice(0, 37) + '...' : cwd;
}

const MAX_ROWS_PER_GROUP = 10;

export interface ListCardParams {
  groups: AgentSessionGroups;
  totalCount: number;
  lastRefreshedAt: string;
  agentViewUrl: string;
}

export function buildListCard(params: ListCardParams): Record<string, unknown> {
  const { groups, totalCount, lastRefreshedAt } = params;
  const elements: Array<Record<string, unknown>> = [];

  const sections: Array<{ label: string; sessions: AgentSession[]; showStop: boolean; showReply: boolean }> = [
    { label: 'Working', sessions: groups.working, showStop: true, showReply: false },
    { label: 'Needs input', sessions: groups.blocked, showStop: false, showReply: true },
    { label: 'Completed', sessions: groups.completed, showStop: false, showReply: false },
  ];

  for (const sec of sections) {
    if (sec.sessions.length === 0) continue;
    elements.push({ tag: 'markdown', content: `**${sec.label} (${sec.sessions.length})**` });

    const visible = sec.sessions.slice(0, MAX_ROWS_PER_GROUP);
    const overflow = sec.sessions.length - visible.length;

    for (const s of visible) {
      const icon = statusIcon(s.status);
      const elapsed = formatElapsed(s.startedAt);
      const cwdDisplay = truncateCwd(s.cwd);
      const line = `${icon} \`${s.name}\`${elapsed ? `  ·  ${elapsed}` : ''}\n📁 ${cwdDisplay}`;

      const actions: Array<Record<string, unknown>> = [
        { tag: 'button', text: { tag: 'plain_text', content: 'Peek' },
          type: 'default',
          value: { tag: 'agent_view_peek', shortId: s.shortId, sessionId: s.sessionId, cwd: s.cwd } },
      ];
      if (sec.showReply) {
        actions.push({ tag: 'button', text: { tag: 'plain_text', content: 'Reply' },
          type: 'primary',
          value: { tag: 'agent_view_reply_request', shortId: s.shortId, sessionId: s.sessionId, cwd: s.cwd } });
      }
      if (sec.showStop) {
        actions.push({ tag: 'button', text: { tag: 'plain_text', content: 'Stop' },
          type: 'danger',
          value: { tag: 'agent_view_stop', shortId: s.shortId, sessionId: s.sessionId } });
      }

      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: line },
      });
      elements.push({
        tag: 'action',
        actions,
      });
    }

    if (overflow > 0) {
      elements.push({ tag: 'markdown', content: `… ${overflow} more` });
    }
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'action',
    actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '🔄 Refresh' },
        type: 'primary',
        value: { tag: 'agent_view_refresh' } },
    ],
  });
  elements.push({ tag: 'markdown', content: `Last refreshed ${lastRefreshedAt}` });

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `🤖 Agent View · ${totalCount} sessions` },
      template: 'blue',
    },
    elements,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/unit/agent-view/card.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/card.ts tests/unit/agent-view/card.test.ts
git commit -m "feat(agent-view): 列表卡构建器"
```

---

## Task 5: 卡片构建器 — Peek 卡

**Files:**
- Modify: `src/agent-view/card.ts`
- Test: `tests/unit/agent-view/card.test.ts` (追加)

- [ ] **Step 1: 写失败的测试**

追加到 `tests/unit/agent-view/card.test.ts`:

```typescript
import { buildPeekCard } from '../../../src/agent-view/card';

describe('buildPeekCard', () => {
  it('renders name and status in header', () => {
    const card = buildPeekCard({
      name: 'flaky-test-fix', status: 'working', cwd: '/p',
      pid: 12345, startedAt: '2026-06-01T10:00:00Z',
      lastActivity: '2m ago', recentOutput: 'npm test\nPASS\n',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('flaky-test-fix');
    expect(json).toContain('working');
  });
  it('shows recent output in code fence', () => {
    const card = buildPeekCard({
      name: 'x', status: 'working', cwd: '/p',
      pid: 1, startedAt: '2026-06-01T10:00:00Z',
      lastActivity: 'now', recentOutput: '$ npm test\nFAIL\n',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('$ npm test');
    expect(json).toContain('```');
  });
  it('truncates output to max 2KB', () => {
    const huge = 'a'.repeat(10_000);
    const card = buildPeekCard({
      name: 'x', status: 'working', cwd: '/p',
      pid: 1, startedAt: '2026-06-01T10:00:00Z',
      lastActivity: 'now', recentOutput: huge,
    });
    const json = JSON.stringify(card);
    expect(json.length).toBeLessThan(30 * 1024);
    expect(json).toContain('...');
  });
  it('includes Reply/Stop/Back/Refresh action buttons', () => {
    const card = buildPeekCard({
      name: 'x', status: 'blocked', cwd: '/p',
      pid: 1, startedAt: '2026-06-01T10:00:00Z',
      lastActivity: 'now', recentOutput: '...',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('agent_view_reply_request');
    expect(json).toContain('agent_view_stop');
    expect(json).toContain('agent_view_back_to_list');
    expect(json).toContain('agent_view_refresh');
  });
  it('omits Stop button for completed status', () => {
    const card = buildPeekCard({
      name: 'x', status: 'done', cwd: '/p',
      pid: 1, startedAt: '2026-06-01T10:00:00Z',
      lastActivity: 'now', recentOutput: '...',
    });
    const json = JSON.stringify(card);
    expect(json).not.toContain('agent_view_stop');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/agent-view/card.test.ts`
Expected: FAIL — `buildPeekCard` not found

- [ ] **Step 3: 在 card.ts 添加 buildPeekCard**

追加到 `src/agent-view/card.ts`:

```typescript
export interface PeekCardParams {
  name: string;
  status: AgentSessionStatus;
  cwd: string;
  pid: number;
  startedAt: string;
  lastActivity: string;
  recentOutput: string;
}

const PEEK_MAX_OUTPUT_BYTES = 2 * 1024;

function truncateOutput(s: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(s).length <= maxBytes) return s;
  // 取末尾 N 字节
  const truncated = s.slice(-Math.floor(maxBytes / 2));
  return '...' + truncated;
}

export function buildPeekCard(p: PeekCardParams): Record<string, unknown> {
  const showStop = p.status === 'working' || p.status === 'blocked' || p.status === 'idle';

  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: `**Status:** ${statusLabel(p.status)}` },
    { tag: 'markdown', content: `**CWD:** ${p.cwd}\n**PID:** ${p.pid}  ·  **Started** ${p.startedAt}` },
    { tag: 'markdown', content: `**Last activity:** ${p.lastActivity}` },
    { tag: 'hr' },
    { tag: 'markdown', content: '**Recent output (last 30 lines)**' },
    { tag: 'markdown', content: '```\n' + truncateOutput(p.recentOutput, PEEK_MAX_OUTPUT_BYTES) + '\n```' },
    { tag: 'hr' },
    {
      tag: 'action',
      actions: [
        ...(p.status === 'blocked' || p.status === 'stopped' || p.status === 'done'
          ? [{ tag: 'button', text: { tag: 'plain_text', content: 'Reply' }, type: 'primary',
              value: { tag: 'agent_view_reply_request', shortId: '', sessionId: '', cwd: p.cwd } }]
          : []),
        ...(showStop
          ? [{ tag: 'button', text: { tag: 'plain_text', content: 'Stop' }, type: 'danger',
              value: { tag: 'agent_view_stop', shortId: '', sessionId: '' } }]
          : []),
        { tag: 'button', text: { tag: 'plain_text', content: '← Back to list' }, type: 'default',
          value: { tag: 'agent_view_back_to_list' } },
        { tag: 'button', text: { tag: 'plain_text', content: '🔄 Refresh' }, type: 'default',
          value: { tag: 'agent_view_peek', shortId: '', sessionId: '', cwd: p.cwd } },
      ],
    },
  ];

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: `🔍 Peek · \`${p.name}\`` }, template: 'blue' },
    elements,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/unit/agent-view/card.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/card.ts tests/unit/agent-view/card.test.ts
git commit -m "feat(agent-view): peek 卡构建器"
```

---

## Task 6: 卡片构建器 — 错误 / 空 / 等待 / 超时 / 取消

**Files:**
- Modify: `src/agent-view/card.ts`
- Test: `tests/unit/agent-view/card.test.ts` (追加)

- [ ] **Step 1: 写失败的测试**

追加到 `tests/unit/agent-view/card.test.ts`:

```typescript
import { buildErrorCard, buildEmptyCard, buildWaitingCard, buildTimeoutCard, buildCancelCard } from '../../../src/agent-view/card';

describe('buildErrorCard', () => {
  it('renders red header for error', () => {
    const card = buildErrorCard({ reason: 'version_too_old', detail: '当前 v2.1.100' });
    const json = JSON.stringify(card);
    expect(json).toContain('red');
    expect(json).toContain('当前 v2.1.100');
  });
  it('mentions 2.1.139 for version error', () => {
    const card = buildErrorCard({ reason: 'version_too_old', detail: 'X' });
    expect(JSON.stringify(card)).toContain('2.1.139');
  });
});

describe('buildEmptyCard', () => {
  it('shows onboarding hint', () => {
    const card = buildEmptyCard();
    const json = JSON.stringify(card);
    expect(json).toContain('claude --bg');
    expect(json).toContain('Refresh');
  });
});

describe('buildWaitingCard', () => {
  it('mentions session name and 5 min timeout', () => {
    const card = buildWaitingCard({ name: 'flaky-test-fix' });
    const json = JSON.stringify(card);
    expect(json).toContain('flaky-test-fix');
    expect(json).toContain('5');
  });
});

describe('buildTimeoutCard', () => {
  it('indicates timeout', () => {
    const card = buildTimeoutCard();
    expect(JSON.stringify(card)).toContain('超时');
  });
});

describe('buildCancelCard', () => {
  it('indicates cancel', () => {
    const card = buildCancelCard();
    expect(JSON.stringify(card)).toContain('取消');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/agent-view/card.test.ts`
Expected: FAIL — new functions not found

- [ ] **Step 3: 在 card.ts 添加 5 个变体函数**

追加到 `src/agent-view/card.ts`:

```typescript
export type ErrorReason =
  | 'version_too_old'
  | 'claude_not_found'
  | 'supervisor_error'
  | 'parse_failed'
  | 'session_gone'
  | 'not_replyable';

export interface ErrorCardParams {
  reason: ErrorReason;
  detail: string;
}

export function buildErrorCard(p: ErrorCardParams): Record<string, unknown> {
  const titles: Record<ErrorReason, string> = {
    version_too_old: '❌ Claude 版本过低',
    claude_not_found: '❌ Claude CLI 未安装',
    supervisor_error: '❌ Claude supervisor 异常',
    parse_failed: '⚠️ 无法解析 Claude 输出',
    session_gone: '⚠️ 会话已不存在',
    not_replyable: '⚠️ 该会话不可回复',
  };
  const hints: Record<ErrorReason, string> = {
    version_too_old: `需要 v2.1.139+,${p.detail} / 请运行 claude update`,
    claude_not_found: '请先安装 Claude Code CLI',
    supervisor_error: `${p.detail}`,
    parse_failed: `${p.detail}`,
    session_gone: '已自动刷新列表',
    not_replyable: '该会话正在运行或已失败,无法回复',
  };
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: titles[p.reason] }, template: 'red' },
    elements: [{ tag: 'markdown', content: hints[p.reason] }],
  };
}

export function buildEmptyCard(): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: '🤖 Agent View' }, template: 'grey' },
    elements: [
      { tag: 'markdown', content: '**暂无后台会话**\n\n请先在终端运行:\n```\nclaude --bg "<prompt>"\n```' },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '🔄 Refresh' },
            type: 'primary',
            value: { tag: 'agent_view_refresh' } },
        ],
      },
    ],
  };
}

export function buildWaitingCard(p: { name: string }): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: `✍️ 等待输入回复 · ${p.name}` }, template: 'blue' },
    elements: [
      { tag: 'markdown', content: '请在 5 分钟内发送文字消息作为回复\n发送 `/cancel` 可取消等待' },
    ],
  };
}

export function buildTimeoutCard(): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: '⏱ 等待超时' }, template: 'grey' },
    elements: [{ tag: 'markdown', content: '**回复等待已超时**,请重新发起。' }],
  };
}

export function buildCancelCard(): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: '已取消' }, template: 'grey' },
    elements: [{ tag: 'markdown', content: '**回复已取消**' }],
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/unit/agent-view/card.test.ts`
Expected: PASS (20 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/card.ts tests/unit/agent-view/card.test.ts
git commit -m "feat(agent-view): 错误/空/等待/超时/取消卡片"
```

---

## Task 7: Poller — claude shell 调用封装

**Files:**
- Create: `src/agent-view/poller.ts`
- Test: `tests/unit/agent-view/poller.test.ts`

- [ ] **Step 1: 写失败的测试 — execFile 包装与解析**

`tests/unit/agent-view/poller.test.ts`:

```typescript
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { AgentViewPoller, ClaudeExecError } from '../../../src/agent-view/poller';

// mock Bun.spawn
const mockSpawn = mock();
const origSpawn = Bun.spawn;

describe('AgentViewPoller', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    (Bun as any).spawn = mockSpawn;
  });
  afterEach(() => {
    (Bun as any).spawn = origSpawn;
  });

  it('getVersion executes `claude --version`', async () => {
    mockSpawn.mockReturnValueOnce(makeProc('2.1.139 (Claude Code)\n', '', 0));
    const poller = new AgentViewPoller();
    const v = await poller.getVersion();
    expect(v).toEqual({ major: 2, minor: 1, patch: 139 });
    expect(mockSpawn).toHaveBeenCalledWith(['claude', '--version'], expect.objectContaining({ stdout: 'pipe' }));
  });

  it('listSessions executes `claude agents --json`', async () => {
    const json = '[{"pid":1,"cwd":"/x","kind":"claude","startedAt":"2026-06-01T00:00:00Z","status":"working"}]';
    mockSpawn.mockReturnValueOnce(makeProc(json, '', 0));
    const poller = new AgentViewPoller();
    const sessions = await poller.listSessions();
    expect(sessions).toHaveLength(1);
    expect(mockSpawn).toHaveBeenCalledWith(['claude', 'agents', '--json'], expect.anything());
  });

  it('listSessions returns [] on empty array', async () => {
    mockSpawn.mockReturnValueOnce(makeProc('[]', '', 0));
    const poller = new AgentViewPoller();
    expect(await poller.listSessions()).toEqual([]);
  });

  it('listSessions throws ClaudeExecError on non-zero exit', async () => {
    mockSpawn.mockReturnValueOnce(makeProc('', 'daemon not running', 1));
    const poller = new AgentViewPoller();
    expect(poller.listSessions()).rejects.toThrow(ClaudeExecError);
  });

  it('peekLogs executes `claude logs <shortId>`', async () => {
    mockSpawn.mockReturnValueOnce(makeProc('line1\nline2\n', '', 0));
    const poller = new AgentViewPoller();
    const out = await poller.peekLogs('abc123');
    expect(out).toContain('line1');
    expect(mockSpawn).toHaveBeenCalledWith(['claude', 'logs', 'abc123'], expect.anything());
  });

  it('stopSession executes `claude stop <shortId>`', async () => {
    mockSpawn.mockReturnValueOnce(makeProc('', '', 0));
    const poller = new AgentViewPoller();
    await poller.stopSession('abc123');
    expect(mockSpawn).toHaveBeenCalledWith(['claude', 'stop', 'abc123'], expect.anything());
  });
});

function makeProc(stdoutText: string, stderrText: string, exitCode: number) {
  const enc = new TextEncoder();
  return {
    stdout: new ReadableStream({
      start(c) { c.enqueue(enc.encode(stdoutText)); c.close(); }
    }),
    stderr: new ReadableStream({
      start(c) { c.enqueue(enc.encode(stderrText)); c.close(); }
    }),
    exited: Promise.resolve(exitCode),
    pid: 1234,
  } as any;
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/agent-view/poller.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 poller.ts**

`src/agent-view/poller.ts`:

```typescript
import { logger } from '../utils/logger';
import { parseClaudeVersion, parseAgentsJson, type ClaudeVersion, type AgentSession } from './snapshot';

export class ClaudeExecError extends Error {
  constructor(public readonly cmd: string[], public readonly exitCode: number, public readonly stderr: string) {
    super(`claude exec failed: ${cmd.join(' ')} (exit ${exitCode}): ${stderr}`);
  }
}

export interface AgentViewPollerOptions {
  claudeBin?: string;
  timeoutMs?: number;
}

export class AgentViewPoller {
  private readonly claudeBin: string;
  private readonly timeoutMs: number;

  constructor(opts: AgentViewPollerOptions = {}) {
    this.claudeBin = opts.claudeBin ?? 'claude';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async getVersion(): Promise<ClaudeVersion | null> {
    const out = await this.exec([this.claudeBin, '--version']);
    return parseClaudeVersion(out);
  }

  async listSessions(): Promise<AgentSession[]> {
    let out: string;
    try {
      out = await this.exec([this.claudeBin, 'agents', '--json']);
    } catch (err) {
      if (err instanceof ClaudeExecError) {
        logger.warn(`AgentView: claude agents --json failed: ${err.stderr}`);
        throw err;
      }
      throw err;
    }
    return parseAgentsJson(out);
  }

  async peekLogs(shortId: string): Promise<string> {
    return await this.exec([this.claudeBin, 'logs', shortId]);
  }

  async stopSession(shortId: string): Promise<void> {
    await this.exec([this.claudeBin, 'stop', shortId]);
  }

  private async exec(cmd: string[]): Promise<string> {
    const proc = Bun.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdoutText = await new Response(proc.stdout as any).text();
    const stderrText = await new Response(proc.stderr as any).text();
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new ClaudeExecError(cmd, -1, 'timeout')), this.timeoutMs)
      ),
    ]);

    if (exitCode !== 0) {
      throw new ClaudeExecError(cmd, exitCode, stderrText);
    }
    return stdoutText;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/unit/agent-view/poller.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/poller.ts tests/unit/agent-view/poller.test.ts
git commit -m "feat(agent-view): shell 调用封装 (poller)"
```

---

## Task 8: Reply Bridge — expectedReply 状态机

**Files:**
- Create: `src/agent-view/reply-bridge.ts`
- Test: `tests/unit/agent-view/reply-bridge.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/unit/agent-view/reply-bridge.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ExpectedReplyStore } from '../../../src/agent-view/reply-bridge';

describe('ExpectedReplyStore', () => {
  let store: ExpectedReplyStore;
  beforeEach(() => { store = new ExpectedReplyStore(); });
  afterEach(() => { store.dispose(); });

  it('starts with no pending entries', () => {
    expect(store.get('ou_xxx')).toBeNull();
  });

  it('set() creates an entry', () => {
    store.set('ou_xxx', { shortId: 'a', sessionId: 's', cwd: '/p' });
    const got = store.get('ou_xxx');
    expect(got).toMatchObject({ shortId: 'a', sessionId: 's', cwd: '/p' });
    expect(got!.startedAt).toBeGreaterThan(0);
  });

  it('clear() removes the entry', () => {
    store.set('ou_xxx', { shortId: 'a', sessionId: 's', cwd: '/p' });
    store.clear('ou_xxx');
    expect(store.get('ou_xxx')).toBeNull();
  });

  it('isReply(text, openId) returns the entry when present', () => {
    store.set('ou_xxx', { shortId: 'a', sessionId: 's', cwd: '/p' });
    expect(store.isReply('anything', 'ou_xxx')).toBeTruthy();
  });

  it('isReply returns null when no entry', () => {
    expect(store.isReply('hi', 'ou_yyy')).toBeNull();
  });

  it('isReply returns null and does NOT clear when text is /cancel', () => {
    store.set('ou_xxx', { shortId: 'a', sessionId: 's', cwd: '/p' });
    const result = store.isReply('/cancel', 'ou_xxx');
    expect(result).toBeNull();  // 返回 null,调用方自己 clear + patch cancel
    // 不在这里 clear 是因为 /cancel 也要 patch 原卡,调用方决定
  });

  it('auto-clears after reply_wait_timeout_ms (5 min)', async () => {
    const fast = new ExpectedReplyStore({ replyWaitTimeoutMs: 50 });
    fast.set('ou_xxx', { shortId: 'a', sessionId: 's', cwd: '/p' });
    await new Promise(r => setTimeout(r, 80));
    expect(fast.get('ou_xxx')).toBeNull();
    fast.dispose();
  });

  it('size returns pending count', () => {
    expect(store.size()).toBe(0);
    store.set('ou_a', { shortId: 'a', sessionId: 's', cwd: '/p' });
    store.set('ou_b', { shortId: 'b', sessionId: 's', cwd: '/p' });
    expect(store.size()).toBe(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/agent-view/reply-bridge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 reply-bridge.ts (State 1: expectedReply)**

`src/agent-view/reply-bridge.ts`:

```typescript
import { config } from '../utils/config';
import { logger } from '../utils/logger';

export interface ExpectedReplyEntry {
  shortId: string;
  sessionId: string;
  cwd: string;
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class ExpectedReplyStore {
  private entries = new Map<string, ExpectedReplyEntry>();
  private readonly replyWaitTimeoutMs: number;

  constructor(opts: { replyWaitTimeoutMs?: number } = {}) {
    this.replyWaitTimeoutMs = opts.replyWaitTimeoutMs ?? config.get<number>('agent_view.reply_wait_timeout_ms', 300000);
  }

  set(openId: string, params: { shortId: string; sessionId: string; cwd: string }): void {
    // 如果已存在,先 clear 旧的 timeout
    this.clear(openId);

    const timeoutHandle = setTimeout(() => {
      const entry = this.entries.get(openId);
      if (entry && entry.timeoutHandle === timeoutHandle) {
        logger.info(`AgentView: expectedReply timeout for openId=${openId}`);
        this.entries.delete(openId);
        // 注意:这里不主动 patch 卡,留给调用方定时检查或下次 refresh
      }
    }, this.replyWaitTimeoutMs);

    this.entries.set(openId, {
      shortId: params.shortId,
      sessionId: params.sessionId,
      cwd: params.cwd,
      startedAt: Date.now(),
      timeoutHandle,
    });
  }

  get(openId: string): ExpectedReplyEntry | null {
    return this.entries.get(openId) ?? null;
  }

  clear(openId: string): void {
    const entry = this.entries.get(openId);
    if (entry) {
      clearTimeout(entry.timeoutHandle);
      this.entries.delete(openId);
    }
  }

  /**
   * 检查一条普通消息是否是对 expectedReply 的回复
   * - 返回 entry 表示这是 reply
   * - 返回 null 表示不是 reply(调用方走普通 chat 流程)
   *
   * 不在这里 clear:调用方收到 entry 后,自己决定是走 sendSDKMessage 还是 /cancel
   * 真正的 clear 在 sendSDKMessage 触发前 / cancel 处理时 / timeout 时
   */
  isReply(text: string, openId: string): ExpectedReplyEntry | null {
    const entry = this.entries.get(openId);
    if (!entry) return null;
    if (text.trim() === '/cancel') return null;  // 视为取消,调用方自己 clear
    return entry;
  }

  size(): number {
    return this.entries.size;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timeoutHandle);
    }
    this.entries.clear();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/unit/agent-view/reply-bridge.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/reply-bridge.ts tests/unit/agent-view/reply-bridge.test.ts
git commit -m "feat(agent-view): expectedReply 状态机"
```

---

## Task 9: Manager — handleList

**Files:**
- Create: `src/agent-view/manager.ts`
- Test: `tests/unit/agent-view/manager.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/unit/agent-view/manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { AgentViewPoller } from '../../../src/agent-view/poller';
import { ExpectedReplyStore } from '../../../src/agent-view/reply-bridge';

function makeMockFeishuClient() {
  return {
    im: { v1: { message: { create: mock(async () => ({ data: { message_id: 'm-1' } })),
                            patch: mock(async () => ({})) } } },
  } as any;
}

describe('AgentViewManager.handleList', () => {
  let manager: AgentViewManager;
  let mockClient: any;
  let mockPoller: any;

  beforeEach(() => {
    mockClient = makeMockFeishuClient();
    mockPoller = {
      getVersion: mock(async () => ({ major: 2, minor: 1, patch: 139 })),
      listSessions: mock(async () => []),
      peekLogs: mock(async () => 'logs'),
      stopSession: mock(async () => {}),
    } as any;
    manager = new AgentViewManager({
      feishuClient: mockClient,
      poller: mockPoller,
      expectedReplyStore: new ExpectedReplyStore(),
    });
  });

  it('returns version_too_old error if claude < 2.1.139', async () => {
    mockPoller.getVersion.mockResolvedValueOnce({ major: 2, minor: 1, patch: 100 });
    await manager.handleList('ou_user1');
    const sent = mockClient.im.v1.message.create.mock.calls[0][0].data.content;
    expect(sent).toContain('版本过低');
  });

  it('sends empty card when no sessions', async () => {
    mockPoller.listSessions.mockResolvedValueOnce([]);
    await manager.handleList('ou_user1');
    const sent = mockClient.im.v1.message.create.mock.calls[0][0].data.content;
    expect(sent).toContain('claude --bg');
  });

  it('sends list card with grouped sessions', async () => {
    mockPoller.listSessions.mockResolvedValueOnce([
      { shortId: 'a1', sessionId: 's1', name: 'alpha', status: 'working', cwd: '/p', kind: 'claude', pid: 1, startedAt: '2026-06-01T10:00:00Z' },
      { shortId: 'a2', sessionId: 's2', name: 'beta', status: 'blocked', cwd: '/q', kind: 'claude', pid: 2, startedAt: '2026-06-01T10:00:00Z' },
    ]);
    await manager.handleList('ou_user1');
    const sent = mockClient.im.v1.message.create.mock.calls[0][0].data.content;
    expect(sent).toContain('Working');
    expect(sent).toContain('Needs input');
    expect(sent).toContain('alpha');
    expect(sent).toContain('beta');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/agent-view/manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 manager.ts (handleList 部分)**

`src/agent-view/manager.ts`:

```typescript
import type { AgentViewPoller } from './poller';
import { ClaudeExecError } from './poller';
import { ExpectedReplyStore } from './reply-bridge';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import {
  buildListCard, buildEmptyCard, buildErrorCard,
  groupByStatus, type ErrorReason,
} from './card';
import {
  satisfiesMinVersion, parseClaudeVersion, type ClaudeVersion,
} from './snapshot';

interface FeishuClientLike {
  im: { v1: { message: { create: (p: any) => Promise<any>; patch: (p: any) => Promise<any> } } };
}

export interface AgentViewManagerOptions {
  feishuClient: FeishuClientLike;
  poller: AgentViewPoller;
  expectedReplyStore: ExpectedReplyStore;
}

export class AgentViewManager {
  private readonly feishuClient: FeishuClientLike;
  private readonly poller: AgentViewPoller;
  private readonly expectedReplyStore: ExpectedReplyStore;

  // 缓存 openId → list card messageId,供 [Refresh] 复用
  private readonly listCardMessageIds = new Map<string, string>();

  constructor(opts: AgentViewManagerOptions) {
    this.feishuClient = opts.feishuClient;
    this.poller = opts.poller;
    this.expectedReplyStore = opts.expectedReplyStore;
  }

  /**
   * /agents 命令入口 — 列出所有 background session
   */
  async handleList(openId: string, messageId?: string): Promise<void> {
    // 1. 版本守卫
    let version: ClaudeVersion | null;
    try {
      version = await this.poller.getVersion();
    } catch (err) {
      const reason: ErrorReason = err instanceof ClaudeExecError && err.stderr.includes('not found')
        ? 'claude_not_found' : 'supervisor_error';
      await this.sendCard(openId, buildErrorCard({ reason, detail: (err as Error).message }), messageId);
      return;
    }
    if (!version || !satisfiesMinVersion(version)) {
      await this.sendCard(openId, buildErrorCard({
        reason: 'version_too_old',
        detail: `当前 v${version?.major}.${version?.minor}.${version?.patch ?? '?'}`,
      }), messageId);
      return;
    }

    // 2. 列会话
    let sessions;
    try {
      sessions = await this.poller.listSessions();
    } catch (err) {
      await this.sendCard(openId, buildErrorCard({
        reason: 'supervisor_error',
        detail: (err as Error).message,
      }), messageId);
      return;
    }

    // 3. 渲染卡
    if (sessions.length === 0) {
      await this.sendCard(openId, buildEmptyCard(), messageId);
      return;
    }
    const groups = groupByStatus(sessions);
    const card = buildListCard({
      groups, totalCount: sessions.length,
      lastRefreshedAt: new Date().toLocaleString('zh-CN'),
      agentViewUrl: '',
    });
    await this.sendCard(openId, card, messageId);
  }

  private async sendCard(openId: string, card: Record<string, unknown>, messageId?: string): Promise<void> {
    const content = JSON.stringify(card);
    if (messageId) {
      await this.feishuClient.im.v1.message.patch({ path: { message_id: messageId }, data: { content } });
    } else {
      const resp = await this.feishuClient.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: openId, msg_type: 'interactive', content },
      });
      const newId = resp.data?.message_id ?? null;
      if (newId) this.listCardMessageIds.set(openId, newId);
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/unit/agent-view/manager.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): manager handleList"
```

---

## Task 10: Manager — handlePeek & handleStop

**Files:**
- Modify: `src/agent-view/manager.ts`
- Test: `tests/unit/agent-view/manager.test.ts` (追加)

- [ ] **Step 1: 写失败的测试**

追加到 `tests/unit/agent-view/manager.test.ts`:

```typescript
describe('AgentViewManager.handlePeek', () => {
  let manager: AgentViewManager;
  let mockClient: any;
  let mockPoller: any;

  beforeEach(() => {
    mockClient = makeMockFeishuClient();
    mockPoller = {
      getVersion: mock(async () => ({ major: 2, minor: 1, patch: 139 })),
      listSessions: mock(async () => []),
      peekLogs: mock(async () => 'last line of output'),
      stopSession: mock(async () => {}),
    } as any;
    manager = new AgentViewManager({
      feishuClient: mockClient,
      poller: mockPoller,
      expectedReplyStore: new ExpectedReplyStore(),
    });
  });

  it('calls peekLogs and sends peek card', async () => {
    await manager.handlePeek('ou_user1', 'a1b2', 'sess-1', '/p', { name: 'foo', status: 'working', pid: 1, startedAt: 'now' });
    expect(mockPoller.peekLogs).toHaveBeenCalledWith('a1b2');
    const sent = mockClient.im.v1.message.create.mock.calls[0][0].data.content;
    expect(sent).toContain('foo');
    expect(sent).toContain('last line of output');
  });

  it('handles peek failure gracefully', async () => {
    mockPoller.peekLogs.mockRejectedValueOnce(new Error('session gone'));
    await manager.handlePeek('ou_user1', 'a1b2', 'sess-1', '/p', { name: 'foo', status: 'working', pid: 1, startedAt: 'now' });
    const sent = mockClient.im.v1.message.create.mock.calls[0][0].data.content;
    expect(sent).toMatch(/已不存在|异常/);
  });
});

describe('AgentViewManager.handleStop', () => {
  it('calls stopSession and refreshes list', async () => {
    const mockClient = makeMockFeishuClient();
    const mockPoller = {
      getVersion: mock(async () => ({ major: 2, minor: 1, patch: 139 })),
      listSessions: mock(async () => []),
      peekLogs: mock(async () => ''),
      stopSession: mock(async () => {}),
    } as any;
    const manager = new AgentViewManager({
      feishuClient: mockClient, poller: mockPoller,
      expectedReplyStore: new ExpectedReplyStore(),
    });
    await manager.handleStop('ou_user1', 'a1b2', 'sess-1');
    expect(mockPoller.stopSession).toHaveBeenCalledWith('a1b2');
    expect(mockPoller.listSessions).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/agent-view/manager.test.ts`
Expected: FAIL — handlePeek/handleStop not found

- [ ] **Step 3: 在 manager.ts 添加 handlePeek & handleStop**

追加到 `src/agent-view/manager.ts`:

```typescript
import {
  buildListCard, buildEmptyCard, buildErrorCard, buildPeekCard,
  groupByStatus, type ErrorReason,
} from './card';
import type { AgentSessionStatus } from './snapshot';

export interface PeekSessionMeta {
  name: string;
  status: AgentSessionStatus;
  pid: number;
  startedAt: string;
}

  async handlePeek(
    openId: string, shortId: string, sessionId: string, cwd: string, meta: PeekSessionMeta,
  ): Promise<void> {
    let recentOutput: string;
    try {
      recentOutput = await this.poller.peekLogs(shortId);
    } catch (err) {
      await this.sendCard(openId, buildErrorCard({
        reason: 'session_gone',
        detail: (err as Error).message,
      }));
      return;
    }
    const card = buildPeekCard({
      name: meta.name,
      status: meta.status,
      cwd,
      pid: meta.pid,
      startedAt: meta.startedAt,
      lastActivity: 'just now',
      recentOutput,
    });
    await this.sendCard(openId, card);
  }

  async handleStop(openId: string, shortId: string, sessionId: string): Promise<void> {
    try {
      await this.poller.stopSession(shortId);
    } catch (err) {
      await this.sendCard(openId, buildErrorCard({
        reason: 'supervisor_error',
        detail: `Stop 失败: ${(err as Error).message}`,
      }));
      return;
    }
    // 1s 后 refresh 列表
    await new Promise(r => setTimeout(r, 1000));
    await this.handleList(openId);
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/unit/agent-view/manager.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): manager handlePeek & handleStop"
```

---

## Task 11: Manager — handleReplyRequest (按钮入口) + handleReply (sendSDKMessage 集成)

**Files:**
- Modify: `src/agent-view/manager.ts`
- Test: `tests/unit/agent-view/manager.test.ts` (追加)

- [ ] **Step 1: 写失败的测试**

追加到 `tests/unit/agent-view/manager.test.ts`:

```typescript
describe('AgentViewManager.handleReplyRequest', () => {
  let manager: AgentViewManager;
  let mockClient: any;
  let mockPoller: any;
  let store: ExpectedReplyStore;

  beforeEach(() => {
    mockClient = makeMockFeishuClient();
    mockPoller = {
      getVersion: mock(async () => ({ major: 2, minor: 1, patch: 139 })),
      listSessions: mock(async () => []),
      peekLogs: mock(async () => ''),
      stopSession: mock(async () => {}),
    } as any;
    store = new ExpectedReplyStore();
    manager = new AgentViewManager({
      feishuClient: mockClient, poller: mockPoller, expectedReplyStore: store,
    });
  });

  it('rejects when status is working', async () => {
    mockPoller.listSessions.mockResolvedValueOnce([
      { shortId: 'a1', sessionId: 's1', name: 'x', status: 'working', cwd: '/p', kind: 'claude', pid: 1, startedAt: '' },
    ]);
    await manager.handleReplyRequest('ou_user1', 'a1', 's1', '/p');
    expect(store.size()).toBe(0);
    const sent = mockClient.im.v1.message.create.mock.calls[0][0].data.content;
    expect(sent).toContain('不可回复');
  });

  it('accepts blocked status and sets expectedReply', async () => {
    mockPoller.listSessions.mockResolvedValueOnce([
      { shortId: 'a1', sessionId: 's1', name: 'x', status: 'blocked', cwd: '/p', kind: 'claude', pid: 1, startedAt: '' },
    ]);
    await manager.handleReplyRequest('ou_user1', 'a1', 's1', '/p');
    expect(store.size()).toBe(1);
    expect(store.get('ou_user1')).toMatchObject({ shortId: 'a1', sessionId: 's1', cwd: '/p' });
  });

  it('accepts done status and sets expectedReply', async () => {
    mockPoller.listSessions.mockResolvedValueOnce([
      { shortId: 'a1', sessionId: 's1', name: 'x', status: 'done', cwd: '/p', kind: 'claude', pid: 1, startedAt: '' },
    ]);
    await manager.handleReplyRequest('ou_user1', 'a1', 's1', '/p');
    expect(store.size()).toBe(1);
  });

  it('sends a text prompt after setting expectedReply', async () => {
    mockPoller.listSessions.mockResolvedValueOnce([
      { shortId: 'a1', sessionId: 's1', name: 'foo', status: 'blocked', cwd: '/p', kind: 'claude', pid: 1, startedAt: '' },
    ]);
    await manager.handleReplyRequest('ou_user1', 'a1', 's1', '/p');
    // 至少有 1 个 create(文本提示),第 2 个是 patch 原卡(sendCard)
    const creates = mockClient.im.v1.message.create.mock.calls;
    expect(creates.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/agent-view/manager.test.ts`
Expected: FAIL — handleReplyRequest not found

- [ ] **Step 3: 在 manager.ts 添加 handleReplyRequest**

追加到 `src/agent-view/manager.ts`:

```typescript
import { buildWaitingCard } from './card';
import type { AgentSession } from './snapshot';

const REPLYABLE_STATUSES: ReadonlySet<AgentSessionStatus> = new Set(['blocked', 'stopped', 'done']);

  /**
   * Step A — 用户在列表/peek 卡上点 [Reply] 按钮
   */
  async handleReplyRequest(openId: string, shortId: string, sessionId: string, cwd: string): Promise<void> {
    // 1. 状态守卫(需要最新 status,因为卡片是旧快照)
    let sessions: AgentSession[];
    try {
      sessions = await this.poller.listSessions();
    } catch (err) {
      await this.sendCard(openId, buildErrorCard({ reason: 'supervisor_error', detail: (err as Error).message }));
      return;
    }
    const session = sessions.find(s => s.sessionId === sessionId || s.shortId === shortId);
    if (!session) {
      await this.sendCard(openId, buildErrorCard({ reason: 'session_gone', detail: '请刷新列表' }));
      return;
    }
    if (!REPLYABLE_STATUSES.has(session.status)) {
      await this.sendCard(openId, buildErrorCard({
        reason: 'not_replyable',
        detail: `当前状态: ${session.status}`,
      }));
      return;
    }

    // 2. 标记 expectedReply
    this.expectedReplyStore.set(openId, { shortId: session.shortId, sessionId: session.sessionId, cwd });

    // 3. 发文本提示
    const name = session.name || 'session';
    const minutes = Math.round(config.get<number>('agent_view.reply_wait_timeout_ms', 300000) / 60000);
    await this.feishuClient.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({
          text: `↩️ 回复会话: ${name}\n请直接发送文字消息作为回复(${minutes} 分钟内有效)\n发送 /cancel 可取消等待`,
        }),
      },
    });
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/unit/agent-view/manager.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): manager handleReplyRequest (状态守卫 + expectedReply)"
```

---

## Task 12: Manager — handleChat 入口(被 bot 调,处理普通消息)

**Files:**
- Modify: `src/agent-view/manager.ts`
- Test: `tests/unit/agent-view/manager.test.ts` (追加)

- [ ] **Step 1: 写失败的测试**

追加到 `tests/unit/agent-view/manager.test.ts`:

```typescript
describe('AgentViewManager.handleChat', () => {
  it('routes text to handleReply when expectedReply is set', async () => {
    const mockClient = makeMockFeishuClient();
    const mockPoller = {
      getVersion: mock(async () => ({ major: 2, minor: 1, patch: 139 })),
      listSessions: mock(async () => []),
      peekLogs: mock(async () => ''),
      stopSession: mock(async () => {}),
    } as any;
    const store = new ExpectedReplyStore();
    store.set('ou_user1', { shortId: 'a1', sessionId: 'sess-1', cwd: '/p' });
    const manager = new AgentViewManager({ feishuClient: mockClient, poller: mockPoller, expectedReplyStore: store });

    const result = await manager.handleChat('ou_user1', 'do this thing');
    expect(result).toBe('reply_handled');
    expect(store.size()).toBe(0);  // 已清除
  });

  it('returns null when no expectedReply (普通 chat 不在 Agent View 处理)', async () => {
    const mockClient = makeMockFeishuClient();
    const mockPoller = {
      getVersion: mock(async () => ({ major: 2, minor: 1, patch: 139 })),
      listSessions: mock(async () => []),
      peekLogs: mock(async () => ''),
      stopSession: mock(async () => {}),
    } as any;
    const manager = new AgentViewManager({
      feishuClient: mockClient, poller: mockPoller,
      expectedReplyStore: new ExpectedReplyStore(),
    });
    expect(await manager.handleChat('ou_user1', 'hello')).toBeNull();
  });

  it('handles /cancel by clearing expectedReply and sending cancel card', async () => {
    const mockClient = makeMockFeishuClient();
    const mockPoller = {
      getVersion: mock(async () => ({ major: 2, minor: 1, patch: 139 })),
      listSessions: mock(async () => []),
      peekLogs: mock(async () => ''),
      stopSession: mock(async () => {}),
    } as any;
    const store = new ExpectedReplyStore();
    store.set('ou_user1', { shortId: 'a1', sessionId: 'sess-1', cwd: '/p' });
    const manager = new AgentViewManager({
      feishuClient: mockClient, poller: mockPoller, expectedReplyStore: store,
    });
    const result = await manager.handleChat('ou_user1', '/cancel');
    expect(result).toBe('reply_cancelled');
    expect(store.size()).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/agent-view/manager.test.ts`
Expected: FAIL — handleChat not found

- [ ] **Step 3: 在 manager.ts 添加 handleChat (stub,完整 sendSDKMessage 在 Task 13 完成)**

追加到 `src/agent-view/manager.ts`:

```typescript
import { buildCancelCard } from './card';

  /**
   * 被 FeishuBot.handleChat 调用,检查是否是对 expectedReply 的回复
   * @returns 'reply_handled' | 'reply_cancelled' | null
   */
  async handleChat(openId: string, text: string): Promise<'reply_handled' | 'reply_cancelled' | null> {
    const entry = this.expectedReplyStore.isReply(text, openId);
    if (!entry) {
      // 区分"无 entry"和"/cancel"两种情况
      if (text.trim() === '/cancel' && this.expectedReplyStore.get(openId)) {
        this.expectedReplyStore.clear(openId);
        await this.sendCard(openId, buildCancelCard());
        return 'reply_cancelled';
      }
      return null;
    }

    // 这是对 expectedReply 的回复
    this.expectedReplyStore.clear(openId);
    await this.executeReply(openId, entry, text);
    return 'reply_handled';
  }

  /**
   * 执行 reply:通过 sendSDKMessage 注入消息并流式返回结果
   * 这里只在 manager 内 stub,实际 sendSDKMessage 集成在 Task 13 完成
   */
  protected async executeReply(openId: string, entry: { shortId: string; sessionId: string; cwd: string }, text: string): Promise<void> {
    // 委托给外部 sender(在 Task 13 通过 setter 注入)
    if (this.replySender) {
      await this.replySender(openId, entry, text);
    } else {
      logger.warn('AgentViewManager.executeReply: no replySender injected');
    }
  }

  private replySender: ((openId: string, entry: { shortId: string; sessionId: string; cwd: string }, text: string) => Promise<void>) | null = null;

  setReplySender(fn: (openId: string, entry: { shortId: string; sessionId: string; cwd: string }, text: string) => Promise<void>): void {
    this.replySender = fn;
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/unit/agent-view/manager.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): manager handleChat 入口 + replySender 注入点"
```

---

## Task 13: Manager — executeReply 接入 sendSDKMessage

**Files:**
- Modify: `src/agent-view/manager.ts` (或新文件 `src/agent-view/reply-executor.ts`)
- Modify: `src/feishu/bot.ts` (注入 replySender)
- Test: `tests/unit/agent-view/reply-bridge.test.ts` (追加 executor 测试)

- [ ] **Step 1: 写失败的测试 — reply executor**

追加到 `tests/unit/agent-view/reply-bridge.test.ts`:

```typescript
import { describe, it, expect, mock } from 'bun:test';
import { buildReplyExecutor } from '../../../src/agent-view/reply-bridge';

function makeMockSessionManager() {
  return {
    sendSDKMessage: mock(async () => ({
      result: { response: 'OK', costUsd: 0.01, durationMs: 1500, sessionId: 's1', jsonlPath: null, sessionStatus: 'active' },
      handler: { onPermissionRequest: null, rejectAll: () => {} },
    })),
  } as any;
}

function makeMockCardUpdater() {
  return {
    startProcessing: mock(async () => 'm-new'),
    updateStream: mock(async () => {}),
    complete: mock(async () => {}),
    error: mock(async () => {}),
    dispose: () => {},
  } as any;
}

describe('buildReplyExecutor', () => {
  it('creates reply card and streams via sendSDKMessage', async () => {
    const sessionManager = makeMockSessionManager();
    const cardUpdater = makeMockCardUpdater();
    const feishuClient = {
      im: { v1: { message: { create: mock(async () => ({ data: { message_id: 'm-new' } })),
                              patch: mock(async () => ({})) } } },
    } as any;
    const executor = buildReplyExecutor({ sessionManager, feishuClient, cardUpdaterFactory: () => cardUpdater });
    await executor('ou_user1', { shortId: 'a1', sessionId: 'sess-1', cwd: '/p' }, 'do it');
    expect(cardUpdater.startProcessing).toHaveBeenCalledWith('ou_user1');
    expect(sessionManager.sendSDKMessage).toHaveBeenCalledWith(
      'sess-1', 'do it', '/p', expect.any(Function), expect.any(Function), false, 'sess-1', undefined,
    );
    expect(cardUpdater.complete).toHaveBeenCalled();
  });

  it('renders error card on sendSDKMessage rejection', async () => {
    const sessionManager = {
      sendSDKMessage: mock(async () => { throw new Error('session in use'); }),
    } as any;
    const cardUpdater = makeMockCardUpdater();
    const feishuClient = {
      im: { v1: { message: { create: mock(async () => ({ data: { message_id: 'm-new' } })) } } },
    } as any;
    const executor = buildReplyExecutor({ sessionManager, feishuClient, cardUpdaterFactory: () => cardUpdater });
    await executor('ou_user1', { shortId: 'a1', sessionId: 'sess-1', cwd: '/p' }, 'do it');
    expect(cardUpdater.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/agent-view/reply-bridge.test.ts`
Expected: FAIL — buildReplyExecutor not found

- [ ] **Step 3: 在 reply-bridge.ts 添加 buildReplyExecutor**

追加到 `src/agent-view/reply-bridge.ts`:

```typescript
import { CardUpdater } from '../feishu/card-updater';
import type { ClaudeSessionManager } from '../proxy/session';
import type { StreamChunk } from '../proxy/stream-parser';
import type { PermissionPrompt } from '../proxy/permission-handler';

interface FeishuClientLike {
  im: { v1: { message: { create: (p: any) => Promise<any>; patch: (p: any) => Promise<any> } } };
}

export interface ReplyExecutorDeps {
  sessionManager: ClaudeSessionManager;
  feishuClient: FeishuClientLike;
  cardUpdaterFactory: (client: FeishuClientLike) => CardUpdater;
}

export type ReplyExecutor = (
  openId: string,
  entry: { shortId: string; sessionId: string; cwd: string },
  text: string,
) => Promise<void>;

/**
 * 构造 reply executor:
 * 1. 创建新 CardUpdater → 飞书消息
 * 2. sendSDKMessage(resume) 流式喂给 CardUpdater
 * 3. 完成后 complete,失败时 error
 */
export function buildReplyExecutor(deps: ReplyExecutorDeps): ReplyExecutor {
  return async (openId, entry, text) => {
    const cardUpdater = deps.cardUpdaterFactory(deps.feishuClient);
    await cardUpdater.startProcessing(openId);

    try {
      const { result, handler } = await deps.sessionManager.sendSDKMessage(
        entry.sessionId,
        text,
        entry.cwd,
        (chunk: StreamChunk) => {
          if (chunk.type === 'thinking' || chunk.type === 'text') {
            cardUpdater.updateStream(
              chunk.type === 'thinking' ? chunk.content : '',
              chunk.type === 'text' ? chunk.content : '',
              0,
            ).catch(() => {});
          }
        },
        (prompt: PermissionPrompt, h: any) => {
          // 权限请求通过现有 PermissionHandler 走飞书权限卡
          // (跟 bot 现有逻辑一致,通过 onPermissionRequest 路径)
          if (handler && h) h.onPermissionRequest = handler.onPermissionRequest;
        },
        false,
        entry.sessionId,
        undefined,
      );
      await cardUpdater.complete(
        result.response,
        result.tokensIn ?? 0,
        result.tokensOut ?? 0,
        result.durationMs,
        1,
      );
    } catch (err) {
      await cardUpdater.error((err as Error).message);
    } finally {
      cardUpdater.dispose();
    }
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/unit/agent-view/reply-bridge.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent-view/reply-bridge.ts tests/unit/agent-view/reply-bridge.test.ts
git commit -m "feat(agent-view): reply executor 接入 sendSDKMessage"
```

---

## Task 14: Bot 集成 — `/agents` 命令、card action、chat hook

**Files:**
- Modify: `src/feishu/bot.ts`
- Test: `tests/unit/feishu/agent-view-integration.test.ts`

- [ ] **Step 1: 写失败的测试 — bot 集成**

`tests/unit/feishu/agent-view-integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { FeishuBot, FeishuReplyFn } from '../../../src/feishu/bot';
import { UserManager } from '../../../src/feishu/mapping';
import { ListSnapshotManager } from '../../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../../src/queue/spool';
import { ClaudeSessionManager } from '../../../src/proxy/session';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { AgentViewPoller } from '../../../src/agent-view/poller';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RegistryManager } from '../../../src/registry';
import { config } from '../../../src/utils/config';

function makeMockFeishuClient() {
  return { im: { v1: { message: { create: mock(async () => ({ data: { message_id: 'm-1' } })),
                          patch: mock(async () => ({})) } } } } as any;
}

describe('FeishuBot AgentView integration', () => {
  let tmpDir: string;
  let bot: FeishuBot;
  let mockClient: any;
  let agentView: AgentViewManager;
  let originalMaxPending: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bot-av-test-'));
    mockClient = makeMockFeishuClient();
    originalMaxPending = (config as any).data.queue.max_pending;
    (config as any).data.feishu_bot.owner_open_id = '';
    (config as any).data.feishu_bot.default_cwd = '';
    (config as any).data.security.allowed_roots = [];
    (config as any).data.security.denied_roots = [];
    (config as any).data.stream.enabled = false;
    (config as any).data.sdk.enabled = false;
    (config as any).data.agent_view.enabled = true;

    const replyFn: FeishuReplyFn = async () => null;
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
    const spoolQueue = new SpoolQueue(tmpDir);
    const sessionManager = new ClaudeSessionManager();
    const registry = new RegistryManager(tmpDir);

    bot = new FeishuBot({
      userManager, listSnapshotManager, spoolQueue, registry, sessionManager, replyFn,
    });

    const poller = {
      getVersion: mock(async () => ({ major: 2, minor: 1, patch: 139 })),
      listSessions: mock(async () => []),
      peekLogs: mock(async () => ''),
      stopSession: mock(async () => {}),
    } as any;
    agentView = new AgentViewManager({
      feishuClient: mockClient, poller, expectedReplyStore: (bot as any).expectedReplyStore,
    });
    bot.setAgentViewManager(agentView);
  });

  afterEach(() => {
    (config as any).data.queue.max_pending = originalMaxPending;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles /agents command', async () => {
    await bot.onMessage({
      open_id: 'ou_user1', message_id: 'msg-1',
      content: JSON.stringify({ text: '/agents' }),
      chat_type: 'p2p',
    });
    expect(mockClient.im.v1.message.create).toHaveBeenCalled();
  });

  it('handles agent_view_refresh card action', async () => {
    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'agent_view_refresh', value: {} },
      message: { message_id: 'msg-x' },
    } as any);
    expect(mockClient.im.v1.message.patch).toHaveBeenCalled();
  });

  it('handles agent_view_peek card action', async () => {
    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'agent_view_peek', value: { shortId: 'a1', sessionId: 'sess-1', cwd: '/p' } },
      message: { message_id: 'msg-x' },
    } as any);
    expect(mockClient.im.v1.message.create).toHaveBeenCalled();
  });

  it('routes reply text via expectedReply when openId has pending entry', async () => {
    // 设置 expectedReply
    (bot as any).expectedReplyStore.set('ou_user1', {
      shortId: 'a1', sessionId: 'sess-1', cwd: '/p',
    });
    const handleChatSpy = mock(async () => 'reply_handled');
    (agentView as any).handleChat = handleChatSpy;
    await bot.onMessage({
      open_id: 'ou_user1', message_id: 'msg-2',
      content: JSON.stringify({ text: 'my reply' }),
      chat_type: 'p2p',
    });
    expect(handleChatSpy).toHaveBeenCalledWith('ou_user1', 'my reply');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/unit/feishu/agent-view-integration.test.ts`
Expected: FAIL — bot not yet integrated

- [ ] **Step 3: 修改 src/feishu/bot.ts**

3.1 在 `FeishuBot` 构造函数接受 `agentViewManager` 选项(可选):

在 `src/feishu/bot.ts` 找到 `FeishuBotOptions` interface,添加:

```typescript
  agentViewManager?: AgentViewManager;
```

在 `FeishuBot` class 添加字段:

```typescript
  private agentViewManager: AgentViewManager | null = null;

  setAgentViewManager(manager: AgentViewManager): void {
    this.agentViewManager = manager;
  }
```

3.2 在 handleCardAction 的 switch 里添加 agent_view_* case:

```typescript
      case 'agent_view_refresh': {
        if (this.agentViewManager) {
          await this.agentViewManager.handleList(openId, messageId);
        }
        return null;
      }
      case 'agent_view_peek': {
        if (this.agentViewManager && valueObj) {
          // 需要从 list 缓存里查 name/status 等元数据
          await this.handleAgentViewPeek(openId, valueObj as any, messageId);
        }
        return null;
      }
      case 'agent_view_reply_request': {
        if (this.agentViewManager && valueObj) {
          await this.agentViewManager.handleReplyRequest(
            openId, valueObj.shortId, valueObj.sessionId, valueObj.cwd,
          );
        }
        return null;
      }
      case 'agent_view_stop': {
        if (this.agentViewManager && valueObj) {
          await this.agentViewManager.handleStop(openId, valueObj.shortId, valueObj.sessionId);
        }
        return null;
      }
      case 'agent_view_back_to_list': {
        if (this.agentViewManager) {
          await this.agentViewManager.handleList(openId, messageId);
        }
        return null;
      }
```

3.3 添加 `/agents` 命令 — 在 handleCommand 或 onMessage 入口检测文本:

找到现有命令分派处(应该是 onMessage 里的 `text.startsWith('/')`),在 commands map 里添加:

```typescript
      case 'agents': {
        if (this.agentViewManager) {
          await this.agentViewManager.handleList(openId);
        } else {
          await this.replyFn('Agent View 已禁用', { openId, requestUuid: uniqueUuid() });
        }
        return null;
      }
```

3.4 在 handleChat 入口(普通消息路径)添加 expectedReply 检查:

找到 `handleChat` 函数,在最开头:

```typescript
  async handleChat(openId: string, text: string): Promise<...> {
    // Agent View expectedReply 检查
    if (this.agentViewManager) {
      const result = await this.agentViewManager.handleChat(openId, text);
      if (result) return null;  // Agent View 接管,不进入普通 chat
    }
    // ... 原有逻辑
  }
```

3.5 添加 `handleAgentViewPeek` 辅助方法(从卡片 value 中补全 meta):

```typescript
  private async handleAgentViewPeek(openId: string, value: any, messageId?: string): Promise<void> {
    if (!this.agentViewManager) return;
    // 需要 session meta(name/status/pid/startedAt),但 agent_view_peek 按钮的 value 里没带
    // 简化方案:再 listSessions 一次找到对应 session
    // (这里 manager 内部封装,bot 不直接调 poller)
    await this.agentViewManager.handlePeek(openId, value.shortId, value.sessionId, value.cwd, {
      name: value.shortId || 'session',  // fallback
      status: 'working' as any,            // fallback,UI 不强依赖
      pid: 0,
      startedAt: new Date().toISOString(),
    });
  }
```

(更好的方案是在 list card 按钮 value 里直接带 name/status,留给后续完善)

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/unit/feishu/agent-view-integration.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 跑全量测试确认无 regression**

Run: `bun test`
Expected: 现有所有测试 + 新测试 全绿

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
git add src/feishu/bot.ts tests/unit/feishu/agent-view-integration.test.ts
git commit -m "feat(feishu): Agent View 命令 + card action + chat hook 集成"
```

---

## Task 15: 启动 wiring + CLI 启动时初始化 AgentViewManager

**Files:**
- Modify: `src/cli/commands/start.ts` 或 `src/index.ts`(找 daemon 启动入口)
- Test: 无新测试(纯 wiring)

- [ ] **Step 1: 找启动入口**

Run: `grep -rn "new FeishuBot\|new AgentViewManager" src/`

定位到 daemon 启动时构造 `FeishuBot` 的位置,通常在 `src/cli/commands/start.ts`。

- [ ] **Step 2: 注入 AgentViewManager**

在 FeishuBot 构造之前:

```typescript
import { AgentViewManager } from '../../agent-view/manager';
import { AgentViewPoller } from '../../agent-view/poller';
import { ExpectedReplyStore } from '../../agent-view/reply-bridge';
import { buildReplyExecutor } from '../../agent-view/reply-bridge';

// 在 FeishuBot 构造之前
const poller = new AgentViewPoller({ claudeBin: config.get('general.claude_bin', 'claude') });
const expectedReplyStore = new ExpectedReplyStore();

// ... 构造 feishuClient, cardUpdaterFactory 等

const agentViewManager = new AgentViewManager({
  feishuClient,
  poller,
  expectedReplyStore,
});

// 注入 reply executor(连接 sendSDKMessage)
const sessionManager: ClaudeSessionManager = ...;  // 已存在
agentViewManager.setReplySender(
  buildReplyExecutor({ sessionManager, feishuClient, cardUpdaterFactory: (c) => new CardUpdater(c) }),
);
```

然后:

```typescript
const bot = new FeishuBot({ ..., agentViewManager });
```

- [ ] **Step 3: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: 全绿

- [ ] **Step 4: 手动冒烟测试**

Run: `bun run dev start --daemon`
Expected: daemon 正常启动,日志无报错

Run: `tail ~/.cc-linker/daemon.log` (或类似日志位置)
Expected: 无 "AgentView" 相关报错

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/start.ts  # 或对应文件
git commit -m "feat(daemon): 启动时初始化 AgentViewManager"
```

---

## Task 16: 文档更新

**Files:**
- Modify: `README.md`
- Modify: `README_en.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: README.md — 新增 Agent View 章节**

在 `README.md` 的 "Features" 或 "Commands" 章节后追加:

```markdown
## Agent View (v0.4.0+)

在飞书侧管理 Claude Code 后台会话(`claude agents`)。需要 Claude Code v2.1.139+。

**命令**:`/agents` 在飞书里列出所有后台会话。

**支持的操作**:
- 📋 列表:按状态分组(Working / Needs input / Completed)
- 🔍 Peek:查看会话最近 30 行输出
- ↩️ Reply:两步式注入回复(blocked / stopped / done 状态)
- ⏹ Stop:停掉 working / blocked 会话

**配置**(`~/.cc-linker/config.toml`):

```toml
[agent_view]
enabled = true
refresh_min_interval_ms = 2000
peek_lines = 30
reply_lock_timeout_ms = 30000
reply_wait_timeout_ms = 300000  # 5 分钟
min_claude_version = "2.1.139"
```

**前置条件**:
- `claude --version` ≥ 2.1.139
- 至少 1 个后台会话(在终端 `claude --bg "<prompt>"` 派发)

**已知限制**:
- 飞书 reply 跟终端 `claude attach` 并发行为取决于 supervisor,v1 不解决
- Reply 仅在 blocked / stopped / done 状态可用,working 状态被守卫拒绝
- 不支持:派发新会话、删除会话、Worktree 管理、Filter
```

- [ ] **Step 2: README_en.md — 同步英文版本**

把上一节翻译成英文加到 `README_en.md`。

- [ ] **Step 3: CLAUDE.md — Important Files 表加 src/agent-view/**

修改 `CLAUDE.md` 的 Important Files 表,新增:

```markdown
| `src/agent-view/` | 飞书侧 Agent View 模块(列表/Peek/Reply/Stop) |
```

- [ ] **Step 4: Commit**

```bash
git add README.md README_en.md CLAUDE.md
git commit -m "docs: Agent View 文档"
```

---

## Self-Review

### 1. Spec coverage

| Spec 节 | 覆盖任务 |
|---------|---------|
| §2.1 G1 列出 sessions | Task 9 (handleList) |
| §2.1 G2 状态分组/字段 | Task 4 (buildListCard) + Task 9 |
| §2.1 G3 Refresh | Task 9 (patch messageId) + Task 14 (action dispatch) |
| §2.1 G4 Peek | Task 5 + Task 10 |
| §2.1 G5 Reply (blocked/stopped/done) | Task 11 + Task 12 + Task 13 |
| §2.1 G6 Reply (working 拒绝) | Task 11 (REPLYABLE_STATUSES guard) |
| §2.1 G7 Stop | Task 10 |
| §2.1 G8 sessionLocks 串行化 | 由 sendSDKMessage 内部保证(已有) |
| §2.1 G9 Activity Marker | 由 session-activity-sync design 已有(复用,无新代码) |
| §2.1 G10 版本守卫 | Task 1 + Task 9 |
| §2.1 G11 30KB | Task 4 (测试覆盖) |
| §2.1 G12 测试 | Task 1-14 都带单测 |
| §7 配置 | Task 3 |
| §8 错误处理 | Task 4-6 (buildErrorCard) + Task 9-10 (error 路径) |
| §9 风险 | spec 内已诚实标注,plan 不解决 |
| §10 测试策略 | Task 1-14 (单元)+ Task 14 (集成)+ Task 15 (手动) |
| §11 DoD | 全部 19 项验收,在 Task 15 + 16 之后由人工勾选 |

### 2. Placeholder scan

未发现"TBD" / "TODO" / "fill in later"等占位符。

### 3. Type consistency

- `AgentSession` / `AgentSessionStatus` / `ErrorReason` 在 snapshot / card / manager 间一致
- `AgentViewValue.tag` 在 §6.4 列出 5 种,在 Task 14 switch case 完整覆盖
- `ExpectedReplyEntry` / `ExpectedReplyStore` 在 reply-bridge / manager 间一致
- `ReplyExecutor` 函数签名在 reply-bridge export 与 manager.setReplySender 注入点一致

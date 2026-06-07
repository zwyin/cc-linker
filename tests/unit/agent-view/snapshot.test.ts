import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseAgentsJson,
  attachRosterSources,
  filterUserDispatched,
} from '../../../src/agent-view/snapshot';
import { groupByStatus, type AgentSession } from '../../../src/agent-view/types';

const fixtureDir = join(import.meta.dir, '..', '..', 'fixtures', 'agents-json');

describe('parseAgentsJson', () => {
  test('parses busy + waiting background sessions', () => {
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    const result = parseAgentsJson(raw);
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe('busy');
    expect(result[1].status).toBe('waiting');
    expect(result[1].waitingFor).toBe('input needed');
  });

  test('parses all-idle', () => {
    const raw = readFileSync(join(fixtureDir, 'all-idle.json'), 'utf8');
    const result = parseAgentsJson(raw);
    expect(result.every(s => s.status === 'idle')).toBe(true);
  });

  test('keeps only kind=background (filters out interactive)', () => {
    const raw = readFileSync(join(fixtureDir, 'kind-mixed.json'), 'utf8');
    const result = parseAgentsJson(raw);
    expect(result).toHaveLength(2);
    expect(result.every(s => s.kind === 'background')).toBe(true);
  });

  test('returns empty array for empty JSON', () => {
    expect(parseAgentsJson('[]')).toEqual([]);
  });

  test('throws on invalid JSON', () => {
    const raw = readFileSync(join(fixtureDir, 'invalid.json'), 'utf8');
    expect(() => parseAgentsJson(raw)).toThrow();
  });

  test('treats unknown status as "unknown" (does not throw)', () => {
    const raw = JSON.stringify([
      {pid:1,cwd:'/a',kind:'background',startedAt:1,sessionId:'u',name:'t',status:'weird-status'}
    ]);
    const result = parseAgentsJson(raw);
    expect(result[0].status).toBe('unknown');
  });

  test('waiting.json parses waitingFor field', () => {
    const raw = readFileSync(join(fixtureDir, 'waiting.json'), 'utf8');
    const result = parseAgentsJson(raw);
    expect(result).toHaveLength(2);
    expect(result[0].waitingFor).toBe('input needed');
    expect(result[1].waitingFor).toBe('permission prompt');
  });
});

describe('groupByStatus', () => {
  test('groups by busy/waiting/idle', () => {
    const raw = readFileSync(join(fixtureDir, 'busy.json'), 'utf8');
    const sessions = parseAgentsJson(raw);
    const groups = groupByStatus(sessions);
    expect(groups.busy).toHaveLength(1);
    expect(groups.waiting).toHaveLength(1);
    expect(groups.idle).toHaveLength(0);
  });
});

describe('attachRosterSources (v2.2.1)', () => {
  function mk(over: Partial<AgentSession>): AgentSession {
    return {
      pid: 1,
      cwd: '/a',
      kind: 'background',
      startedAt: 0,
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 't',
      status: 'busy',
      source: 'unknown',
      ...over,
    };
  }

  test('tags sessions with matching shortId as their dispatch source', () => {
    // shortId 是 sessionId 前 8 个字符
    const sessions = [
      mk({ sessionId: 'slash000-1111-2222-3333-444444444444' }),
      mk({ sessionId: 'spare000-1111-2222-3333-444444444444' }),
    ];
    const map = new Map<string, 'slash' | 'spare' | 'fleet'>([
      ['slash000', 'slash'],
      ['spare000', 'spare'],
    ]);
    const result = attachRosterSources(sessions, map);
    expect(result[0].source).toBe('slash');
    expect(result[1].source).toBe('spare');
  });

  test('leaves sessions without roster match as source="unknown"', () => {
    const sessions = [mk({ sessionId: 'unknown0-1111-2222-3333-444444444444' })];
    const map = new Map<string, 'slash' | 'spare' | 'fleet'>([
      ['different', 'slash'],
    ]);
    const result = attachRosterSources(sessions, map);
    expect(result[0].source).toBe('unknown');
  });

  test('empty sourceMap → all sessions stay "unknown"', () => {
    const sessions = [mk({}), mk({ sessionId: 'zzz00000-1111-2222-3333-444444444444' })];
    const result = attachRosterSources(sessions, new Map());
    expect(result.every(s => s.source === 'unknown')).toBe(true);
  });
});

describe('filterUserDispatched (v2.2.1)', () => {
  function mk(over: Partial<AgentSession>): AgentSession {
    return {
      pid: 1,
      cwd: '/a',
      kind: 'background',
      startedAt: 0,
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 't',
      status: 'busy',
      source: 'unknown',
      ...over,
    };
  }

  test('keeps only slash + unknown; drops spare + fleet (sub-agents)', () => {
    const sessions = [
      mk({ sessionId: 's1-aaaa-bbbb-cccc-dddddddddddd', source: 'slash', name: 'user-dispatched' }),
      mk({ sessionId: 's2-aaaa-bbbb-cccc-dddddddddddd', source: 'spare', name: 'sub-agent' }),
      mk({ sessionId: 's3-aaaa-bbbb-cccc-dddddddddddd', source: 'fleet', name: 'daemon-internal' }),
      mk({ sessionId: 's4-aaaa-bbbb-cccc-dddddddddddd', source: 'unknown', name: 'no-roster' }),
    ];
    const result = filterUserDispatched(sessions);
    expect(result).toHaveLength(2);
    expect(result.map(s => s.name).sort()).toEqual(['no-roster', 'user-dispatched']);
  });

  test('returns empty array when all sessions are sub-agents (degenerate)', () => {
    const sessions = [
      mk({ sessionId: 's1-aaaa-bbbb-cccc-dddddddddddd', source: 'spare' }),
      mk({ sessionId: 's2-aaaa-bbbb-cccc-dddddddddddd', source: 'fleet' }),
    ];
    expect(filterUserDispatched(sessions)).toEqual([]);
  });

  test('keeps all sessions when roster is empty (daemon not running)', () => {
    // parseAgentsJson 默认就把 source 设为 'unknown',模拟 daemon 短暂不在
    const raw = JSON.stringify([
      { pid: 1, cwd: '/a', kind: 'background', startedAt: 1, sessionId: 'u1', name: 't1', status: 'busy' },
      { pid: 2, cwd: '/b', kind: 'background', startedAt: 2, sessionId: 'u2', name: 't2', status: 'idle' },
    ]);
    const sessions = parseAgentsJson(raw);
    expect(sessions.every(s => s.source === 'unknown')).toBe(true);
    // filter 必须保留(graceful degradation)
    expect(filterUserDispatched(sessions)).toHaveLength(2);
  });
});

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseAgentsJson } from '../../../src/agent-view/snapshot';
import { groupByStatus } from '../../../src/agent-view/types';

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

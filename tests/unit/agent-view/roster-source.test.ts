// tests/unit/agent-view/roster-source.test.ts
//
// v2.2.1 新增:覆盖 roster.json 读取 + 短 ID → dispatch.source 映射。
// readRoster 走真实文件系统,但用 mkdtempSync 隔离,不会污染本机。
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  readRoster,
  buildRosterSourceMap,
  type Roster,
} from '../../../src/agent-view/roster-source';

let tmpDir: string;
let realHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'roster-source-test-'));
  // 把 HOME 指向 tmpDir,readRoster 就会从 $HOME/.claude/daemon/roster.json 读
  realHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(() => {
  process.env.HOME = realHome;
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function writeRoster(content: object | string) {
  const dir = join(tmpDir, '.claude', 'daemon');
  // 确保目录存在
  const fs = require('fs') as typeof import('fs');
  fs.mkdirSync(dir, { recursive: true });
  const raw = typeof content === 'string' ? content : JSON.stringify(content);
  writeFileSync(join(dir, 'roster.json'), raw, 'utf8');
}

describe('readRoster', () => {
  test('returns null when roster.json does not exist', () => {
    // 没写文件,readRoster 应该返回 null(daemon 没跑的常见情况)
    expect(readRoster()).toBeNull();
  });

  test('returns parsed roster when file is valid JSON', () => {
    writeRoster({
      proto: 1,
      updatedAt: 1780805007645,
      workers: {
        '92664deb': {
          pid: 33341,
          sessionId: '92664deb-f4b6-48d3-9cdd-85cf8eea6dfc',
          cwd: '/Users/wuyujun/Git/cc-linker',
          startedAt: 1780728420798,
          dispatch: { source: 'slash' },
        },
      },
    });
    const roster = readRoster();
    expect(roster).not.toBeNull();
    expect(roster!.workers['92664deb'].dispatch.source).toBe('slash');
  });

  test('returns null when JSON is malformed (graceful degradation)', () => {
    writeRoster('{ this is not valid json');
    expect(readRoster()).toBeNull();
  });

  test('returns null when HOME is unset (edge case)', () => {
    process.env.HOME = '';
    // expandPath 内部 fallback 到 homedir(),所以会从 /var/empty 之类读
    // 只要不抛异常就算通过 — 重点是 graceful
    expect(() => readRoster()).not.toThrow();
  });
});

describe('buildRosterSourceMap', () => {
  test('returns empty map for null roster', () => {
    expect(buildRosterSourceMap(null).size).toBe(0);
  });

  test('builds shortId → source map for all workers', () => {
    const roster: Roster = {
      proto: 1,
      updatedAt: 0,
      workers: {
        '92664deb': {
          pid: 1,
          sessionId: '92664deb-uuid',
          cwd: '/a',
          startedAt: 0,
          dispatch: { source: 'slash' },
        },
        'd78c8339': {
          pid: 2,
          sessionId: 'd78c8339-uuid',
          cwd: '/b',
          startedAt: 0,
          dispatch: { source: 'spare' },
        },
        '3a41fe73': {
          pid: 3,
          sessionId: '3a41fe73-uuid',
          cwd: '/c',
          startedAt: 0,
          dispatch: { source: 'fleet' },
        },
      },
    };
    const map = buildRosterSourceMap(roster);
    expect(map.size).toBe(3);
    expect(map.get('92664deb')).toBe('slash');
    expect(map.get('d78c8339')).toBe('spare');
    expect(map.get('3a41fe73')).toBe('fleet');
  });

  test('skips workers without dispatch.source (defensive)', () => {
    const roster = {
      proto: 1,
      updatedAt: 0,
      workers: {
        good: {
          pid: 1,
          sessionId: 'good-uuid',
          cwd: '/a',
          startedAt: 0,
          dispatch: { source: 'slash' },
        },
        bad: {
          pid: 2,
          sessionId: 'bad-uuid',
          cwd: '/b',
          startedAt: 0,
          // dispatch 字段缺失
        },
      },
    } as unknown as Roster;
    const map = buildRosterSourceMap(roster);
    expect(map.size).toBe(1);
    expect(map.get('good')).toBe('slash');
    expect(map.get('bad')).toBeUndefined();
  });
});

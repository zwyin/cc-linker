import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { listJobShorts, readAllJobStates, readJobState } from '../../../src/agent-view/job-state';

const FIX = join(import.meta.dir, '../../fixtures/job-state');

describe('readJobState', () => {
  test('parses blocked fixture into envelope', () => {
    const env = readJobState('01-blocked-timer', FIX);
    expect(env).not.toBeNull();
    expect(env!.short).toBe('01-blocked-timer');
    expect(env!.state.state).toBe('blocked');
    expect(env!.state.needs).toBe('是否继续？');
    expect(env!.state.name).toBe('timer command response');
    expect(env!.state.linkScanPath).toContain('.jsonl');
    expect(env!.mtimeMs).toBeGreaterThan(0);
  });

  test('returns null for missing file', () => {
    expect(readJobState('does-not-exist', FIX)).toBeNull();
  });

  test('returns null for malformed JSON', () => {
    expect(readJobState('neg-bad-json', FIX)).toBeNull();
  });

  test('returns null for wrong shape (missing state field)', () => {
    expect(readJobState('neg-wrong-shape', FIX)).toBeNull();
  });

  test('accepts unknown state value (forward compat)', () => {
    const env = readJobState('neg-unknown-state', FIX);
    expect(env).not.toBeNull();
    expect(env!.state.state).toBe('hypothetical_future_state');
  });
});

describe('listJobShorts', () => {
  test('lists all fixture filenames (without .json extension)', () => {
    const shorts = listJobShorts(FIX);
    // 应该包含 01..15 + neg-*,不包含 README.md
    expect(shorts).toContain('01-blocked-timer');
    expect(shorts).toContain('15-stopped-unnamed');
    expect(shorts).toContain('neg-bad-json');
    expect(shorts).not.toContain('README');
    expect(shorts.length).toBeGreaterThanOrEqual(18);
  });

  test('returns [] when jobs dir does not exist', () => {
    expect(listJobShorts('/tmp/definitely-not-a-dir-xyz-12345')).toEqual([]);
  });
});

describe('readAllJobStates', () => {
  test('parses all fixtures, drops malformed ones silently', () => {
    const envs = readAllJobStates(FIX);
    // 15 个 happy + 1 个 neg-unknown-state(unknown state 是 valid shape)
    // = 16 个 envelope;neg-bad-json + neg-wrong-shape 被丢
    expect(envs.length).toBe(16);
    const states = envs.map(e => e.state.state).sort();
    expect(states).toContain('blocked');
    expect(states).toContain('running');
    expect(states).toContain('working');
    expect(states.filter(s => s === 'done').length).toBe(10);
    expect(states.filter(s => s === 'stopped').length).toBe(2);
  });
});

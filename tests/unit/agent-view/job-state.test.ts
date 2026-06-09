import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { readJobState } from '../../../src/agent-view/job-state';

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

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DaemonProbe } from '../../../src/agent-view/daemon-probe';

describe('DaemonProbe.check', () => {
  test('returns true when roster.json exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-probe-'));
    mkdirSync(join(dir, 'daemon'));
    writeFileSync(join(dir, 'daemon', 'roster.json'), '{}');
    expect(DaemonProbe.check(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  test('returns false when roster.json missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-probe-'));
    expect(DaemonProbe.check(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });
});

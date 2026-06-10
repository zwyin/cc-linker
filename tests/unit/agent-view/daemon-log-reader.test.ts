import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readClaimedSources } from '../../../src/agent-view/daemon-log-reader';

function isoMs(ms: number): string {
  return new Date(ms).toISOString();
}

describe('readClaimedSources', () => {
  let tmpHome: string;
  let logPath: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'daemon-log-reader-claimed-'));
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    logPath = join(tmpHome, '.claude', 'daemon.log');
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  function writeLog(content: string): void {
    writeFileSync(logPath, content);
  }

  test('returns empty map when daemon.log does not exist', () => {
    const result = readClaimedSources(24);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test('parses spare/slash/fleet sources', () => {
    const now = Date.now();
    const t = now - 30 * 60_000;
    writeLog(
      `[${isoMs(t)}] [bg] bg claimed-spare 273a5566 (spare)\n` +
        `[${isoMs(t)}] [bg] bg claimed-spare 7fd01001 (slash)\n` +
        `[${isoMs(t)}] [bg] bg claimed-spare 84f8f579 (fleet)\n`,
    );
    const result = readClaimedSources(24);
    expect(result.size).toBe(3);
    expect(result.get('273a5566')).toBe('spare');
    expect(result.get('7fd01001')).toBe('slash');
    expect(result.get('84f8f579')).toBe('fleet');
  });

  test('ignores events older than withinHours cutoff', () => {
    const now = Date.now();
    const within = now - 60 * 60_000;
    const tooOld = now - 25 * 3600_000;
    writeLog(
      `[${isoMs(within)}] [bg] bg claimed-spare 273a5566 (spare)\n` +
        `[${isoMs(tooOld)}] [bg] bg claimed-spare cafebabe (slash)\n`,
    );
    const result = readClaimedSources(24);
    expect(result.size).toBe(1);
    expect(result.has('273a5566')).toBe(true);
    expect(result.has('cafebabe')).toBe(false);
  });

  test('deduplicates by short hash; last entry wins (re-dispatched session)', () => {
    const now = Date.now();
    const first = now - 120 * 60_000;
    const second = now - 30 * 60_000;
    writeLog(
      `[${isoMs(first)}] [bg] bg claimed-spare 3a41fe73 (spare)\n` +
        `[${isoMs(second)}] [bg] bg claimed-spare 3a41fe73 (fleet)\n`,
    );
    const result = readClaimedSources(24);
    expect(result.size).toBe(1);
    expect(result.get('3a41fe73')).toBe('fleet');
  });

  test('ignores non-claimed-spare log lines (e.g. settled, spawned, supervisor)', () => {
    const now = Date.now();
    const t = now - 30 * 60_000;
    writeLog(
      `[${isoMs(t)}] [daemon] supervisor started\n` +
        `[${isoMs(t)}] [bg] bg settled 273a5566 (done)\n` +
        `[${isoMs(t)}] [bg] bg spawned aaaaaaaa\n` +
        `[${isoMs(t)}] [bg] bg claimed-spare 84f8f579 (fleet)\n` +
        `garbage line\n`,
    );
    const result = readClaimedSources(24);
    expect(result.size).toBe(1);
    expect(result.get('84f8f579')).toBe('fleet');
    expect(result.has('273a5566')).toBe(false);
    expect(result.has('aaaaaaaa')).toBe(false);
  });
});

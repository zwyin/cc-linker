import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readCompletedSessions } from '../../../src/agent-view/daemon-log-reader';

function isoMs(ms: number): string {
  return new Date(ms).toISOString();
}

describe('readCompletedSessions', () => {
  let tmpHome: string;
  let logPath: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'daemon-log-reader-'));
    mkdirSync(join(tmpHome, '.claude'), { recursive: true });
    logPath = join(tmpHome, '.claude', 'daemon.log');
    // expandPath() reads process.env.HOME at call time, so per-test override works
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
    // No file written → readFileSync throws → empty map
    const result = readCompletedSessions(24);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test('parses "done" events', () => {
    const now = Date.now();
    const hourAgo = now - 60 * 60_000;
    writeLog(`[${isoMs(hourAgo)}] [bg] bg settled 3a41fe73 (done)\n`);
    const result = readCompletedSessions(24);
    expect(result.size).toBe(1);
    expect(result.get('3a41fe73')?.status).toBe('done');
    expect(result.get('3a41fe73')?.settledAt).toBe(hourAgo);
  });

  test('parses "killed" events', () => {
    const now = Date.now();
    const hourAgo = now - 60 * 60_000;
    writeLog(`[${isoMs(hourAgo)}] [bg] bg settled 5bd8861f (killed)\n`);
    const result = readCompletedSessions(24);
    expect(result.get('5bd8861f')?.status).toBe('killed');
  });

  test('excludes events older than withinHours cutoff', () => {
    const now = Date.now();
    const within = now - 60 * 60_000; // 1h ago
    const tooOld = now - 25 * 3600_000; // 25h ago
    writeLog(
      `[${isoMs(within)}] [bg] bg settled 3a41fe73 (done)\n` +
        `[${isoMs(tooOld)}] [bg] bg settled fda81bd7 (done)\n`,
    );
    const result = readCompletedSessions(24);
    expect(result.size).toBe(1);
    expect(result.has('fda81bd7')).toBe(false);
    expect(result.has('3a41fe73')).toBe(true);
  });

  test('deduplicates by short hash; last entry wins', () => {
    const now = Date.now();
    const first = now - 120 * 60_000; // 2h ago
    const second = now - 30 * 60_000; // 30m ago
    writeLog(
      `[${isoMs(first)}] [bg] bg settled 3a41fe73 (killed)\n` +
        `[${isoMs(second)}] [bg] bg settled 3a41fe73 (done)\n`,
    );
    const result = readCompletedSessions(24);
    expect(result.size).toBe(1);
    // last entry wins
    expect(result.get('3a41fe73')?.status).toBe('done');
    expect(result.get('3a41fe73')?.settledAt).toBe(second);
  });

  test('ignores non-settled log lines', () => {
    const now = Date.now();
    const hourAgo = now - 60 * 60_000;
    writeLog(
      `[${isoMs(hourAgo)}] [daemon] supervisor started\n` +
        `[${isoMs(hourAgo)}] [bg] bg spawned 3a41fe73\n` +
        `[${isoMs(hourAgo)}] [bg] bg settled 273a5566 (done)\n` +
        `garbage line\n`,
    );
    const result = readCompletedSessions(24);
    expect(result.size).toBe(1);
    expect(result.has('273a5566')).toBe(true);
    expect(result.has('3a41fe73')).toBe(false); // "spawned" not "settled"
  });

  test('handles mixed done and killed in same log', () => {
    const now = Date.now();
    const t1 = now - 10 * 60_000;
    const t2 = now - 5 * 60_000;
    writeLog(
      `[${isoMs(t1)}] [bg] bg settled 3a41fe73 (done)\n` +
        `[${isoMs(t2)}] [bg] bg settled fda81bd7 (killed)\n`,
    );
    const result = readCompletedSessions(24);
    expect(result.size).toBe(2);
    expect(result.get('3a41fe73')?.status).toBe('done');
    expect(result.get('fda81bd7')?.status).toBe('killed');
  });
});

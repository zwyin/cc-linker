import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as net from 'net';
import { checkRendezvousEligibility } from '../../../src/agent-view/rendezvous-fallback';

describe('checkRendezvousEligibility', () => {
  let ccHome: string;
  let sockServer: net.Server | null = null;

  beforeEach(() => {
    ccHome = mkdtempSync(join(tmpdir(), 'cc-rendezvous-elig-test-'));
    mkdirSync(join(ccHome, 'jobs', 'dcb2ec25'), { recursive: true });
    mkdirSync(join(ccHome, 'daemon'), { recursive: true });
    sockServer = null;
  });

  afterEach(() => {
    if (sockServer) {
      sockServer.close();
      sockServer = null;
    }
    if (ccHome) rmSync(ccHome, { recursive: true, force: true });
  });

  function writeState(state: any) {
    writeFileSync(join(ccHome, 'jobs', 'dcb2ec25', 'state.json'), JSON.stringify(state));
  }
  function writeRoster(roster: any) {
    writeFileSync(join(ccHome, 'daemon', 'roster.json'), JSON.stringify(roster));
  }
  function writeSocket() {
    // Create a real Unix socket file (not a symlink) so statSync().isSocket() returns true
    const sockPath = join(ccHome, 'daemon', 'rv-dcb2ec25.sock');
    sockServer = net.createServer();
    sockServer.listen(sockPath);
  }

  const testCtx = (ccHome: string) => ({
    jobsDir: join(ccHome, 'jobs'),
    rosterPath: join(ccHome, 'daemon', 'roster.json'),
  });

  test('bg waiting + socket exists → canUse', async () => {
    writeState({
      state: 'blocked',
      tempo: 'blocked',
      needs: '是否继续?',
      linkScanPath: '/tmp/x.jsonl',
    });
    writeRoster({
      workers: {
        dcb2ec25: {
          rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock'),
        },
      },
    });
    writeSocket();

    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(true);
    expect(r.reason).toBe('bg_waiting');
    expect(r.rendezvousSock).toBe(join(ccHome, 'daemon', 'rv-dcb2ec25.sock'));
    expect(r.jsonlPath).toBe('/tmp/x.jsonl');
  });

  test('bg busy (tempo=active) → bg_busy', async () => {
    writeState({ state: 'running', tempo: 'active', needs: '' });
    writeRoster({ workers: { dcb2ec25: { rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock') } } });
    writeSocket();
    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('bg_busy');
  });

  test('state.json missing → daemon_down', async () => {
    // state.json was never created (only the directory was in beforeEach)
    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('daemon_down');
  });

  test('roster missing → daemon_down', async () => {
    writeState({ state: 'blocked', tempo: 'blocked', needs: 'q' });
    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('daemon_down');
  });

  test('no rendezvousSock in roster → no_rendezvous_sock', async () => {
    writeState({ state: 'blocked', tempo: 'blocked', needs: 'q' });
    writeRoster({ workers: { dcb2ec25: {} } });
    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('no_rendezvous_sock');
  });

  test('socket file missing on disk → daemon_down', async () => {
    writeState({ state: 'blocked', tempo: 'blocked', needs: 'q' });
    writeRoster({ workers: { dcb2ec25: { rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock') } } });
    // no writeSocket() — physical file doesn't exist
    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('daemon_down');
  });

  test('socket path is a regular file, not a socket → daemon_down', async () => {
    writeState({ state: 'blocked', tempo: 'blocked', needs: 'q' });
    writeRoster({ workers: { dcb2ec25: { rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock') } } });
    writeFileSync(join(ccHome, 'daemon', 'rv-dcb2ec25.sock'), 'not a socket');
    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('daemon_down');
  });

  test('malformed state.json → daemon_down', async () => {
    writeFileSync(join(ccHome, 'jobs', 'dcb2ec25', 'state.json'), '{ not valid json');
    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('daemon_down');
  });

  test('tear-write state.json → retry succeeds (via readJobState)', async () => {
    // Simulate tear-write: first write is truncated, then quickly fixed
    writeFileSync(join(ccHome, 'jobs', 'dcb2ec25', 'state.json'), '{ partial');
    writeRoster({ workers: { dcb2ec25: { rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock') } } });
    writeSocket();

    // After 10ms, write the valid state (before readJobState's 20ms retry)
    setTimeout(() => {
      writeState({ state: 'blocked', tempo: 'blocked', needs: 'q' });
    }, 10);

    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    // readJobState retries once after 20ms, so it should recover
    expect(r.canUse).toBe(true);
  });
});

describe('checkRendezvousEligibility - bg_resumable (Attach path, v2.4.x)', () => {
  let ccHome: string;
  let sockServer: net.Server | null = null;

  beforeEach(() => {
    ccHome = mkdtempSync(join(tmpdir(), 'cc-rendezvous-resumable-test-'));
    mkdirSync(join(ccHome, 'jobs', 'dcb2ec25'), { recursive: true });
    mkdirSync(join(ccHome, 'daemon'), { recursive: true });
    sockServer = null;
  });

  afterEach(() => {
    if (sockServer) {
      sockServer.close();
      sockServer = null;
    }
    if (ccHome) rmSync(ccHome, { recursive: true, force: true });
  });

  function writeState(state: any) {
    writeFileSync(join(ccHome, 'jobs', 'dcb2ec25', 'state.json'), JSON.stringify(state));
  }
  function writeRoster(roster: any) {
    writeFileSync(join(ccHome, 'daemon', 'roster.json'), JSON.stringify(roster));
  }
  function writeSocket() {
    const sockPath = join(ccHome, 'daemon', 'rv-dcb2ec25.sock');
    sockServer = net.createServer();
    sockServer.listen(sockPath);
  }

  const testCtx = (ccHome: string) => ({
    jobsDir: join(ccHome, 'jobs'),
    rosterPath: join(ccHome, 'daemon', 'roster.json'),
  });

  test('bg done (settled) + socket exists → canUse, reason=bg_resumable', async () => {
    writeState({
      state: 'done',
      tempo: 'idle',
      needs: null,
      linkScanPath: '/tmp/x.jsonl',
    });
    writeRoster({
      workers: {
        dcb2ec25: {
          rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock'),
        },
      },
    });
    writeSocket();

    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(true);
    expect(r.reason).toBe('bg_resumable');
    expect(r.rendezvousSock).toBe(join(ccHome, 'daemon', 'rv-dcb2ec25.sock'));
    expect(r.jsonlPath).toBe('/tmp/x.jsonl');
  });

  test('bg stopped (user killed) + socket exists → canUse, reason=bg_resumable', async () => {
    writeState({ state: 'stopped', tempo: 'idle', detail: 'killed', needs: null });
    writeRoster({
      workers: {
        dcb2ec25: {
          rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock'),
        },
      },
    });
    writeSocket();

    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(true);
    expect(r.reason).toBe('bg_resumable');
  });

  test('bg tempo=idle (forward-compat, not done) + socket exists → canUse, reason=bg_resumable', async () => {
    writeState({ state: 'unknown', tempo: 'idle', needs: null });
    writeRoster({
      workers: {
        dcb2ec25: {
          rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock'),
        },
      },
    });
    writeSocket();

    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(true);
    expect(r.reason).toBe('bg_resumable');
  });

  test('bg running (busy, no needs) → bg_busy (still denied — concurrent turn risk)', async () => {
    writeState({ state: 'running', tempo: 'active', needs: null });
    writeRoster({
      workers: {
        dcb2ec25: {
          rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock'),
        },
      },
    });
    writeSocket();

    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('bg_busy');
  });

  test('bg working (busy, no needs) → bg_busy', async () => {
    writeState({ state: 'working', tempo: 'active', needs: null });
    writeRoster({
      workers: {
        dcb2ec25: {
          rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock'),
        },
      },
    });
    writeSocket();

    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('bg_busy');
  });

  test('bg waiting (existing case, baseline) → reason=bg_waiting (not bg_resumable)', async () => {
    writeState({
      state: 'blocked',
      tempo: 'blocked',
      needs: '是否继续?',
    });
    writeRoster({
      workers: {
        dcb2ec25: {
          rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock'),
        },
      },
    });
    writeSocket();

    const r = await checkRendezvousEligibility('dcb2ec25', testCtx(ccHome));
    expect(r.canUse).toBe(true);
    expect(r.reason).toBe('bg_waiting');
  });
});

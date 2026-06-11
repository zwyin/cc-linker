import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as net from 'net';
import { RendezvousClient, type StatePatch } from '../../../src/agent-view/rendezvous-client';

describe('RendezvousClient.injectReply', () => {
  let sockPath: string;
  let server: net.Server;
  let receivedLines: string[] = [];

  beforeEach(() => {
    sockPath = join(mkdtempSync(join(tmpdir(), 'rendezvous-test-')), 'daemon.sock');
    receivedLines = [];
    server = net.createServer(c => {
      let serverBuffer = '';
      c.on('data', d => {
        serverBuffer += d.toString('utf8');
        let idx;
        while ((idx = serverBuffer.indexOf('\n')) >= 0) {
          const line = serverBuffer.slice(0, idx);
          serverBuffer = serverBuffer.slice(idx + 1);
          if (!line.trim()) continue;
          receivedLines.push(line);
          const parsed = JSON.parse(line);
          if (parsed.type === 'reply') {
            // Send back a fake state patch: bg started processing
            c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active', needs: '' } }) + '\n');
            // Then send completion
            setTimeout(() => {
              c.write(JSON.stringify({ type: 'state', patch: { tempo: 'blocked', needs: 'next q?', state: 'blocked' } }) + '\n');
            }, 20);
          }
        }
      });
    });
    server.listen(sockPath);
  });

  afterEach(() => {
    server.close();
    if (sockPath) {
      try { rmSync(join(sockPath, '..'), { recursive: true, force: true }); } catch {}
    }
  });

  test('sends single line JSON and returns new_needs on tempo=blocked+needs', async () => {
    const patches: StatePatch[] = [];
    const result = await RendezvousClient.injectReply({
      short: 'dcb2ec25',
      text: '继续',
      rendezvousSock: sockPath,
      timeoutMs: 2000,
      onStatePatch: p => patches.push(p),
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('new_needs');
    expect(receivedLines).toHaveLength(1);
    const sent = JSON.parse(receivedLines[0]);
    expect(sent.type).toBe('reply');
    expect(sent.text).toBe('继续');
    expect(patches.length).toBeGreaterThanOrEqual(1);
  });

  test('completes on state=done', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { state: 'done', tempo: 'idle' } }) + '\n');
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('done');
  });

  test('user_stopped when state=stopped + detail=killed', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { state: 'stopped', detail: 'killed', tempo: 'idle' } }) + '\n');
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('user_stopped');
  });

  test('timeouts after 200ms', async () => {
    server.close();
    server = net.createServer(() => { /* never respond */ });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 200,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('timeout');
  });

  test('socket disconnect mid-wait → socket_closed', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active' } }) + '\n');
        setTimeout(() => c.destroy(), 20);
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('socket_closed');
  });

  test('daemon returns error JSON', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'error', message: 'something' }) + '\n');
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('daemon_error');
  });

  test('handles long text (>10KB)', async () => {
    // Use the default beforeEach server which handles replies properly
    // (with server-side buffering across TCP chunks)
    const longText = 'x'.repeat(15000);
    const r = await RendezvousClient.injectReply({
      short: 's', text: longText, rendezvousSock: sockPath, timeoutMs: 5000,
    });
    expect(r.ok).toBe(true);
    expect(receivedLines[0]).toContain(longText);
  });

  test('handles unicode text', async () => {
    const r = await RendezvousClient.injectReply({
      short: 's', text: '继续 中文 🚀', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(receivedLines[0]).text).toBe('继续 中文 🚀');
  });

  test('completes on tempo=idle + no needs', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'idle', needs: '' } }) + '\n');
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('idle');
  });

  test('patches collected for debugging', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active' } }) + '\n');
        setTimeout(() => {
          c.write(JSON.stringify({ type: 'state', patch: { tempo: 'blocked', needs: 'q' } }) + '\n');
        }, 20);
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.patches).toBeDefined();
    expect(r.patches!.length).toBeGreaterThanOrEqual(2);
  });

  test('connection refused → socket_closed', async () => {
    server.close();
    try { rmSync(sockPath); } catch {}
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('socket_closed');
  });

  test('onStatePatch callback fires for every patch', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active' } }) + '\n');
        setTimeout(() => {
          c.write(JSON.stringify({ type: 'state', patch: { tempo: 'blocked', needs: 'q' } }) + '\n');
        }, 20);
      });
    });
    server.listen(sockPath);
    const patches: StatePatch[] = [];
    await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
      onStatePatch: p => patches.push(p),
    });
    expect(patches.length).toBeGreaterThanOrEqual(2);
  });
});

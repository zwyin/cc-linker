import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { repairJsonlLastPrompt } from '../../../src/utils/jsonl-repair';

describe('repairJsonlLastPrompt', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-repair-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false for non-existent file', () => {
    const result = repairJsonlLastPrompt(join(tmpDir, 'nonexistent.jsonl'));
    expect(result).toBe(false);
  });

  it('returns false for empty JSONL', () => {
    const path = join(tmpDir, 'empty.jsonl');
    writeFileSync(path, '');
    const result = repairJsonlLastPrompt(path);
    expect(result).toBe(false);
  });

  it('repairs last-prompt to point to latest user+assistant pair', () => {
    const path = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, uuid: 'u1', timestamp: '2026-05-16T09:00:00Z', sessionId: 's1' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, uuid: 'a1', timestamp: '2026-05-16T09:00:05Z', sessionId: 's1' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'hello', leafUuid: 'a1', sessionId: 's1' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'feishu msg' }, uuid: 'u2', timestamp: '2026-05-16T09:01:00Z', sessionId: 's1', entrypoint: 'sdk-cli' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'feishu reply' }] }, uuid: 'a2', timestamp: '2026-05-16T09:01:05Z', sessionId: 's1', entrypoint: 'sdk-cli' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'hello', leafUuid: 'a1', sessionId: 's1' }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');

    const result = repairJsonlLastPrompt(path);
    expect(result).toBe(true);

    const content = readFileSync(path, 'utf8');
    const parsed = content.trim().split('\n').map(l => JSON.parse(l));

    // Should have removed old last-prompt entries and added new one
    const lastPrompts = parsed.filter((e: any) => e.type === 'last-prompt');
    expect(lastPrompts.length).toBe(1);
    expect(lastPrompts[0].leafUuid).toBe('a2');
    expect(lastPrompts[0].lastPrompt).toBe('feishu reply');
  });

  it('returns false when last-prompt is already correct', () => {
    const path = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, uuid: 'u1', timestamp: '2026-05-16T09:00:00Z', sessionId: 's1' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, uuid: 'a1', timestamp: '2026-05-16T09:00:05Z', sessionId: 's1' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'hello', leafUuid: 'a1', sessionId: 's1' }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');

    const result = repairJsonlLastPrompt(path);
    expect(result).toBe(false);
  });

  it('handles user message without assistant reply', () => {
    const path = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'only user' }, uuid: 'u1', timestamp: '2026-05-16T09:00:00Z', sessionId: 's1' }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');

    const result = repairJsonlLastPrompt(path);
    expect(result).toBe(true);

    const content = readFileSync(path, 'utf8');
    const parsed = content.trim().split('\n').map(l => JSON.parse(l));
    const lastPrompts = parsed.filter((e: any) => e.type === 'last-prompt');
    expect(lastPrompts.length).toBe(1);
    expect(lastPrompts[0].leafUuid).toBe('u1');
    expect(lastPrompts[0].lastPrompt).toBe('only user');
  });

  it('skips meta user messages', () => {
    const path = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'real msg' }, uuid: 'u1', timestamp: '2026-05-16T09:00:00Z', sessionId: 's1' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'meta' }, isMeta: true, uuid: 'u2', timestamp: '2026-05-16T09:01:00Z', sessionId: 's1' }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');

    const result = repairJsonlLastPrompt(path);
    expect(result).toBe(true);

    const content = readFileSync(path, 'utf8');
    const parsed = content.trim().split('\n').map(l => JSON.parse(l));
    const lastPrompts = parsed.filter((e: any) => e.type === 'last-prompt');
    expect(lastPrompts[0].leafUuid).toBe('u1');
  });

  it('prefers sdk-cli messages over cli command outputs', () => {
    const path = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'feishu msg' }, uuid: 'u1', timestamp: '2026-05-16T09:00:00Z', sessionId: 's1', entrypoint: 'sdk-cli' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'feishu reply' }] }, uuid: 'a1', timestamp: '2026-05-16T09:00:05Z', sessionId: 's1', entrypoint: 'sdk-cli' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Catch you later!</local-command-stdout>' }, uuid: 'u2', timestamp: '2026-05-16T09:01:00Z', sessionId: 's1', entrypoint: 'cli' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'wrong', leafUuid: 'u2', sessionId: 's1' }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');

    const result = repairJsonlLastPrompt(path);
    expect(result).toBe(true);

    const content = readFileSync(path, 'utf8');
    const parsed = content.trim().split('\n').map(l => JSON.parse(l));
    const lastPrompts = parsed.filter((e: any) => e.type === 'last-prompt');
    expect(lastPrompts.length).toBe(1);
    expect(lastPrompts[0].leafUuid).toBe('a1');
  });

  it('recognizes sdk-ts (Claude Agent SDK) as Feishu — same priority as sdk-cli', () => {
    // Real cc-linker Feishu bot uses Claude Agent SDK which writes entrypoint='sdk-ts'.
    // Repair must treat sdk-ts as Feishu, not fall back to cli stubs.
    const path = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'feishu msg via SDK' }, uuid: 'u1', timestamp: '2026-05-16T09:00:00Z', sessionId: 's1', entrypoint: 'sdk-ts' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'feishu PR review reply' }] }, uuid: 'a1', timestamp: '2026-05-16T09:00:05Z', sessionId: 's1', entrypoint: 'sdk-ts' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Catch you later!</local-command-stdout>' }, uuid: 'u2', timestamp: '2026-05-16T09:01:00Z', sessionId: 's1', entrypoint: 'cli' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] }, uuid: 'a2', timestamp: '2026-05-16T09:01:10Z', sessionId: 's1', entrypoint: 'cli' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'wrong', leafUuid: 'a2', sessionId: 's1' }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');

    const result = repairJsonlLastPrompt(path);
    expect(result).toBe(true);

    const content = readFileSync(path, 'utf8');
    const parsed = content.trim().split('\n').map(l => JSON.parse(l));
    const lastPrompts = parsed.filter((e: any) => e.type === 'last-prompt');
    expect(lastPrompts.length).toBe(1);
    expect(lastPrompts[0].leafUuid).toBe('a1');
    expect(lastPrompts[0].lastPrompt).toBe('feishu PR review reply');
  });
});

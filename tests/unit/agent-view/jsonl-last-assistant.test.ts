import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readLastAssistantTurn } from '../../../src/agent-view/jsonl-last-assistant';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('readLastAssistantTurn', () => {
  let tmpDir: string;
  let jsonlPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-last-test-'));
    jsonlPath = join(tmpDir, 'session.jsonl');
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('extracts last assistant text', async () => {
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello back' }],
          usage: { input_tokens: 100, output_tokens: 5 },
        },
        timestamp: '2026-06-11T10:00:00Z',
        uuid: 'uuid-1',
      }),
    ].join('\n') + '\n');

    const result = await readLastAssistantTurn(jsonlPath);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('hello back');
    expect(result!.usage.input_tokens).toBe(100);
    expect(result!.usage.output_tokens).toBe(5);
    expect(result!.uuid).toBe('uuid-1');
  });

  test('returns null for empty file', async () => {
    writeFileSync(jsonlPath, '');
    expect(await readLastAssistantTurn(jsonlPath)).toBeNull();
  });

  test('returns null for missing file', async () => {
    expect(await readLastAssistantTurn(join(tmpDir, 'nope.jsonl'))).toBeNull();
  });

  test('skips user turns, returns last assistant', async () => {
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'q1' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        uuid: 'u1',
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'q2' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
        uuid: 'u2',
      }),
    ].join('\n') + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r!.text).toBe('a2');
    expect(r!.uuid).toBe('u2');
  });

  test('skips torn last line (mid-write)', async () => {
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'good' }] } }),
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial', // torn
    ].join('\n'));
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r!.text).toBe('good');
  });

  test('handles content as plain string', async () => {
    writeFileSync(jsonlPath, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'plain text content' },
      uuid: 'u3',
    }) + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r!.text).toBe('plain text content');
  });

  test('handles content array with multiple blocks (returns first text)', async () => {
    writeFileSync(jsonlPath, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'thinking', text: 'internal monologue' },
        { type: 'text', text: 'visible reply' },
      ] },
      uuid: 'u4',
    }) + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r!.text).toBe('visible reply');
  });

  test('handles missing usage with zeros', async () => {
    writeFileSync(jsonlPath, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'no usage' }] },
      uuid: 'u5',
    }) + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r!.usage.input_tokens).toBe(0);
    expect(r!.usage.output_tokens).toBe(0);
  });

  test('skips system and tool turns', async () => {
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'q' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] }, uuid: 'u6' }),
    ].join('\n') + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r!.text).toBe('final');
  });
});

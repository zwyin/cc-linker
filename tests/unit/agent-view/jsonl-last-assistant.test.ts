import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readLastAssistantTurn, waitForNewAssistantTurn } from '../../../src/agent-view/jsonl-last-assistant';
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

  /**
   * v2.4.x UX: 处理中卡片要展示完整 bg 活动, 不只是最后一个 text 块。
   * 提取 thinking 块 (concat) + text 块 (concat) + tool_use 名字 + input 摘要,
   * 让卡片能展示 思考过程 / 当前操作 / 响应 三段。
   */
  test('extracts thinking blocks (concatenated)', async () => {
    writeFileSync(jsonlPath, [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: '先想想...' },
            { type: 'thinking', text: '再想想...' },
            { type: 'text', text: '我来读文件' },
          ],
        },
      }),
    ].join('\n') + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r).not.toBeNull();
    expect(r!.thinking).toBe('先想想...\n再想想...');
    expect(r!.text).toBe('我来读文件');
    expect(r!.toolUses).toEqual([]);
  });

  test('extracts tool_use names + input summary', async () => {
    writeFileSync(jsonlPath, [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: '读文件' },
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: '/tmp/foo.txt' },
            },
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'ls -la /tmp' },
            },
            { type: 'text', text: '读完了' },
          ],
        },
      }),
    ].join('\n') + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r).not.toBeNull();
    expect(r!.thinking).toBe('读文件');
    expect(r!.toolUses.length).toBe(2);
    expect(r!.toolUses[0].name).toBe('Read');
    expect(r!.toolUses[0].inputSummary).toContain('/tmp/foo.txt');
    expect(r!.toolUses[1].name).toBe('Bash');
    expect(r!.toolUses[1].inputSummary).toContain('ls -la /tmp');
    expect(r!.text).toBe('读完了');
  });

  test('tool_use with complex input 给出摘要字符串', async () => {
    writeFileSync(jsonlPath, [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: {
                file_path: '/very/long/path/to/file/that/should/be/truncated.ts',
                old_string: 'a long string...',
                new_string: 'a long string...',
              },
            },
          ],
        },
      }),
    ].join('\n') + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r).not.toBeNull();
    expect(r!.toolUses.length).toBe(1);
    // 摘要不超过 80 字符
    expect(r!.toolUses[0].inputSummary.length).toBeLessThanOrEqual(80);
    expect(r!.toolUses[0].inputSummary).toContain('/very/long/path');
  });

  test('legacy 字段 (text) 仍然工作 (向后兼容)', async () => {
    writeFileSync(jsonlPath, [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '纯文本' }],
        },
      }),
    ].join('\n') + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r!.text).toBe('纯文本');
    expect(r!.thinking).toBe('');
    expect(r!.toolUses).toEqual([]);
  });
});

describe('waitForNewAssistantTurn (v2.4.1 race condition fix)', () => {
  let tmpDir: string;
  let jsonlPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wait-new-turn-test-'));
    jsonlPath = join(tmpDir, 'session.jsonl');
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a single assistant turn to JSONL */
  function writeAssistantTurn(text: string, uuid: string = 'u1') {
    writeFileSync(jsonlPath, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      uuid,
    }) + '\n');
  }

  /** Append a new assistant turn (simulates bg writing a new turn) */
  function appendAssistantTurn(text: string, uuid: string = 'u2') {
    const fs = require('fs');
    fs.appendFileSync(jsonlPath, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      uuid,
    }) + '\n');
  }

  test('polls until text differs from baseline (found after 2 polls)', async () => {
    writeAssistantTurn('Previous turn text');
    const baseline = 'Previous turn text';

    // Append new turn after 250ms (simulates bg finishing write)
    setTimeout(() => appendAssistantTurn('New turn text'), 250);

    const result = await waitForNewAssistantTurn(
      jsonlPath, baseline, 3000, 150,
    );
    expect(result.foundNew).toBe(true);
    expect(result.turn?.text).toBe('New turn text');
  });

  test('times out when text never differs from baseline', async () => {
    writeAssistantTurn('Same text');

    const result = await waitForNewAssistantTurn(
      jsonlPath, 'Same text', 500, 100,  // short timeout for test
    );
    expect(result.foundNew).toBe(false);
    expect(result.turn?.text).toBe('Same text');  // fallback to whatever's in JSONL
  });

  test('null baseline matches any non-empty text', async () => {
    writeAssistantTurn('First turn');

    const result = await waitForNewAssistantTurn(
      jsonlPath, null, 3000, 150,
    );
    expect(result.foundNew).toBe(true);
    expect(result.turn?.text).toBe('First turn');
  });

  test('empty baseline ("") matches any non-empty text', async () => {
    writeAssistantTurn('Some text');

    const result = await waitForNewAssistantTurn(
      jsonlPath, '', 3000, 150,
    );
    expect(result.foundNew).toBe(true);
    expect(result.turn?.text).toBe('Some text');
  });

  test('returns null turn when JSONL file does not exist', async () => {
    const result = await waitForNewAssistantTurn(
      join(tmpDir, 'nope.jsonl'), 'baseline', 500, 100,
    );
    expect(result.foundNew).toBe(false);
    expect(result.turn).toBeNull();
  });
});

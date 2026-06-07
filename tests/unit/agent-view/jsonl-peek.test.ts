// tests/unit/agent-view/jsonl-peek.test.ts
//
// v2.2.8 jsonl-peek 单测:extractRecentAssistantText 覆盖
//   - 多种 content 形态(string / array-text / 混合 tool_use+text)
//   - 多条 assistant 取最后一条
//   - 空 / 全 tool_use entry 返回 null
//   - 大文件走 tail 路径(模拟 2MB+)
//   - 截断在段落边界

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractRecentAssistantText } from '../../../src/agent-view/jsonl-peek';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cc-linker-jsonl-peek-'));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function writeJsonl(name: string, lines: object[]): string {
  const path = join(tmpDir, name);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('extractRecentAssistantText', () => {
  test('returns last assistant string content', () => {
    const path = writeJsonl('a.jsonl', [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { role: 'assistant', content: 'hello there' } },
    ]);
    expect(extractRecentAssistantText(path)).toBe('hello there');
  });

  test('returns last assistant text from array content', () => {
    const path = writeJsonl('b.jsonl', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'final answer text' }],
        },
      },
    ]);
    expect(extractRecentAssistantText(path)).toBe('final answer text');
  });

  test('joins multiple text blocks from one assistant entry with double newline', () => {
    const path = writeJsonl('c.jsonl', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'first paragraph' },
            { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
            { type: 'text', text: 'second paragraph' },
          ],
        },
      },
    ]);
    expect(extractRecentAssistantText(path)).toBe('first paragraph\n\nsecond paragraph');
  });

  test('picks the LAST assistant entry when multiple exist', () => {
    const path = writeJsonl('d.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: 'first turn' } },
      { type: 'user', message: { role: 'user', content: 'follow-up' } },
      { type: 'assistant', message: { role: 'assistant', content: 'second turn (latest)' } },
    ]);
    expect(extractRecentAssistantText(path)).toBe('second turn (latest)');
  });

  test('skips assistant entries with only tool_use (no text)', () => {
    const path = writeJsonl('e.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: 'real text' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }],
        },
      },
    ]);
    expect(extractRecentAssistantText(path)).toBe('real text');
  });

  test('returns null when no assistant text found at all', () => {
    const path = writeJsonl('f.jsonl', [
      { type: 'user', message: { role: 'user', content: 'lonely user' } },
      { type: 'mode', mode: 'normal' },
    ]);
    expect(extractRecentAssistantText(path)).toBeNull();
  });

  test('returns null when file does not exist', () => {
    expect(extractRecentAssistantText('/nonexistent/path/x.jsonl')).toBeNull();
  });

  test('returns null when file is empty', () => {
    const path = writeJsonl('g.jsonl', []);
    writeFileSync(path, ''); // truly empty
    expect(extractRecentAssistantText(path)).toBeNull();
  });

  test('handles malformed JSON lines gracefully', () => {
    const path = join(tmpDir, 'h.jsonl');
    writeFileSync(
      path,
      'this is not json\n' +
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'good one' } }) +
        '\n' +
        'also not json\n',
    );
    expect(extractRecentAssistantText(path)).toBe('good one');
  });

  test('truncates long text at paragraph boundary with "(已截断)" marker', () => {
    const longText =
      'first paragraph\n\n' +
      'second paragraph\n\n' +
      'third paragraph that pushes us over the limit and should be cut by the truncator';
    const path = writeJsonl('i.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: longText } },
    ]);
    const result = extractRecentAssistantText(path, 50);
    expect(result).toBeTruthy();
    expect(result!.length).toBeLessThanOrEqual(60); // truncate + 已截断 marker
    expect(result).toContain('已截断');
  });

  test('returns short text untouched when under maxChars', () => {
    const path = writeJsonl('j.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: 'short' } },
    ]);
    const result = extractRecentAssistantText(path, 1000);
    expect(result).toBe('short');
  });
});

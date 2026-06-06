// tests/unit/scanner/jsonl-parse-tail-preview.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseTailForPreview } from '../../../src/scanner/jsonl';

describe('parseTailForPreview', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'parse-tail-preview-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts last user prompt and last assistant text from valid JSONL', () => {
    const path = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '帮我做 X' }, timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '好的，我来帮你' }] }, timestamp: '2026-01-01T00:00:01Z' }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'sleep 50 && echo done' }] }, timestamp: '2026-01-01T00:00:02Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', text: '思考中...' }, { type: 'text', text: '执行 sleep 50' }] }, timestamp: '2026-01-01T00:00:03Z' }),
    ];
    writeFileSync(path, lines.join('\n'));

    const result = parseTailForPreview(path);
    expect(result.lastUser).toBe('sleep 50 && echo done');
    expect(result.lastAssistant).toBe('执行 sleep 50');
  });

  it('handles user content as string (not array)', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'user', message: { content: '纯字符串内容' } }));

    const result = parseTailForPreview(path);
    expect(result.lastUser).toBe('纯字符串内容');
  });

  it('returns empty object for empty file', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, '');
    const result = parseTailForPreview(path);
    expect(result).toEqual({});
  });

  it('returns empty object for missing file', () => {
    const result = parseTailForPreview(join(tmpDir, 'nonexistent.jsonl'));
    expect(result).toEqual({});
  });

  it('finds content inside last 4KB of large file', () => {
    // File > 4KB; the last user/assistant lines are inside the tail
    const path = join(tmpDir, 'large.jsonl');
    const padding = JSON.stringify({ type: 'progress', data: 'x'.repeat(200) });
    // 18 lines of padding ≈ 4.1KB, just over 4KB boundary
    const paddingLines = Array(18).fill(padding).join('\n');
    const tail = [
      JSON.stringify({ type: 'user', message: { content: '最近的问题' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '最近的回复' }] } }),
    ].join('\n');
    writeFileSync(path, paddingLines + '\n' + tail);

    const result = parseTailForPreview(path);
    expect(result.lastUser).toBe('最近的问题');
    expect(result.lastAssistant).toBe('最近的回复');
  });

  it('returns lastAssistant even when last user is outside 4KB tail', () => {
    // File > 4KB; the last user prompt is BEFORE the last 4KB
    // (drowned by tool_result blocks). The function should still return
    // what it can find inside the 4KB tail.
    const path = join(tmpDir, 'huge.jsonl');
    const padding = JSON.stringify({ type: 'progress', data: 'x'.repeat(200) });
    // ~5KB of padding (about 25 lines)
    const paddingLines = Array(25).fill(padding).join('\n');
    const head = JSON.stringify({ type: 'user', message: { content: '很久以前的问题' } });
    const tail = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '当前回复' }] } });
    writeFileSync(path, head + '\n' + paddingLines + '\n' + tail);

    const result = parseTailForPreview(path);
    // lastAssistant found (inside tail)
    expect(result.lastAssistant).toBe('当前回复');
    // lastUser NOT found (before tail) — this documents the intentional limitation
    expect(result.lastUser).toBeUndefined();
  });

  it('returns empty object for malformed JSONL lines', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, 'not json\n{broken: json\n');
    const result = parseTailForPreview(path);
    expect(result).toEqual({});
  });

  it('returns only lastUser when only user lines exist', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'user', message: { content: '只有一个 user' } }));
    const result = parseTailForPreview(path);
    expect(result.lastUser).toBe('只有一个 user');
    expect(result.lastAssistant).toBeUndefined();
  });

  it('returns only lastAssistant when only assistant lines exist', () => {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '只有 assistant' }] } }));
    const result = parseTailForPreview(path);
    expect(result.lastAssistant).toBe('只有 assistant');
    expect(result.lastUser).toBeUndefined();
  });

  it('truncates long text to 100 chars', () => {
    const path = join(tmpDir, 'session.jsonl');
    const longText = 'x'.repeat(500);
    writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: longText }] } }));
    const result = parseTailForPreview(path);
    expect(result.lastAssistant?.length).toBe(100);
  });

  // 回归测试：bash 循环等任务的进度只在 tool_result stdout 里, 没 assistant text.
  // lastAssistant 应该 fallback 到最近 tool_result content.
  it('falls back to most recent tool_result stdout when no assistant text', () => {
    const path = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '每 10s 打印时间' } }),
      // 模拟 bash 循环: 只有 tool_use + tool_result + thinking, 没 assistant text
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Sat Jun 6 16:32:31 HKT 2026\n' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '迭代中' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Sat Jun 6 16:32:41 HKT 2026\n' }] } }),
    ];
    writeFileSync(path, lines.join('\n'));

    const result = parseTailForPreview(path);
    // 没有任何 assistant text → fallback 到最近 tool_result stdout
    expect(result.lastAssistant).toBe('Sat Jun 6 16:32:41 HKT 2026');
  });

  it('prefers assistant text over tool_result when both exist', () => {
    const path = join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'q' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'stdout1' }] } }),
    ];
    writeFileSync(path, lines.join('\n'));

    const result = parseTailForPreview(path);
    // assistant text 'reply' 比 tool_result 'stdout1' 优先
    expect(result.lastAssistant).toBe('reply');
  });
});

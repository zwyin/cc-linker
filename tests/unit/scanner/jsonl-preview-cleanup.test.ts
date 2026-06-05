import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { JSONLScanner } from '../../../src/scanner/jsonl';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { FileCache } from '../../../src/scanner/cache';

describe('JSONLScanner.stripMarkdownNoise', () => {
  // 用 (JSONLScanner as any) 访问 private static method
  const strip = (s: string) => (JSONLScanner as any).stripMarkdownNoise(s);

  it('strips line-start heading markers (##, ###, etc.) but keeps text', () => {
    expect(strip('## 0. 内存膨胀分析')).toBe('0. 内存膨胀分析');
    expect(strip('### 0.1 单个 queue item 真实大小')).toBe('0.1 单个 queue item 真实大小');
    expect(strip('# 完整最终 Review 修改意见（决策版）')).toBe('完整最终 Review 修改意见（决策版）');
  });

  it('strips bold markers (**) but keeps text', () => {
    expect(strip('这是 **加粗** 文字')).toBe('这是 加粗 文字');
    expect(strip('**完全加粗**')).toBe('完全加粗');
  });

  it('strips inline code markers (`) but keeps code content', () => {
    expect(strip('看 `traeScanner` 代码')).toBe('看 traeScanner 代码');
    expect(strip('调用 `getCurrentTask` 方法')).toBe('调用 getCurrentTask 方法');
  });

  it('strips code block boundary markers (```)', () => {
    expect(strip('```typescript\nconst x = 1;\n```')).toBe('typescript\nconst x = 1;\n');
  });

  it('preserves list markers (-) and links [text](url)', () => {
    expect(strip('- 第一项\n- 第二项')).toBe('- 第一项\n- 第二项');
    expect(strip('看 [文档](https://example.com) 了解')).toBe('看 [文档](https://example.com) 了解');
  });
});

describe('JSONLScanner.truncateByLine', () => {
  const trunc = (s: string, max: number) => (JSONLScanner as any).truncateByLine(s, max);

  it('returns text unchanged when shorter than maxLength', () => {
    expect(trunc('短文本', 240)).toBe('短文本');
  });

  it('appends ... when no newline in first maxLength chars', () => {
    const text = 'a'.repeat(250);
    expect(trunc(text, 240)).toBe('a'.repeat(237) + '...');
  });

  it('truncates at last newline when newline is in latter half (>50%)', () => {
    // 5 行，每行 50 字符，总长 250；maxLength=120
    // 累积到第 3 行（150 字符）超出 120，找最后一个 \n (位置 100)
    // 截到位置 100 + '...'
    const text = 'a'.repeat(50) + '\n' + 'b'.repeat(50) + '\n' + 'c'.repeat(50) + '\n' + 'd'.repeat(50) + '\n' + 'e'.repeat(50);
    const result = trunc(text, 120);
    // 期望：截到第二个 \n（位置 101 之后，但 slice 排除该位置），
    //       得到 'a*50\nb*50'（位置 0-100）+ '...'
    // 修正：实现用 slice(0, lastNewline) 不含尾随 \n
    expect(result).toMatch(/^a+\nb+\.\.\.$/);
  });

  it('falls back to character truncation when newline in first half (<50%)', () => {
    // 新行在 first half (<50% of budget)，按字符截断
    // 30 chars + \n + 120 chars = 151 total, maxLength=100
    // budget = 97，slice(0, 97) 的 \n 在位置 30 < 48.5（50% of 97）→ 走 fallback
    const text = 'a'.repeat(30) + '\n' + 'b'.repeat(120);
    const result = trunc(text, 100);
    // 字符截断：slice(0, 97) + '...'（总长 100，≤ maxLength）
    expect(result).toBe('a'.repeat(30) + '\n' + 'b'.repeat(66) + '...');
  });

  it('uses character truncation when maxLength=240 and text is 250 chars with no newline', () => {
    const text = 'a'.repeat(250);
    const result = trunc(text, 240);
    expect(result).toBe('a'.repeat(237) + '...');
    expect(result.length).toBe(240);  // 关键不变量：≤ maxLength
  });
});

describe('JSONLScanner.cleanAssistantText', () => {
  const clean = (msgs: any[], max: number = 240) => (JSONLScanner as any).cleanAssistantText(msgs, max);

  function assistantMessage(content: any[]) {
    return { type: 'assistant', message: { role: 'assistant', content } };
  }

  it('skips thinking-only messages and returns earlier final answer', () => {
    const messages = [
      assistantMessage([{ type: 'text', text: '## 推荐路径：内存队列' }]),
      assistantMessage([{ type: 'thinking', thinking: '让我分析下...' }]),
    ];
    // 末条只 thinking → 跳过；找前一个；清 ## → 保留文字
    expect(clean(messages)).toBe('推荐路径：内存队列');
  });

  it('skips tool_use-only messages', () => {
    const messages = [
      assistantMessage([{ type: 'text', text: '## 上 git_bridge_queue 表的方案' }]),
      assistantMessage([{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }]),
    ];
    expect(clean(messages)).toBe('上 git_bridge_queue 表的方案');
  });

  it('skips midway state (text + tool_use together)', () => {
    const messages = [
      assistantMessage([{ type: 'text', text: '## 决策版' }]),
      assistantMessage([
        { type: 'text', text: '让我先看看代码' },  // 准备 tool call 的中间态
        { type: 'tool_use', id: 'x', name: 'Read', input: {} },
      ]),
    ];
    expect(clean(messages)).toBe('决策版');
  });

  it('returns null when no final answer exists (all thinking/tool_use)', () => {
    const messages = [
      assistantMessage([{ type: 'thinking', thinking: '...' }]),
      assistantMessage([{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }]),
    ];
    expect(clean(messages)).toBeNull();
  });

  it('merges multiple text blocks in same message with \\n separator', () => {
    const messages = [
      assistantMessage([
        { type: 'text', text: '第一段文字' },
        { type: 'text', text: '第二段文字' },
      ]),
    ];
    expect(clean(messages)).toBe('第一段文字\n第二段文字');
  });

  it('cleans markdown noise and truncates in one pass', () => {
    // 模拟截图里的真实场景：review 决策版 + 多级标题 + 加粗
    const messages = [
      assistantMessage([{
        type: 'text',
        text: '# 完整最终 Review 修改意见（决策版）\n\n## 0. 内存膨胀分析\n\n### 0.1 单个 queue item 真实大小\n\n看 `traeScanner` 代码...',
      }]),
    ];
    const result = clean(messages, 100);
    // 期望：# ## ### ` 都被清，保留文字；100 字符内可能按行截
    expect(result).not.toContain('#');
    expect(result).not.toContain('`');
    expect(result).toContain('完整最终 Review 修改意见');
    expect(result!.endsWith('...')).toBe(true);
  });

  it('returns null for empty input', () => {
    expect(clean([])).toBeNull();
  });

  it('returns null when all text blocks are empty strings', () => {
    const messages = [
      assistantMessage([
        { type: 'text', text: '' },
        { type: 'text', text: '' },
      ]),
    ];
    expect(clean(messages)).toBeNull();
  });

  it('skips message with only whitespace text and returns earlier real answer', () => {
    const messages = [
      assistantMessage([{ type: 'text', text: '## 真正回复' }]),
      assistantMessage([{ type: 'text', text: '   \n  \n' }]),  // 全空白
    ];
    expect(clean(messages)).toBe('真正回复');
  });

  it('skips non-assistant messages (user, system, etc.)', () => {
    const messages = [
      { type: 'user', message: { content: [{ type: 'text', text: '不应该是这个' }] } },
      assistantMessage([{ type: 'text', text: '## 正确回复' }]),
      { type: 'system', message: { content: [{ type: 'text', text: '系统消息' }] } },
    ];
    expect(clean(messages)).toBe('正确回复');
  });
});

describe('JSONLScanner.parseTail integration with cleanAssistantText', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-cleanup-test-'));
    projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-project');
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeScanner(): JSONLScanner {
    const registry = {
      has: () => true,
      get: () => ({ cwd: '/test', title: 'Test' }),
      upsert: () => {},
    };
    const cache: FileCache = new Map();
    return new (JSONLScanner as any)(registry, cache, tmpDir);
  }

  function writeLargeJsonl(lines: string[]): string {
    // 拼一个 > 4KB 的文件（用 padding tool_use 行撑大）
    const padding = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"pad","name":"Bash","input":{}}]}}\n';
    const paddedLines: string[] = [];
    let totalSize = 0;
    for (const line of lines) {
      paddedLines.push(line);
      totalSize += line.length + 1;
    }
    while (totalSize < 5000) {
      paddedLines.splice(paddedLines.length - 1, 0, padding);
      totalSize += padding.length;
    }
    const path = join(projectDir, 'session-cleanup-test.jsonl');
    writeFileSync(path, paddedLines.join('\n') + '\n');
    return path;
  }

  it('returns cleaned final answer when last 10 lines are tool_use, final answer is earlier', () => {
    const finalAnswer = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"## 决策版：内存队列"}]}}';
    const toolUseLine = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"Bash","input":{}}]}}';
    const path = writeLargeJsonl([finalAnswer, toolUseLine, toolUseLine, toolUseLine, toolUseLine, toolUseLine, toolUseLine, toolUseLine, toolUseLine, toolUseLine, toolUseLine, toolUseLine]);
    const scanner = makeScanner();
    const result = (scanner as any).parseTail(path);
    expect(result.last_assistant_preview).toBe('决策版：内存队列');
    expect(result.last_assistant_preview).not.toContain('##');
  });

  it('returns null last_assistant_preview when no final answer exists (all thinking)', () => {
    const thinkingLine = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"让我分析..."}]}}';
    const path = writeLargeJsonl([thinkingLine, thinkingLine, thinkingLine, thinkingLine, thinkingLine, thinkingLine, thinkingLine, thinkingLine, thinkingLine, thinkingLine, thinkingLine, thinkingLine]);
    const scanner = makeScanner();
    const result = (scanner as any).parseTail(path);
    expect(result.last_assistant_preview).toBeUndefined();
  });

  it('truncates to 240 chars with ... at end when content is longer', () => {
    const longText = 'a'.repeat(300);
    const longLine = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"${longText}"}]}}`;
    const path = writeLargeJsonl([longLine, longLine, longLine, longLine, longLine, longLine, longLine, longLine, longLine, longLine, longLine, longLine]);
    const scanner = makeScanner();
    const result = (scanner as any).parseTail(path);
    expect(result.last_assistant_preview).toBe('a'.repeat(237) + '...');
    expect(result.last_assistant_preview?.length).toBeLessThanOrEqual(240);
  });

  it('falls back to full file read when tail 4KB has no final answer (large file scenario)', () => {
    // 场景：last 10 行都是 tool_use，final answer 在第 5 行
    // parseTail 4KB 内找不到，触发全量重读
    const finalAnswer = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"## 真正回复"}]}}';
    const toolUse = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"Bash","input":{}}]}}';
    const path = writeLargeJsonl([finalAnswer, toolUse, toolUse, toolUse, toolUse, toolUse, toolUse, toolUse, toolUse, toolUse, toolUse, toolUse, toolUse, toolUse, toolUse]);
    const scanner = makeScanner();
    const result = (scanner as any).parseTail(path);
    expect(result.last_assistant_preview).toBe('真正回复');
  });
});

describe('JSONLScanner.parseFull integration with cleanAssistantText', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-cleanup-parsefull-'));
    projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-project');
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeScanner(): JSONLScanner {
    const registry = {
      has: () => false,
      get: () => undefined,
      upsert: () => {},
    };
    const cache: FileCache = new Map();
    return new (JSONLScanner as any)(registry, cache, tmpDir);
  }

  function writeJsonl(lines: string[]): string {
    const path = join(projectDir, 'session-parsefull.jsonl');
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

  it('returns cleaned final answer in parseFull result', () => {
    const lines = [
      '{"type":"user","message":{"content":"问题"}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"## 决策版"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"Bash","input":{}}]}}',
    ];
    const path = writeJsonl(lines);
    const scanner = makeScanner();
    const result = (scanner as any).parseFull(path, 'session-parsefull');
    expect(result.last_assistant_preview).toBe('决策版');
    expect(result.last_assistant_preview).not.toContain('##');
  });

  it('parseFull result has last_assistant_preview up to 240 chars', () => {
    const longText = 'b'.repeat(300);
    const lines = [
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"${longText}"}]}}`,
    ];
    const path = writeJsonl(lines);
    const scanner = makeScanner();
    const result = (scanner as any).parseFull(path, 'session-parsefull');
    expect(result.last_assistant_preview).toBe('b'.repeat(237) + '...');
    expect(result.last_assistant_preview?.length).toBeLessThanOrEqual(240);
  });
});

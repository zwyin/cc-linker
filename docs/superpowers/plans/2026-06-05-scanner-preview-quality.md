# Scanner Preview Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve `last_assistant_preview` quality by cleaning markdown noise, extending length from 80 to 240 characters, and skipping thinking/intermediate-state assistant messages.

**Architecture:** Add 3 static helper methods to `JSONLScanner` (`stripMarkdownNoise`, `truncateByLine`, `cleanAssistantText`). Replace the existing 80-char raw extraction in `parseTail` and `parseFull` with calls to `cleanAssistantText`. Zero changes to render-side code.

**Tech Stack:** Bun + bun:test + TypeScript (existing project stack).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/scanner/jsonl.ts` | Add 3 static methods; refactor `parseTail`/`parseFull` to use them |
| `src/registry/types.ts` | JSDoc comment update for `last_assistant_preview` field (zod schema unchanged) |
| `tests/unit/scanner/jsonl-preview-cleanup.test.ts` | **NEW** — 13 unit tests for the 3 static methods + integration with file I/O |
| `tests/unit/scanner/jsonl-preview.test.ts` | **MODIFY** — adapt existing 80-char assertions to 240-char cleaned output |
| `tests/integration/scanner-preview-migration.test.ts` | **NEW** — end-to-end migration test (old 80-char raw → new 240-char cleaned after sync) |

---

## Task 1: stripMarkdownNoise (TDD)

**Files:**
- Modify: `src/scanner/jsonl.ts` (add static method, no usage yet)
- Test: `tests/unit/scanner/jsonl-preview-cleanup.test.ts` (new file)

- [ ] **Step 1: Create the new test file with failing tests for stripMarkdownNoise**

Create `tests/unit/scanner/jsonl-preview-cleanup.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { JSONLScanner } from '../../../src/scanner/jsonl';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/scanner/jsonl-preview-cleanup.test.ts`
Expected: FAIL with "stripMarkdownNoise is not a function" or similar.

- [ ] **Step 3: Implement stripMarkdownNoise as a private static method**

In `src/scanner/jsonl.ts`, add to the `JSONLScanner` class (after `extractTextContent` method, around line 132):

```typescript
  /**
   * 清理 markdown 结构化噪声（standard 级别）
   *
   * 规则：
   * - /^#{1,6}\s+/gm → ''        行首标题符号
   * - /\*\*/g        → ''        加粗
   * - /`/g           → ''        行内代码标记 + 代码块边界
   *
   * 保留：标题文字、代码内容、列表 -、链接 [text](url)、blockquote >
   */
  private static stripMarkdownNoise(text: string): string {
    return text
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '');
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/scanner/jsonl-preview-cleanup.test.ts`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/scanner/jsonl.ts tests/unit/scanner/jsonl-preview-cleanup.test.ts
git commit -m "feat(scanner): stripMarkdownNoise 清理 ##/**/\` 噪声"
```

---

## Task 2: truncateByLine (TDD)

**Files:**
- Modify: `src/scanner/jsonl.ts` (add static method)
- Test: `tests/unit/scanner/jsonl-preview-cleanup.test.ts` (append)

- [ ] **Step 1: Add failing tests for truncateByLine to existing test file**

Append to `tests/unit/scanner/jsonl-preview-cleanup.test.ts` (before the closing `}` of the file, after stripMarkdownNoise describe block):

```typescript
describe('JSONLScanner.truncateByLine', () => {
  const trunc = (s: string, max: number) => (JSONLScanner as any).truncateByLine(s, max);

  it('returns text unchanged when shorter than maxLength', () => {
    expect(trunc('短文本', 240)).toBe('短文本');
  });

  it('appends ... when no newline in first maxLength chars', () => {
    const text = 'a'.repeat(250);
    expect(trunc(text, 240)).toBe('a'.repeat(240) + '...');
  });

  it('truncates at last newline when newline is in latter half (>50%)', () => {
    // 5 行，每行 50 字符，总长 250；maxLength=120
    // 累积到第 3 行（150 字符）超出 120，找最后一个 \n (位置 100)
    // 截到位置 100 + '...'
    const text = 'a'.repeat(50) + '\n' + 'b'.repeat(50) + '\n' + 'c'.repeat(50) + '\n' + 'd'.repeat(50) + '\n' + 'e'.repeat(50);
    const result = trunc(text, 120);
    // 期望：截到第二个 \n（位置 100 之后），得到 'aaa...bbb...' 加 '...'
    expect(result).toMatch(/^a+\nb+\n\.\.\.$/);
  });

  it('falls back to character truncation when newline in first half (<50%)', () => {
    // 大部分内容都在 1 行，只在末尾有 \n
    // 如果按 \n 截会丢失太多内容，改为按字符截
    const text = 'a'.repeat(240) + '\n' + 'b'.repeat(20);
    const result = trunc(text, 250);
    // 期望：第 250 字符不在 \n（这里我们用 maxLength=250 不触发截断，验证 fallback 路径）
    expect(result).toBe(text);
  });

  it('uses character truncation when maxLength=240 and text is 250 chars with no newline', () => {
    const text = 'a'.repeat(250);
    const result = trunc(text, 240);
    expect(result).toBe('a'.repeat(240) + '...');
    expect(result.length).toBe(243);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/scanner/jsonl-preview-cleanup.test.ts`
Expected: FAIL with "truncateByLine is not a function".

- [ ] **Step 3: Implement truncateByLine**

In `src/scanner/jsonl.ts`, add after `stripMarkdownNoise`:

```typescript
  /**
   * 截断到 maxLength，按行边界回退
   *
   * 规则：
   * - 如果原文长度 ≤ maxLength，直接返回
   * - 否则按 \n 分割，找累积长度 ≤ maxLength 的最后一个行边界
   * - 截断后追加 '...'
   *
   * 例：
   * - maxLength=240，文本 250 字符无 \n → slice(0, 240) + '...'
   * - maxLength=240，文本 300 字符（10 行，每行 30）在第 9 行结束 → 截到第 9 行 + '...'
   * - 截断后保留 < 50% maxLength → 仍按字符截（不强行按行）
   */
  private static truncateByLine(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    const truncated = text.slice(0, maxLength);
    const lastNewline = truncated.lastIndexOf('\n');
    if (lastNewline > maxLength * 0.5) {
      return truncated.slice(0, lastNewline) + '...';
    }
    return truncated + '...';
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/scanner/jsonl-preview-cleanup.test.ts`
Expected: 5 (stripMarkdownNoise) + 5 (truncateByLine) = 10 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/scanner/jsonl.ts tests/unit/scanner/jsonl-preview-cleanup.test.ts
git commit -m "feat(scanner): truncateByLine 智能按行截断（240 字符）"
```

---

## Task 3: cleanAssistantText (TDD)

**Files:**
- Modify: `src/scanner/jsonl.ts` (add static method, uses stripMarkdownNoise + truncateByLine)
- Test: `tests/unit/scanner/jsonl-preview-cleanup.test.ts` (append)

- [ ] **Step 1: Add failing tests for cleanAssistantText**

Append to `tests/unit/scanner/jsonl-preview-cleanup.test.ts`:

```typescript
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

  it('skips non-assistant messages (user, system, etc.)', () => {
    const messages = [
      { type: 'user', message: { content: [{ type: 'text', text: '不应该是这个' }] } },
      assistantMessage([{ type: 'text', text: '## 正确回复' }]),
      { type: 'system', message: { content: [{ type: 'text', text: '系统消息' }] } },
    ];
    expect(clean(messages)).toBe('正确回复');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/scanner/jsonl-preview-cleanup.test.ts`
Expected: FAIL with "cleanAssistantText is not a function".

- [ ] **Step 3: Implement cleanAssistantText**

In `src/scanner/jsonl.ts`, add after `truncateByLine`:

```typescript
  /**
   * 从 assistant message 数组中提取 cleaned final-answer text
   *
   * 算法（与 JSDoc 严格对应）：
   * 1. 倒序遍历 messages
   * 2. 跳过非 assistant message
   * 3. 跳过 content 不是数组的（防御性，覆盖 string content 形态）
   * 4. 跳过中间态（has tool_use）
   * 5. 跳过无 text 块的（自然过滤 thinking-only / tool_use-only）
   * 6. 合并该 message 的所有 text 块（用 \n 连接）
   * 7. markdown 清理（standard 级别）
   * 8. 截断 maxLength 字符，按行边界回退
   *
   * 边界处理：
   * - 没找到符合的 → 返回 null
   * - text 块全空 → 返回 null（被 step 5 过滤）
   */
  private static cleanAssistantText(
    messages: Array<{ type: string; message?: { content?: unknown } }>,
    maxLength: number = 240,
  ): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const entry = messages[i];
      if (entry.type !== 'assistant') continue;

      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;

      const hasToolUse = content.some((b: any) => b?.type === 'tool_use');
      if (hasToolUse) continue;

      const textBlocks = content
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text);
      if (textBlocks.length === 0) continue;

      const raw = textBlocks.join('\n');
      const cleaned = JSONLScanner.stripMarkdownNoise(raw);
      const truncated = JSONLScanner.truncateByLine(cleaned, maxLength);

      return truncated;
    }
    return null;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/scanner/jsonl-preview-cleanup.test.ts`
Expected: 5 (strip) + 5 (truncate) + 8 (cleanAssistantText) = 18 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/scanner/jsonl.ts tests/unit/scanner/jsonl-preview-cleanup.test.ts
git commit -m "feat(scanner): cleanAssistantText 提取 cleaned final-answer 240 字符"
```

---

## Task 4: parseTail integration (TDD via file I/O)

**Files:**
- Modify: `src/scanner/jsonl.ts` (`parseTail` method, lines ~245-360)
- Test: `tests/unit/scanner/jsonl-preview-cleanup.test.ts` (append file-based tests)

- [ ] **Step 1: Add failing tests for parseTail integration**

Append to `tests/unit/scanner/jsonl-preview-cleanup.test.ts` (imports already include file I/O from jsonl-preview.test.ts — verify or add):

```typescript
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { JSONLScanner } from '../../../src/scanner/jsonl';
import { FileCache } from '../../../src/scanner/cache';

// ... (上面 18 个测试已存在)

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
    expect(result.last_assistant_preview).toBe('a'.repeat(240) + '...');
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/scanner/jsonl-preview-cleanup.test.ts`
Expected: parseTail integration tests FAIL (existing parseTail still extracts first text block of LAST assistant message, which is tool_use-only or doesn't strip markdown).

- [ ] **Step 3: Modify parseTail to use cleanAssistantText**

In `src/scanner/jsonl.ts`, find `parseTail` method (line 245+). The current logic has these key blocks:
- Line 263-289: tail 4KB loop with `if (entry.type === 'assistant' && !preview)` extracting first text block
- Line 296-320: 4KB fallback for lastUserPreview

Make these changes:

**A. Replace the assistant extraction in tail 4KB loop (lines 269-272)**:

Current:
```typescript
            if (entry.type === 'assistant' && !preview) {
              const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
              if (textBlock) preview = textBlock.text.slice(0, 100);
            }
```

Replace with (collect messages, defer extraction):
```typescript
            if (entry.type === 'assistant') {
              assistantMessages.push(entry);
            }
```

Add before the loop (line 263 area, after `const tailLines = ...`):

```typescript
        const assistantMessages: Array<{ type: string; message?: { content?: unknown } }> = [];
```

**B. After the tail 4KB loop, call cleanAssistantText (line 292 area, before the fallback block):**

```typescript
        if (!preview) {
          preview = JSONLScanner.cleanAssistantText(assistantMessages, 240) ?? '';
        }
```

**C. Extend the 4KB fallback to also call cleanAssistantText (line 296-320, inside the `if (!lastUserPreview && stat.size > 4096)` block):**

The current fallback only looks for `lastUserPreview`. Add parallel logic for `preview` (the local variable used in parseTail for last_assistant_preview).

Find the fallback block (look for `if (!lastUserPreview && stat.size > 4096)`):

```typescript
        // 4KB 内找不到 user preview 时全量重读（fallback）
        if (!lastUserPreview && stat.size > 4096) {
          try {
            const fullContent = readFileSync(filePath, 'utf8');
            const allLines = fullContent.split('\n').filter(Boolean);
            for (let i = allLines.length - 1; i >= 0; i--) {
              try {
                const entry = JSON.parse(allLines[i]);
                if (entry.type === 'user') {
                  const text = JSONLScanner.extractTextContent(entry.message?.content);
                  if (text) {
                    lastUserPreview = text.slice(0, 100);
                    break;
                  }
                }
                // 全量 fallback 时也顺便收集 lastPrompt
                if (entry.type === 'last-prompt' && !lastPrompt && entry.lastPrompt) {
                  lastPrompt = entry.lastPrompt;
                }
              } catch {}
            }
          } catch (err) {
            logger.warn(`parseTail 全量 fallback 失败: ${filePath}: ${err}`);
          }
        }
```

Change the condition to also trigger when `!preview`:

```typescript
        // 4KB 内找不到 user preview 或 assistant preview 时全量重读
        if ((!lastUserPreview || !preview) && stat.size > 4096) {
          try {
            const fullContent = readFileSync(filePath, 'utf8');
            const allLines = fullContent.split('\n').filter(Boolean);
            const fullAssistantMessages: Array<{ type: string; message?: { content?: unknown } }> = [];
            for (let i = allLines.length - 1; i >= 0; i--) {
              try {
                const entry = JSON.parse(allLines[i]);
                if (!lastUserPreview && entry.type === 'user') {
                  const text = JSONLScanner.extractTextContent(entry.message?.content);
                  if (text) {
                    lastUserPreview = text.slice(0, 100);
                  }
                }
                if (!preview && entry.type === 'assistant') {
                  fullAssistantMessages.push(entry);
                }
                // 全量 fallback 时也顺便收集 lastPrompt
                if (entry.type === 'last-prompt' && !lastPrompt && entry.lastPrompt) {
                  lastPrompt = entry.lastPrompt;
                }
              } catch {}
            }
            if (!preview && fullAssistantMessages.length > 0) {
              const cleanedFromFull = JSONLScanner.cleanAssistantText(fullAssistantMessages, 240);
              if (cleanedFromFull) preview = cleanedFromFull;
            }
          } catch (err) {
            logger.warn(`parseTail 全量 fallback 失败: ${filePath}: ${err}`);
          }
        }
```

**D. Update the return block at the end of parseTail (line 354-360):**

Current:
```typescript
      return {
        ...(lineCount > 0 ? { message_count: lineCount } : {}),
        ...(lastActive ? { last_active: lastActive } : {}),
        ...(lastMessagePreview ? { last_message_preview: lastMessagePreview } : {}),
        ...(preview ? { last_assistant_preview: preview.slice(0, 80) } : {}),
        ...(lastUserPreview ? { last_user_preview: lastUserPreview.slice(0, 80) } : {}),
      };
```

Change `preview.slice(0, 80)` → `preview.slice(0, 240)` (defensive; cleanAssistantText already truncated to 240, but slice is no-op):

```typescript
      return {
        ...(lineCount > 0 ? { message_count: lineCount } : {}),
        ...(lastActive ? { last_active: lastActive } : {}),
        ...(lastMessagePreview ? { last_message_preview: lastMessagePreview } : {}),
        ...(preview ? { last_assistant_preview: preview.slice(0, 240) } : {}),
        ...(lastUserPreview ? { last_user_preview: lastUserPreview.slice(0, 80) } : {}),
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/scanner/jsonl-preview-cleanup.test.ts`
Expected: 18 (static) + 4 (integration) = 22 pass, 0 fail.

- [ ] **Step 5: Run existing jsonl-preview.test.ts to see what breaks**

Run: `bun test tests/unit/scanner/jsonl-preview.test.ts`
Expected: Some tests fail because they assert 80-char raw behavior. We'll fix them in Task 7.

Don't fix yet, just observe. This is expected breakage from the algorithm change.

- [ ] **Step 6: Commit parseTail changes**

```bash
git add src/scanner/jsonl.ts tests/unit/scanner/jsonl-preview-cleanup.test.ts
git commit -m "feat(scanner): parseTail 走 cleanAssistantText 路径

- 收集 assistant messages 后调 cleanAssistantText（8 步算法）
- 4KB fallback 同步调用 cleanAssistantText（覆盖末条 tool_use 的场景）
- return 长度 80→240 字符"
```

---

## Task 5: parseFull integration (TDD)

**Files:**
- Modify: `src/scanner/jsonl.ts` (`parseFull` method, lines 132-243)
- Test: `tests/unit/scanner/jsonl-preview-cleanup.test.ts` (append)

- [ ] **Step 1: Add failing test for parseFull integration**

Append to `tests/unit/scanner/jsonl-preview-cleanup.test.ts`:

```typescript
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
    expect(result.last_assistant_preview).toBe('b'.repeat(240) + '...');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/scanner/jsonl-preview-cleanup.test.ts`
Expected: parseFull integration tests FAIL.

- [ ] **Step 3: Modify parseFull to use cleanAssistantText**

In `src/scanner/jsonl.ts`, find `parseFull` (line 132). The current logic has an assistant extraction in the lines loop.

**A. Replace the assistant extraction (lines 184-189 in the loop):**

Current:
```typescript
          if (entry.type === 'assistant' && !preview) {
            const text = JSONLScanner.extractTextContent(entry.message?.content);
            if (text) preview = text.slice(0, 100);
          }
```

Replace with:
```typescript
          if (entry.type === 'assistant') {
            assistantMessages.push(entry);
          }
```

**B. Add collection variable near the top of parseFull (after the other `let` declarations around line 142):**

```typescript
    const assistantMessages: Array<{ type: string; message?: { content?: unknown } }> = [];
```

**C. After the lines loop (around line 195, before the return), call cleanAssistantText:**

```typescript
    // 调 cleanAssistantText 拿到 cleaned assistant text（如果有）
    if (!preview) {
      preview = JSONLScanner.cleanAssistantText(assistantMessages, 240) ?? '';
    }
```

**D. Update the return block (line 235-239):**

Current:
```typescript
      last_message_preview: preview || lastPrompt?.slice(0, 100) || '[无内容]',
      last_assistant_preview: preview ? preview.slice(0, 80) : undefined,
```

Change to use the cleaned preview but DON'T break last_message_preview (which is for backward compat):

```typescript
      // cleaned preview 已有 240 字符；last_message_preview 保留 100 字符（向后兼容）
      last_message_preview: preview ? preview.slice(0, 100) : (lastPrompt?.slice(0, 100) || '[无内容]'),
      last_assistant_preview: preview ? preview.slice(0, 240) : undefined,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/scanner/jsonl-preview-cleanup.test.ts`
Expected: 22 (parseTail integration) + 2 (parseFull integration) = 24 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/scanner/jsonl.ts tests/unit/scanner/jsonl-preview-cleanup.test.ts
git commit -m "feat(scanner): parseFull 走 cleanAssistantText 路径

- 收集 assistant messages 后调 cleanAssistantText
- last_message_preview 保留 100 字符（向后兼容）
- last_assistant_preview 升至 240 字符"
```

---

## Task 6: types.ts JSDoc update (no TDD)

**Files:**
- Modify: `src/registry/types.ts` (JSDoc only, zod schema unchanged)

- [ ] **Step 1: Find and update the JSDoc comment for last_assistant_preview**

In `src/registry/types.ts`, find the `SessionEntrySchema` definition. Look for the field `last_assistant_preview` and the surrounding JSDoc.

Current (approximate, search for "last_assistant_preview" in the file):
```typescript
  // last_message_preview: 100 字符 raw markdown（CLI / bot 多处复用）
  // last_assistant_preview: 80 字符 raw markdown
  // last_user_preview: 80 字符 raw user prompt
```

Update to:
```typescript
  // last_message_preview: 100 字符 raw markdown（CLI / bot 多处复用，保留向后兼容）
  // last_assistant_preview: 240 字符 cleaned（去 ##/**/`/``` 后，bot 概览卡片专用）
  // last_user_preview: 80 字符 raw user prompt（向后兼容）
```

- [ ] **Step 2: Verify zod schema unchanged**

Run: `git diff src/registry/types.ts`
Expected: Only JSDoc comment changes, no `z.string()` or schema change.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/registry/types.ts
git commit -m "docs(types): 更新 last_assistant_preview JSDoc（240 字符 cleaned）"
```

---

## Task 7: Update existing jsonl-preview.test.ts assertions (80 → 240)

**Files:**
- Modify: `tests/unit/scanner/jsonl-preview.test.ts` (assertion adaptations)

- [ ] **Step 1: Identify which existing tests will fail**

Run: `bun test tests/unit/scanner/jsonl-preview.test.ts 2>&1 | head -80`
Expected: 3-5 tests fail. Common patterns:
- `expect(entry?.last_assistant_preview).toBe('Hello world response')` — should still pass (short text)
- `expect(entry?.last_assistant_preview?.length).toBe(80)` — will fail (now 240 max or shorter)
- Tests asserting `##` in preview — will fail (now stripped)

- [ ] **Step 2: Update failing assertions**

For each failing test, change the assertion to match the new cleaned 240-char output. Patterns to look for:

```typescript
// BEFORE
expect(entry?.last_assistant_preview).toBe('## 完整最终 Review 修改意见（决策版）\n\n## 0. 内存膨胀分析...');
expect(entry?.last_assistant_preview?.length).toBe(80);
expect(entry?.last_assistant_preview).toContain('##');

// AFTER
expect(entry?.last_assistant_preview).toBe('完整最终 Review 修改意见（决策版）\n\n0. 内存膨胀分析...');
expect(entry?.last_assistant_preview?.length).toBeLessThanOrEqual(240);
expect(entry?.last_assistant_preview).not.toContain('##');
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `bun test tests/unit/scanner/jsonl-preview.test.ts`
Expected: All tests pass.

- [ ] **Step 4: Run jsonl.test.ts (broader scanner tests) to check for breakage**

Run: `bun test tests/unit/scanner/jsonl.test.ts`
Expected: All tests pass. If any fail, check if they're asserting old `last_assistant_preview` 80-char behavior; update as needed.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/scanner/jsonl-preview.test.ts tests/unit/scanner/jsonl.test.ts
git commit -m "test(scanner): 适配 last_assistant_preview 240 字符 cleaned 输出"
```

---

## Task 8: Integration test — full sync migration

**Files:**
- Create: `tests/integration/scanner-preview-migration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/scanner-preview-migration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RegistryManager } from '../../src/registry';
import { syncBeforeCommand } from '../../src/scanner';
import { loadCache, saveCache } from '../../src/scanner/cache';

describe('Scanner preview migration: old 80-char raw → new 240-char cleaned', () => {
  let tmpDir: string;
  let ccLinkerDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scanner-migration-test-'));
    ccLinkerDir = join(tmpDir, '.cc-linker');
    projectsDir = join(tmpDir, '.claude', 'projects', '-Users-test-project');
    mkdirSync(ccLinkerDir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('after sync, last_assistant_preview is cleaned 240 chars (no ## /** /`)', async () => {
    // 写一个 JSONL：模拟 user prompt + 复杂 assistant 回复（带 markdown 标题/加粗/代码）
    const sessionId = 'test-migration-1';
    const jsonlPath = join(projectsDir, `${sessionId}.jsonl`);
    const longText = '# 完整最终 Review 修改意见（决策版）\n\n## 0. 内存膨胀分析\n\n### 0.1 单个 queue item 真实大小\n\n看 `traeScanner` 代码，这是 **关键** 路径';
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '用户问题' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: longText }] } }),
    ].join('\n') + '\n');

    // 创建 registry（v4 schema, last_assistant_preview 模拟老 80 字符 raw 数据）
    const registry = new RegistryManager(join(ccLinkerDir, 'registry.json'));
    await registry.load();
    registry.upsert(sessionId, {
      origin: 'cli',
      cwd: '/test',
      jsonl_path: jsonlPath,
      project_name: 'test',
      // 模拟老数据：80 字符 raw markdown
      last_assistant_preview: '# 完整最终 Review 修改意见（决策版）\n\n## 0. 内存膨胀分析\n\n### 0.1 单',
    });

    // 跑 sync
    const cachePath = join(ccLinkerDir, 'scan_cache.json');
    saveCache(new Map(), cachePath);  // 清 cache 强制全量重扫
    await syncBeforeCommand(registry, cachePath);

    // 验证：last_assistant_preview 被更新为 cleaned 240 字符，无 ## 等 markdown 符号
    const entry = registry.get(sessionId);
    expect(entry?.last_assistant_preview).toBeDefined();
    expect(entry!.last_assistant_preview).not.toContain('##');
    expect(entry!.last_assistant_preview).not.toContain('**');
    expect(entry!.last_assistant_preview).not.toContain('`');
    expect(entry!.last_assistant_preview).toContain('完整最终 Review 修改意见');
    expect(entry!.last_assistant_preview!.length).toBeLessThanOrEqual(240);
  });

  it('skip thinking + midway state: last_assistant_preview jumps to earlier final answer', async () => {
    const sessionId = 'test-migration-2';
    const jsonlPath = join(projectsDir, `${sessionId}.jsonl`);
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'user', message: { content: '问题' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '## 真正回复：内存队列方案' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '让我分析...' }] } }),
    ].join('\n') + '\n');

    const registry = new RegistryManager(join(ccLinkerDir, 'registry.json'));
    await registry.load();
    registry.upsert(sessionId, {
      origin: 'cli',
      cwd: '/test',
      jsonl_path: jsonlPath,
      project_name: 'test',
    });

    const cachePath = join(ccLinkerDir, 'scan_cache.json');
    saveCache(new Map(), cachePath);
    await syncBeforeCommand(registry, cachePath);

    const entry = registry.get(sessionId);
    // 末条是 thinking-only → 跳过；找前一个 final answer
    expect(entry?.last_assistant_preview).toBe('真正回复：内存队列方案');
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `bun test tests/integration/scanner-preview-migration.test.ts`
Expected: 2 pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/scanner-preview-migration.test.ts
git commit -m "test(integration): scanner preview 迁移全量重扫验证"
```

---

## Task 9: Final regression

**Files:** none modified (verification only)

- [ ] **Step 1: Run full test suite**

Run: `bun test 2>&1 | tail -10`
Expected: All tests pass. Count should be ~425+ (415 existing + ~10 new).

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 3: Run build**

Run: `bun run build`
Expected: `dist/cc-linker` built successfully.

- [ ] **Step 4: Manual smoke test on real registry (optional but recommended)**

```bash
# 备份当前 registry
cp ~/.cc-linker/registry.json /tmp/registry-before-scanner-quality.json
# 跑 sync --force 触发全量重扫
bun run dev sync --force
# 检查 last_assistant_preview 不含 ## 符号
jq '[.sessions | to_entries[] | select((.value.last_assistant_preview // "") | contains("##"))] | length' ~/.cc-linker/registry.json
# 期望：0
# 检查 last_assistant_preview 长度分布
jq '[.sessions | to_entries[].value.last_assistant_preview | select(. != null) | length] | {min: min, max: max, avg: (add / length)}' ~/.cc-linker/registry.json
# 期望：max ≤ 240, avg > 80（说明很多 session 之前是 80 截断，现在得到更长）
```

- [ ] **Step 5: Final commit if any leftover changes**

```bash
git status  # should be clean
```

- [ ] **Step 6: Report completion**

Report to user:
- ✅ Task 1-8 done
- ✅ All 9 tasks committed
- ✅ 425+ tests pass
- ✅ typecheck + build clean
- ✅ Real registry sync --force verified (or skipped if user prefers)

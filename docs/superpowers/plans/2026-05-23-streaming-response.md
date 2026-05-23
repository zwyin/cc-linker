# Streaming Response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable real-time streaming of Claude's thinking and response progress to Feishu via interactive card messages with patch updates.

**Architecture:** Add `sendStreamingMessage()` to SessionManager using `--output-format stream-json`. Pipe chunks through StreamParser (filters hook noise, extracts thinking/text/result). CardUpdater manages Feishu card lifecycle (create → throttle patch → complete/error) at 1500ms intervals. Non-streaming path unchanged.

**Tech Stack:** TypeScript, Bun, @larksuiteoapi/node-sdk (im.v1.message.create + im.v1.message.patch)

---

### Task 1: Config — Add `[stream]` section

**Files:**
- Modify: `src/utils/config.ts`
- Test: `tests/unit/utils/config.test.ts` (existing)

- [ ] **Step 1: Add stream section to ConfigData interface and defaults**

In `src/utils/config.ts`, add to the `ConfigData` interface (after `hook`):

```typescript
  stream: {
    enabled: boolean;
    throttle_ms: number;
    show_thinking: boolean;
    max_card_bytes: number;
    fallback_to_text: boolean;
  };
```

In `DEFAULTS` (after `hook`):

```typescript
  stream: {
    enabled: true,
    throttle_ms: 1500,
    show_thinking: true,
    max_card_bytes: 25000,
    fallback_to_text: true,
  },
```

In `cloneDefaults()` (after `hook`):

```typescript
    stream: { ...DEFAULTS.stream },
```

- [ ] **Step 2: Add env variable mappings**

In `loadEnv()` mappings array, add:

```typescript
['CC_BRIDGE_STREAM_ENABLED', 'stream', 'enabled'],
['CC_BRIDGE_STREAM_THROTTLE_MS', 'stream', 'throttle_ms'],
['CC_BRIDGE_STREAM_SHOW_THINKING', 'stream', 'show_thinking'],
['CC_BRIDGE_STREAM_MAX_CARD_BYTES', 'stream', 'max_card_bytes'],
['CC_BRIDGE_STREAM_FALLBACK_TO_TEXT', 'stream', 'fallback_to_text'],
```

- [ ] **Step 3: Run tests and verify**

```bash
bun test tests/unit/utils/config.test.ts
```
Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/utils/config.ts
git commit -m "feat(stream): add [stream] config section with env vars"
```

---

### Task 2: Stream Parser — Parse stream-json output

**Files:**
- Create: `src/proxy/stream-parser.ts`
- Create: `tests/unit/proxy/stream-parser.test.ts`

- [ ] **Step 1: Write tests for StreamParser**

```typescript
// tests/unit/proxy/stream-parser.test.ts
import { test, expect } from 'bun:test';
import { StreamParser } from '../../proxy/stream-parser';

test('filters system lines', () => {
  const parser = new StreamParser();
  expect(parser.parseLine('{"type":"system","subtype":"hook_started"}')).toBeNull();
});

test('extracts thinking content from assistant', () => {
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', text: 'Let me think...' }] }
  });
  const result = parser.parseLine(line);
  expect(result).not.toBeNull();
  expect(result!.type).toBe('thinking');
  expect(result!.content).toBe('Let me think...');
});

test('extracts text content from assistant', () => {
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello world' }] }
  });
  const result = parser.parseLine(line);
  expect(result).not.toBeNull();
  expect(result!.type).toBe('text');
  expect(result!.content).toBe('Hello world');
});

test('returns null for assistant with no content', () => {
  const parser = new StreamParser();
  expect(parser.parseLine(JSON.stringify({ type: 'assistant', message: {} }))).toBeNull();
});

test('returns null for unknown type', () => {
  const parser = new StreamParser();
  expect(parser.parseLine(JSON.stringify({ type: 'unknown' }))).toBeNull();
});

test('returns result chunk when type=result', () => {
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'result', subtype: 'success', result: 'Final answer',
    session_id: 'abc-123', total_cost_usd: 0.05, duration_ms: 2000,
    stop_reason: 'end_turn',
  });
  const result = parser.parseLine(line);
  expect(result).not.toBeNull();
  expect(result!.type).toBe('result');
  expect((result as any).result).toBe('Final answer');
  expect((result as any).session_id).toBe('abc-123');
  expect((result as any).total_cost_usd).toBe(0.05);
});

test('handles multiple content blocks — returns first non-null', () => {
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [
      { type: 'thinking', text: 'thinking...' },
      { type: 'text', text: 'response...' }
    ]}
  });
  const result = parser.parseLine(line);
  expect(result!.type).toBe('thinking');
});

test('handles invalid JSON gracefully', () => {
  const parser = new StreamParser();
  expect(parser.parseLine('not json')).toBeNull();
});

test('handles empty lines', () => {
  const parser = new StreamParser();
  expect(parser.parseLine('')).toBeNull();
  expect(parser.parseLine('   ')).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/unit/proxy/stream-parser.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write StreamParser implementation**

```typescript
// src/proxy/stream-parser.ts
import { logger } from '../utils/logger';

export type StreamChunkType = 'thinking' | 'text' | 'result';

export interface ThinkingChunk {
  type: 'thinking';
  content: string;
}

export interface TextChunk {
  type: 'text';
  content: string;
}

export interface ResultChunk {
  type: 'result';
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  stop_reason: string | null;
  subtype?: string;
  is_error?: boolean;
  errors?: string[];
}

export type StreamChunk = ThinkingChunk | TextChunk | ResultChunk;

/**
 * Parse Claude stream-json output lines.
 * Filters hook noise (type=system), extracts thinking/text/result blocks.
 */
export class StreamParser {
  parseLine(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      logger.debug(`StreamParser: invalid JSON: ${trimmed.slice(0, 100)}`);
      return null;
    }

    const type = obj.type as string | undefined;
    if (type === 'system') return null;
    if (type === 'assistant') return this.parseAssistant(obj);
    if (type === 'result') return this.parseResult(obj);

    logger.debug(`StreamParser: unknown type: ${type}`);
    return null;
  }

  private parseAssistant(obj: Record<string, unknown>): StreamChunk | null {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) return null;
    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!content?.length) return null;

    for (const block of content) {
      const blockType = block.type as string | undefined;
      if (blockType === 'thinking' && typeof block.text === 'string') {
        return { type: 'thinking', content: block.text };
      }
      if (blockType === 'text' && typeof block.text === 'string') {
        return { type: 'text', content: block.text };
      }
    }
    return null;
  }

  private parseResult(obj: Record<string, unknown>): ResultChunk {
    return {
      type: 'result',
      result: (obj.result as string) ?? '',
      session_id: (obj.session_id as string) ?? '',
      total_cost_usd: (obj.total_cost_usd as number) ?? 0,
      duration_ms: (obj.duration_ms as number) ?? 0,
      stop_reason: (obj.stop_reason as string | null) ?? null,
      subtype: obj.subtype as string | undefined,
      is_error: obj.is_error as boolean | undefined,
      errors: obj.errors as string[] | undefined,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/unit/proxy/stream-parser.test.ts
```
Expected: All 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/proxy/stream-parser.ts tests/unit/proxy/stream-parser.test.ts
git commit -m "feat(stream): add StreamParser for stream-json output"
```

---

### Task 3: Card Updater — Send and patch Feishu interactive cards

**Files:**
- Create: `src/feishu/card-updater.ts`
- Create: `tests/unit/feishu/card-updater.test.ts`

- [ ] **Step 1: Write tests for CardUpdater**

```typescript
// tests/unit/feishu/card-updater.test.ts
import { test, expect, mock, describe, beforeEach, afterEach } from 'bun:test';
import { CardUpdater } from '../../feishu/card-updater';

function createMockClient() {
  const createFn = mock(async () => ({ data: { message_id: 'om_card_123' } }));
  const patchFn = mock(async () => ({}));
  return {
    im: { v1: { message: { create: createFn, patch: patchFn } } },
    createFn,
    patchFn,
  };
}

test('startProcessing sends initial card and returns message_id', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any);
  const id = await updater.startProcessing('ou_user123');
  expect(id).toBe('om_card_123');
  expect(m.createFn).toHaveBeenCalledTimes(1);
});

test('updateStream patches the card with content', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 0 });
  await updater.startProcessing('ou_user123');
  await updater.updateStream('thinking...', 'reply...', 10);
  expect(m.patchFn).toHaveBeenCalled();
});

test('throttle prevents rapid patches', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 100 });
  await updater.startProcessing('ou_user123');

  await updater.updateStream('t1', '', 5);
  const count1 = m.patchFn.mock.callCount();

  await updater.updateStream('t2', '', 6);
  const count2 = m.patchFn.mock.callCount();

  expect(count2).toBe(count1); // throttled

  // Wait for throttle window
  await new Promise(r => setTimeout(r, 150));
  const count3 = m.patchFn.mock.callCount();
  expect(count3).toBeGreaterThan(count1);
});

test('complete patches with green header', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 0 });
  await updater.startProcessing('ou_user123');
  await updater.complete('Final answer', 0.05, 2000, 3);
  const lastCall = m.patchFn.mock.calls[m.patchFn.mock.calls.length - 1];
  const card = JSON.parse(lastCall[0].data.content);
  expect(card.header.template).toBe('green');
});

test('error patches with red header', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 0 });
  await updater.startProcessing('ou_user123');
  await updater.error('Crashed');
  const lastCall = m.patchFn.mock.calls[m.patchFn.mock.calls.length - 1];
  const card = JSON.parse(lastCall[0].data.content);
  expect(card.header.template).toBe('red');
});

test('shouldFallbackToText detects oversized content', () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { max_card_bytes: 100 });
  expect(updater.shouldFallbackToText('x'.repeat(200))).toBe(true);
  expect(updater.shouldFallbackToText('short')).toBe(false);
});

test('truncateContent cuts to max_card_bytes', () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { max_card_bytes: 10 });
  const truncated = updater.truncateContent('Hello World!');
  const encoder = new TextEncoder();
  expect(encoder.encode(truncated).length).toBeLessThanOrEqual(13); // "..." added
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/unit/feishu/card-updater.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write CardUpdater implementation**

```typescript
// src/feishu/card-updater.ts
import { logger } from '../utils/logger';
import { config } from '../utils/config';

export type CardState = 'processing' | 'streaming' | 'complete' | 'error';

interface CardUpdaterOptions {
  throttle_ms?: number;
  max_card_bytes?: number;
  show_thinking?: boolean;
}

interface FeishuClient {
  im: {
    v1: {
      message: {
        create: (payload: any) => Promise<any>;
        patch: (payload: any) => Promise<any>;
      };
    };
  };
}

export class CardUpdater {
  private client: FeishuClient;
  private cardMessageId: string | null = null;
  private lastPatchAt = 0;
  private pendingUpdate: { thinking: string; text: string; elapsed: number } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly throttleMs: number;
  private readonly maxCardBytes: number;
  private readonly showThinking: boolean;
  private state: CardState = 'processing';

  constructor(client: FeishuClient, options: CardUpdaterOptions = {}) {
    this.client = client;
    this.throttleMs = options.throttle_ms ?? config.get<number>('stream.throttle_ms', 1500);
    this.maxCardBytes = options.max_card_bytes ?? config.get<number>('stream.max_card_bytes', 25000);
    this.showThinking = options.show_thinking ?? config.get<boolean>('stream.show_thinking', true);
  }

  getCardMessageId(): string | null { return this.cardMessageId; }
  getState(): CardState { return this.state; }

  async startProcessing(openId: string): Promise<string> {
    const card = this.buildProcessingCard();
    const resp = await this.client.im.v1.message.create({
      receive_id_type: 'open_id', receive_id: openId,
      msg_type: 'interactive', content: JSON.stringify(card),
    });
    this.cardMessageId = resp.data?.message_id ?? null;
    if (!this.cardMessageId) throw new Error('Failed to create processing card');
    this.state = 'processing';
    this.lastPatchAt = Date.now();
    return this.cardMessageId;
  }

  async updateStream(thinking: string, text: string, elapsedMs: number): Promise<void> {
    this.pendingUpdate = { thinking, text, elapsed: elapsedMs };
    const now = Date.now();
    if (now - this.lastPatchAt >= this.throttleMs) {
      await this.flushPending();
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(async () => {
        this.pendingTimer = null;
        await this.flushPending();
      }, this.throttleMs - (now - this.lastPatchAt));
    }
  }

  private async flushPending(): Promise<void> {
    if (!this.pendingUpdate || !this.cardMessageId) return;
    const { thinking, text, elapsed } = this.pendingUpdate;
    await this.patchCard(this.buildStreamingCard(thinking, text, elapsed));
    this.pendingUpdate = null;
    this.state = 'streaming';
  }

  async complete(response: string, costUsd: number, durationMs: number, numTurns: number): Promise<void> {
    await this.flushPending();
    await this.patchCard(this.buildCompleteCard(response, costUsd, durationMs, numTurns));
    this.state = 'complete';
  }

  async error(message: string): Promise<void> {
    await this.flushPending();
    await this.patchCard(this.buildErrorCard(message));
    this.state = 'error';
  }

  shouldFallbackToText(content: string): boolean {
    return new TextEncoder().encode(content).length > this.maxCardBytes;
  }

  truncateContent(content: string): string {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(content);
    if (bytes.length <= this.maxCardBytes) return content;
    const decoder = new TextDecoder();
    let low = 0, high = bytes.length;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (decoder.decode(bytes.slice(0, mid)).length <= this.maxCardBytes) low = mid;
      else high = mid - 1;
    }
    return decoder.decode(bytes.slice(0, low)) + '...';
  }

  dispose(): void {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
  }

  private async patchCard(card: Record<string, unknown>): Promise<void> {
    if (!this.cardMessageId) return;
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: this.cardMessageId },
        data: { content: JSON.stringify(card) },
      });
    } catch (err: any) {
      logger.warn(`CardUpdater: patch failed: ${err.message}`);
    }
  }

  private buildProcessingCard(): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '⏳ 正在处理...' }, template: 'blue' },
      elements: [{ tag: 'markdown', content: 'Claude 正在处理你的请求，预计 **2-10 秒**...' }],
    };
  }

  private buildStreamingCard(thinking: string, text: string, elapsedMs: number): Record<string, unknown> {
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const elements: Array<Record<string, unknown>> = [];
    if (this.showThinking && thinking) {
      elements.push({ tag: 'markdown', content: `**思考过程：**\n> ${esc(thinking.slice(-500))}` });
    }
    if (text) {
      elements.push({ tag: 'markdown', content: `**回复：**\n${esc(text.slice(-2000))}` });
    }
    elements.push({ tag: 'markdown', content: `⏱ 已用时 ${elapsedSec}s` });
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '💭 处理中' }, template: 'blue' },
      elements,
    };
  }

  private buildCompleteCard(response: string, costUsd: number, durationMs: number, numTurns: number): Record<string, unknown> {
    const display = this.truncateContent(response);
    const footer: string[] = [];
    if (costUsd > 0) footer.push(`💰 费用: **$${costUsd.toFixed(2)}**`);
    footer.push(`⏱ 耗时: **${Math.floor(durationMs / 1000)}s**`);
    if (numTurns > 0) footer.push(`📊 轮数: **${numTurns}**`);
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '✅ 处理完成' }, template: 'green' },
      elements: [
        { tag: 'markdown', content: esc(display) },
        { tag: 'hr' },
        { tag: 'markdown', content: footer.join('  |  ') },
      ],
    };
  }

  private buildErrorCard(message: string): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '❌ 处理失败' }, template: 'red' },
      elements: [{ tag: 'markdown', content: `错误原因：**${esc(message)}**\n\n请检查 Claude CLI 是否可用，或稍后重试。` }],
    };
  }
}

function esc(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/unit/feishu/card-updater.test.ts
```
Expected: All 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/feishu/card-updater.ts tests/unit/feishu/card-updater.test.ts
git commit -m "feat(stream): add CardUpdater for Feishu interactive card lifecycle"
```

---

### Task 4: Session Manager — Add sendStreamingMessage method

**Files:**
- Modify: `src/proxy/session.ts`
- Modify: `src/proxy/index.ts` (re-export StreamChunk types)
- Test: `tests/unit/proxy/session.test.ts` (existing)

- [ ] **Step 1: Add StreamParser import and sendStreamingMessage method**

In `src/proxy/session.ts`, add at top:

```typescript
import { StreamParser, StreamChunk, ResultChunk } from './stream-parser';
```

Add new public method to `ClaudeSessionManager` class:

```typescript
/**
 * Send a message with streaming output.
 * Spawns a new process with --output-format stream-json.
 * Calls onProgress for each assistant chunk.
 */
async sendStreamingMessage(
  sessionId: string | null,
  text: string,
  cwd: string,
  onProgress: (chunk: StreamChunk) => void,
  isNew?: boolean,
  lockKey?: string,
): Promise<SendMessageResult> {
  const resolvedLockKey = lockKey ?? sessionId ?? '__new__';
  await this.acquireSessionLock(resolvedLockKey);
  try {
    await this.acquireSlot();
    try {
      return await this._doStreamingMessage(sessionId, text, cwd, onProgress, isNew ?? false);
    } finally {
      this.releaseSlot();
    }
  } finally {
    this.releaseSessionLock(resolvedLockKey);
  }
}
```

- [ ] **Step 2: Add _doStreamingMessage private method**

Add to `ClaudeSessionManager` class:

```typescript
private async _doStreamingMessage(
  sessionId: string | null,
  text: string,
  cwd: string,
  onProgress: (chunk: StreamChunk) => void,
  isNew: boolean,
): Promise<SendMessageResult> {
  const claudeBin = config.get<string>('general.claude_bin', 'claude');
  const args: string[] = [claudeBin, '--print', '-p', text, '--output-format', 'stream-json', '--verbose'];
  if (sessionId && !isNew) args.push('--resume', sessionId);

  const expandedCwd = expandPath(cwd);
  if (!expandedCwd) return this._errorResult('cwd is empty', sessionId);

  const resolvedBin = Bun.which(args[0]);
  if (!resolvedBin) return this._errorResult(`Claude CLI 未找到: "${args[0]}" 不在 PATH 中`, sessionId);
  args[0] = resolvedBin;

  const startTime = Date.now();
  let lastOutputAt = startTime;
  let stderrText = '';
  const staleTimeout = config.get<number>('runtime.stale_timeout_ms', 5 * 60 * 1000);
  const hardTimeout = config.get<number>('runtime.hard_timeout_ms', 30 * 60 * 1000);

  let proc;
  try {
    proc = Bun.spawn(args, { cwd: expandedCwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true });
  } catch (err: any) {
    return this._errorResult(`Failed to start Claude process: ${err.message}`, sessionId);
  }

  const procPid = proc.pid;
  const trackKey = sessionId ?? `pid:${procPid}`;
  this.activeProcesses.set(trackKey, {
    sessionId: sessionId ?? '', pid: procPid, cwd: expandedCwd,
    createdAt: startTime, lastOutputAt: startTime, isNew,
  });

  const parser = new StreamParser();
  const decoder = new TextDecoder();
  let stdoutBuffer = '';
  let lastResult: ResultChunk | null = null;

  const stdoutPromise = (async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stdoutBuffer += decoder.decode(value, { stream: true });
        lastOutputAt = Date.now();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const parsed = parser.parseLine(line);
          if (parsed) {
            if (parsed.type === 'result') lastResult = parsed as ResultChunk;
            else onProgress(parsed);
          }
        }
      }
      if (stdoutBuffer.trim()) {
        const parsed = parser.parseLine(stdoutBuffer);
        if (parsed) {
          if (parsed.type === 'result') lastResult = parsed as ResultChunk;
          else onProgress(parsed);
        }
      }
    } catch (err) { logger.warn(`Stream: read失败: ${err}`); }
  })();

  const stderrPromise = (async () => {
    const reader = proc.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrText += decoder.decode(value, { stream: true });
        lastOutputAt = Date.now();
      }
    } catch (err) { logger.warn(`Stream: stderr 读取失败: ${err}`); }
  })();

  let exitCode: number | null = null;
  const exitPromise = (async () => { exitCode = await proc.exited; })();

  const timeoutCheck = setInterval(() => {
    const now = Date.now();
    if (now - startTime >= hardTimeout || now - lastOutputAt >= staleTimeout) {
      terminateProcessTree(procPid);
      clearInterval(timeoutCheck);
    }
  }, 1000);

  await Promise.race([exitPromise, stdoutPromise, stderrPromise, sleep(hardTimeout + 5000)]);
  clearInterval(timeoutCheck);
  await Promise.allSettled([stdoutPromise, stderrPromise]);

  if (exitCode === null) { try { process.kill(procPid, 'SIGKILL'); } catch {} }
  this.activeProcesses.delete(trackKey);

  const durationMs = Date.now() - startTime;
  return this._buildStreamingResult(lastResult, exitCode, stderrText, sessionId, startTime, durationMs, isNew);
}
```

- [ ] **Step 3: Add helper methods**

Add these private helper methods to `ClaudeSessionManager`:

```typescript
private _errorResult(message: string, sessionId: string | null): SendMessageResult {
  return {
    response: message, costUsd: 0, durationMs: 0,
    sessionId: sessionId ?? '', jsonlPath: null, sessionStatus: 'degraded',
  };
}

private _buildStreamingResult(
  lastResult: ResultChunk | null,
  exitCode: number | null,
  stderrText: string,
  sessionId: string | null,
  startTime: number,
  durationMs: number,
  isNew: boolean,
): SendMessageResult {
  let response = '';
  let resolvedSessionId = sessionId ?? '';
  let costUsd = 0;
  let hasError = false;
  let baseError = '';

  if (lastResult) {
    response = lastResult.result ?? '';
    resolvedSessionId = lastResult.session_id || resolvedSessionId;
    costUsd = lastResult.total_cost_usd ?? 0;
    hasError = Boolean(lastResult.is_error) || lastResult.subtype !== 'success';
    baseError = lastResult.errors?.join('; ') ?? '';
  }

  if (!response && exitCode !== 0) {
    response = `Claude 执行失败: ${baseError || stderrText.trim() || '未知错误'}`;
    hasError = true;
  }
  if (!response) response = '(空回复)';

  let jsonlPath: string | null = null;
  let sessionStatus: 'active' | 'provisioning' | 'degraded' = hasError ? 'degraded' : 'active';

  if (isNew && resolvedSessionId) {
    jsonlPath = await resolveJsonlPath(resolvedSessionId);
    if (!jsonlPath && sessionStatus === 'active') sessionStatus = 'provisioning';
  }

  return {
    response, costUsd,
    durationMs: lastResult?.duration_ms ?? durationMs,
    sessionId: resolvedSessionId, jsonlPath, sessionStatus,
    error: hasError ? (baseError || 'unknown_error') : undefined,
  };
}
```

- [ ] **Step 4: Re-export StreamChunk types from proxy/index.ts**

In `src/proxy/index.ts`, add:

```typescript
export { StreamParser } from './stream-parser';
export type { StreamChunk, StreamChunkType, ThinkingChunk, TextChunk, ResultChunk } from './stream-parser';
```

- [ ] **Step 5: Run typecheck and tests**

```bash
bun run typecheck
bun test tests/unit/proxy/session.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/proxy/session.ts src/proxy/index.ts src/proxy/stream-parser.ts tests/unit/proxy/stream-parser.test.ts
git commit -m "feat(stream): add sendStreamingMessage to SessionManager"
```

---

### Task 5: Feishu Bot — Integrate streaming into handleChat

**Files:**
- Modify: `src/feishu/bot.ts`
- Modify: `src/feishu/index.ts` (export CardUpdater)
- Modify: `src/cli/commands/start.ts` (pass client to FeishuBot)
- Test: `tests/unit/feishu/bot.test.ts` (existing)

- [ ] **Step 1: Export CardUpdater from feishu/index.ts**

```typescript
export { CardUpdater } from './card-updater';
```

- [ ] **Step 2: Add client to FeishuBot constructor**

In `src/feishu/bot.ts`, add to FeishuBot class:

```typescript
  private feishuClient: any;
```

Update constructor to accept `feishuClient`:

```typescript
  constructor(opts: {
    userManager: UserManager;
    listSnapshotManager: ListSnapshotManager;
    spoolQueue: SpoolQueue;
    registry: RegistryManager;
    sessionManager?: ClaudeSessionManager;
    replyFn?: FeishuReplyFn;
    cardReplyFn?: FeishuBotCardReplyFn;
    feishuClient?: any;
  }) {
    ...existing...
    this.feishuClient = opts.feishuClient;
  }
```

- [ ] **Step 3: Add StreamChunk import and handleChatStreaming**

In `src/feishu/bot.ts`, add import:

```typescript
import { StreamChunk } from '../proxy/stream-parser';
import { CardUpdater } from './card-updater';
```

Replace the `'session'` case in `handleChat` with:

```typescript
      case 'session': {
        const sessionUuid = msg.target.sessionUuid ?? '';
        const currentEntry = this.registry.get(sessionUuid);
        const cwd = msg.target.cwd || currentEntry?.cwd || process.env.HOME || '/';

        if (config.get<boolean>('stream.enabled', false)) {
          await this.handleChatStreaming(msg, sessionUuid, cwd, currentEntry);
        } else {
          await this.handleChatNonStreaming(msg, sessionUuid, cwd, currentEntry);
        }
        return;
      }
```

- [ ] **Step 4: Extract existing logic into handleChatNonStreaming**

Add method to FeishuBot class (copy the existing session case body):

```typescript
  private async handleChatNonStreaming(
    msg: SpoolMessage, sessionUuid: string, cwd: string, currentEntry: any,
  ): Promise<void> {
    const result = await this.sessionManager.sendMessage(sessionUuid, msg.text, cwd, false, msg.serialKey);
    this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, { responseText: result.response || '(空回复)' });
    this.registry.upsert(sessionUuid, {
      cwd, last_active: new Date().toISOString(), last_message_preview: preview(msg.text),
      last_error: result.error ?? null,
      status: result.sessionStatus === 'degraded' ? 'degraded' : 'active',
      jsonl_path: result.jsonlPath ?? undefined,
      pending_jsonl_resolve: result.jsonlPath ? false : currentEntry?.pending_jsonl_resolve,
      message_count: (currentEntry?.message_count ?? 0) + 1,
    });
    await this.registry.flush();
    const jsonlPath = result.jsonlPath ?? currentEntry?.jsonl_path;
    if (jsonlPath) { try { repairJsonlLastPrompt(jsonlPath); } catch {} }
    await this.replyAndFinalize(msg, result.response || '(空回复)');
  }
```

- [ ] **Step 5: Add handleChatStreaming method**

```typescript
  private async handleChatStreaming(
    msg: SpoolMessage, sessionUuid: string, cwd: string, currentEntry: any,
  ): Promise<void> {
    const startTime = Date.now();
    let thinking = '';
    let text = '';
    let cardUpdater: CardUpdater | null = null;
    let cardMessageId: string | null = null;
    let cardInitFailed = false;

    // Send initial processing card
    try {
      if (this.feishuClient) {
        cardUpdater = new CardUpdater(this.feishuClient, {
          throttle_ms: config.get<number>('stream.throttle_ms', 1500),
          max_card_bytes: config.get<number>('stream.max_card_bytes', 25000),
          show_thinking: config.get<boolean>('stream.show_thinking', true),
        });
        cardMessageId = await cardUpdater.startProcessing(msg.openId);
      }
    } catch (err: any) {
      logger.warn(`Stream: processing card 发送失败: ${err}`);
      cardInitFailed = true;
    }

    try {
      const result = await this.sessionManager.sendStreamingMessage(
        sessionUuid, msg.text, cwd,
        (chunk: StreamChunk) => {
          if (cardInitFailed || !cardUpdater) return;
          if (chunk.type === 'thinking') thinking += chunk.content;
          else if (chunk.type === 'text') text += chunk.content;
          const elapsed = Date.now() - startTime;
          cardUpdater.updateStream(
            config.get<boolean>('stream.show_thinking', true) ? thinking : '',
            text, elapsed
          ).catch(e => logger.warn(`Stream: update failed: ${e}`));
        },
        false, msg.serialKey,
      );

      // Finalize card
      if (cardUpdater) {
        await this.finalizeStreamingCard(cardUpdater, text, result, cardMessageId);
        cardMessageId = cardUpdater.getCardMessageId();
        cardUpdater.dispose();
      }

      // Update registry
      this.registry.upsert(sessionUuid, {
        cwd, last_active: new Date().toISOString(), last_message_preview: preview(msg.text),
        last_error: result.error ?? null,
        status: result.sessionStatus === 'degraded' ? 'degraded' : 'active',
        jsonl_path: result.jsonlPath ?? undefined,
        pending_jsonl_resolve: result.jsonlPath ? false : currentEntry?.pending_jsonl_resolve,
        message_count: (currentEntry?.message_count ?? 0) + 1,
      });
      await this.registry.flush();

      // Finalize spool
      this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, { responseText: result.response || '(空回复)' });
      if (cardMessageId) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, cardMessageId, 1);
      }
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey, cardMessageId ?? undefined);

      // JSONL repair
      const jlPath = result.jsonlPath ?? currentEntry?.jsonl_path;
      if (jlPath) { try { repairJsonlLastPrompt(jlPath); } catch {} }
    } catch (err: any) {
      if (cardUpdater) {
        await cardUpdater.error(err.message ?? 'Unknown error');
        cardMessageId = cardUpdater.getCardMessageId();
        cardUpdater.dispose();
      } else if (!cardInitFailed) {
        await this.replyFn(`处理失败: ${err.message}`, { messageId: msg.messageId, openId: msg.openId });
      }
      if (cardMessageId) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, cardMessageId, 1);
      }
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
      this.spoolQueue.markFailed(msg.messageId, msg.serialKey, String(err));
    }
  }

  private async finalizeStreamingCard(
    cardUpdater: CardUpdater, text: string, result: any, cardMessageId: string | null,
  ): Promise<void> {
    if (cardUpdater.shouldFallbackToText(text)) {
      const truncated = cardUpdater.truncateContent(text);
      await cardUpdater.complete(truncated, result.costUsd, result.durationMs, 1);
      const remainder = text.slice(truncated.length);
      if (remainder && config.get<boolean>('stream.fallback_to_text', true)) {
        for (const chunk of splitReplyText(remainder, 3900)) {
          await this.replyFn(chunk, { messageId: cardMessageId ?? undefined, openId: undefined });
        }
      }
    } else {
      await cardUpdater.complete(text, result.costUsd, result.durationMs, 1);
    }
  }
```

- [ ] **Step 6: Add stream routing to new_session_claim case**

In the `new_session_claim` case, replace the `await this.createSessionFromPrompt(...)` call with:

```typescript
        if (config.get<boolean>('stream.enabled', false)) {
          await this.createSessionFromPromptStreaming(msg, msg.target.cwd ?? claimResult.entry.cwd ?? '', claimMessageId, msg.text);
        } else {
          await this.createSessionFromPrompt(msg, msg.target.cwd ?? claimResult.entry.cwd ?? '', claimMessageId, msg.text);
        }
```

- [ ] **Step 7: Add createSessionFromPromptStreaming method**

```typescript
  private async createSessionFromPromptStreaming(
    msg: SpoolMessage, cwd: string, claimMessageId: string, prompt: string,
  ): Promise<void> {
    const startTime = Date.now();
    let thinking = '', text = '';
    let cardUpdater: CardUpdater | null = null;
    let cardMessageId: string | null = null;
    let cardInitFailed = false;

    try {
      if (this.feishuClient) {
        cardUpdater = new CardUpdater(this.feishuClient);
        cardMessageId = await cardUpdater.startProcessing(msg.openId);
      }
    } catch { cardInitFailed = true; }

    try {
      const result = await this.sessionManager.sendStreamingMessage(
        null, prompt, cwd,
        (chunk: StreamChunk) => {
          if (cardInitFailed || !cardUpdater) return;
          if (chunk.type === 'thinking') thinking += chunk.content;
          else if (chunk.type === 'text') text += chunk.content;
          cardUpdater.updateStream(
            config.get<boolean>('stream.show_thinking', true) ? thinking : '',
            text, Date.now() - startTime
          ).catch(() => {});
        },
        true, `new:${msg.openId}`,
      );

      if (!result.sessionId) {
        await this.userManager.rollbackClaim(msg.openId, claimMessageId);
        throw new Error(result.error || 'Claude 未返回 session_id');
      }

      if (cardUpdater) {
        await this.finalizeStreamingCard(cardUpdater, text, result, cardMessageId);
        cardMessageId = cardUpdater.getCardMessageId();
        cardUpdater.dispose();
      }

      const now = new Date().toISOString();
      const bound = await this.userManager.bindSessionToClaim(msg.openId, claimMessageId, result.sessionId, cwd);
      if (!bound) throw new Error('映射绑定失败');

      this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, {
        responseText: result.response || '(空回复)',
        target: { type: 'session', sessionUuid: result.sessionId, cwd, openId: msg.openId, mappingVersion: this.userManager.getVersion() },
      });
      this.registry.upsert(result.sessionId, {
        origin: 'feishu', cwd, project_name: basename(cwd), title: buildSessionTitle(prompt),
        message_count: Math.max(this.registry.get(result.sessionId)?.message_count ?? 0, 1),
        created_at: this.registry.get(result.sessionId)?.created_at ?? now, last_active: now,
        last_message_preview: preview(prompt), status: result.sessionStatus,
        jsonl_path: result.jsonlPath, pending_jsonl_resolve: !result.jsonlPath,
        last_error: result.error ?? null, feishu_user_id: msg.openId,
      });
      await this.registry.flush();

      if (cardMessageId) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, cardMessageId, 1);
      }
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
      this.spoolQueue.markDone(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
    } catch (err: any) {
      if (cardUpdater) {
        await cardUpdater.error(err.message ?? 'Unknown error');
        cardMessageId = cardUpdater.getCardMessageId();
        cardUpdater.dispose();
      } else if (!cardInitFailed) {
        await this.replyFn(`处理失败: ${err.message}`, { messageId: msg.messageId, openId: msg.openId });
      }
      await this.userManager.rollbackClaim(msg.openId, claimMessageId);
      if (cardMessageId) {
        this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, cardMessageId, 1);
      }
      this.spoolQueue.markReplied(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
      this.spoolQueue.markFailed(msg.messageId, msg.serialKey, String(err));
    }
  }
```

- [ ] **Step 8: Pass feishuClient in start.ts**

In `src/cli/commands/start.ts`, find the FeishuBot constructor calls (lines 201 and 495) and add `feishuClient: client`:

```typescript
  const bot = new FeishuBot({
    userManager,
    listSnapshotManager,
    spoolQueue,
    registry,
    replyFn,
    cardReplyFn,
    feishuClient: client,
  });
```

- [ ] **Step 9: Run typecheck and tests**

```bash
bun run typecheck
bun test tests/unit/feishu/bot.test.ts
```

- [ ] **Step 10: Commit**

```bash
git add src/feishu/bot.ts src/feishu/index.ts src/cli/commands/start.ts
git commit -m "feat(stream): integrate streaming into FeishuBot handleChat"
```

---

### Task 6: Export splitReplyText from bot.ts

**Files:**
- Modify: `src/feishu/bot.ts`

- [ ] **Step 1: Export splitReplyText function**

The `splitReplyText` function is currently private. Add `export` before its declaration:

```typescript
export function splitReplyText(text: string, maxBytes: number): string[] {
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "refactor: export splitReplyText for streaming use"
```

---

### Task 7: Full test suite + integration smoke test

**Files:**
- All test files

- [ ] **Step 1: Run full test suite**

```bash
bun test
```
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```
Expected: 0 errors.

- [ ] **Step 3: Build and verify**

```bash
bun run build
./dist/cc-bridge --help
```
Expected: Build succeeds, help displays.

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "chore: streaming feature complete, all tests passing"
```

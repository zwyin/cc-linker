import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, statSync } from 'fs';  // statSync: 验证文件 > 4KB
import { join } from 'path';
import { tmpdir } from 'os';
import { RegistryManager } from '../../../src/registry';  // 与现有 jsonl.test.ts 保持一致
import { JSONLScanner } from '../../../src/scanner/jsonl';
import { FileCache } from '../../../src/scanner/cache';

describe('JSONLScanner parseTail user/assistant preview', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-preview-test-'));
    projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-project');
    // 兼容现有 jsonl.test.ts 的 setup
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(filename: string, content: string): void {
    writeFileSync(join(projectDir, filename), content);
  }

  it('extracts last_assistant_preview from text block', () => {
    const sessionId = 'test-assistant-text';
    writeJsonl(`${sessionId}.jsonl`, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world response' }] },
      }),
    ].join('\n'));

    const registry = new RegistryManager(tmpDir);
    const cache: FileCache = new Map();
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    expect(entry?.last_assistant_preview).toBe('Hello world response');
  });

  it('extracts last_user_preview from string content (form A)', () => {
    const sessionId = 'test-user-string';
    writeJsonl(`${sessionId}.jsonl`, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'What is the meaning of life?' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '42' }] } }),
    ].join('\n'));

    const registry = new RegistryManager(tmpDir);
    const cache: FileCache = new Map();
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    expect(entry?.last_user_preview).toBe('What is the meaning of life?');
  });

  it('extracts last_user_preview from array content (form B)', () => {
    const sessionId = 'test-user-array';
    writeJsonl(`${sessionId}.jsonl`, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Help me with TypeScript' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Sure' }] } }),
    ].join('\n'));

    const registry = new RegistryManager(tmpDir);
    const cache: FileCache = new Map();
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    expect(entry?.last_user_preview).toBe('Help me with TypeScript');
  });

  it('preserves last_message_preview 100-char version', () => {
    const sessionId = 'test-legacy-preview';
    const longText = 'A'.repeat(150);
    writeJsonl(`${sessionId}.jsonl`, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
      }),
    ].join('\n'));

    const registry = new RegistryManager(tmpDir);
    const cache: FileCache = new Map();
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    // last_message_preview: 100 字符（保留）
    expect(entry?.last_message_preview.length).toBe(100);
    // last_assistant_preview: ≤ 240 字符（cleaned）
    expect(entry?.last_assistant_preview?.length).toBeLessThanOrEqual(240);
  });

  it('truncates preview to 80 chars', () => {
    const sessionId = 'test-truncate';
    const longUserText = 'B'.repeat(200);
    writeJsonl(`${sessionId}.jsonl`, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: longUserText } }),
    ].join('\n'));

    const registry = new RegistryManager(tmpDir);
    const cache: FileCache = new Map();
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    expect(entry?.last_user_preview?.length).toBe(80);
  });

  it('parseFull scans full file to find user prompt beyond last 10 lines (large file first scan)', () => {
    const sessionId = 'test-4kb-fallback';
    // 构造 50+ 行的"大文件"：第 1 行 user prompt，中间 48 行 tool_use/tool_result，最后 1 行 assistant
    // 因为 session 首次扫描走 parseFull 路径，**parseFull 改造后全量遍历**（不是 10 行），
    // 所以即使有 50 行，parseFull 也能找到第 1 行的 user prompt。
    //
    // 注意：当前测试的是 parseFull 行为，不是 parseTail 的 4KB fallback。
    // parseTail 4KB fallback 测试见 task 6 后续补充的"parseTail-specific 4KB fallback test"
    const lines: string[] = [];
    lines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'UNIQUE_USER_PROMPT_IN_LINE_1' }] },
    }));
    for (let i = 0; i < 48; i++) {
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool_${i}`, name: 'Bash', input: { command: `echo ${i}` } }] },
      }));
    }

    writeJsonl(`${sessionId}.jsonl`, lines.join('\n'));

    const registry = new RegistryManager(tmpDir);
    const cache: FileCache = new Map();
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    // parseFull 跑全量，能拿到第 1 行的 UNIQUE_USER_PROMPT
    expect(entry?.last_user_preview).toBe('UNIQUE_USER_PROMPT_IN_LINE_1');
  });

  it('parseFull scans full file to find user prompt beyond last 10 lines', () => {
    const sessionId = 'test-parsefull-full';
    // 同样 50 行结构，但用 parseFull 路径（首次扫描，registry 没这个 session）
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} }] },
      }));
    }
    lines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'PROMPT_AT_LINE_31' },
    }));
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `text ${i}` }] },
      }));
    }
    writeJsonl(`${sessionId}.jsonl`, lines.join('\n'));

    const registry = new RegistryManager(tmpDir);
    const cache: FileCache = new Map();
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    expect(entry?.last_user_preview).toBe('PROMPT_AT_LINE_31');
  });

  it('parseTail 4KB fallback finds user prompt beyond tail (existing session, large file)', async () => {
    const sessionId = 'test-parsetail-4kb-fallback';
    // parseTail 用于已注册 session 的增量更新（registry.has(sessionId) === true）
    // 大文件分支只读 4KB，如果 4KB 内没有 user prompt，fallback 全量重读
    //
    // 构造一个 6000+ 字节的文件（> 4KB），第 1 行是 user prompt，后续是 tool_use 直到末尾
    const lines: string[] = [];
    lines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'FALLBACK_USER_PROMPT_AT_LINE_1' },
    }));
    // 填充到 4KB 之外：每行 ~250 字符
    for (let i = 0; i < 50; i++) {
      lines.push(JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: `t${i}`,
            name: 'Bash',
            input: { command: `echo FILLER_LINE_${i}_`.padEnd(150, 'X') },
          }],
        },
      }));
    }
    writeJsonl(`${sessionId}.jsonl`, lines.join('\n'));

    // 关键：先注册 session，让 parseTail 路径被走（不是 parseFull）
    const registry = new RegistryManager(tmpDir);
    registry.upsert(sessionId, {
      origin: 'cli',
      cwd: '/tmp/test',
      project_name: 'test',
      jsonl_path: null,
      project_dir: null,
      created_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
      title: 'Pre-registered',
      message_count: 0,
      last_message_preview: '',
    });
    await registry.flush();  // 显式 flush 写盘

    const cache: FileCache = new Map();
    cache.set(join(projectDir, `${sessionId}.jsonl`), 0);  // 强制 scanner 重扫
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    // 验证文件确实 > 4KB
    const filePath = join(projectDir, `${sessionId}.jsonl`);
    const fileSize = statSync(filePath).size;
    expect(fileSize).toBeGreaterThan(4096);
    // parseTail 4KB fallback 应该找到第 1 行的 user prompt
    expect(entry?.last_user_preview).toBe('FALLBACK_USER_PROMPT_AT_LINE_1');
  });

  // ===== fix #6: parseFull 不应覆盖已有 status =====
  // 之前 parseFull 硬编码 return status: 'active'，对已注册但 title='Untitled...' 的 session
  // （即 isUntitled=true 走 parseFull 路径），其已有 status='degraded'/'corrupted' 等会被覆写为 'active'。
  // 修复后：parseFull 不再返回 status，由调用方根据 existing.status 决定保留或重置。

  it('parseFull rescan preserves existing status (Untitled→real title, degraded stays)', async () => {
    const sessionId = 'test-status-preserve-degraded';
    writeJsonl(`${sessionId}.jsonl`, [
      JSON.stringify({ cwd: '/tmp/proj', type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
    ].join('\n'));

    const registry = new RegistryManager(tmpDir);
    // 预注册：title='Untitled' 触发 parseFull 路径，status='degraded' 应该被保留
    registry.upsert(sessionId, {
      origin: 'cli',
      cwd: '/tmp/proj',
      project_name: 'proj',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: '2026-01-01T00:00:00Z',
      title: 'Untitled (abc12345)',
      message_count: 0,
      last_message_preview: '',
      status: 'degraded',
    });
    await registry.flush();

    const cache: FileCache = new Map();
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    // title 已恢复（不再以 Untitled 开头）
    expect(entry?.title?.startsWith('Untitled')).toBe(false);
    // status 应该是 degraded（被保留），不是 'active'（被 parseFull 覆写）
    expect(entry?.status).toBe('degraded');
  });

  it('parseFull rescan resets corrupted→active when JSONL is now parseable', async () => {
    const sessionId = 'test-status-corrupted-recovery';
    writeJsonl(`${sessionId}.jsonl`, [
      JSON.stringify({ cwd: '/tmp/proj', type: 'user', message: { role: 'user', content: 'recovered' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n'));

    const registry = new RegistryManager(tmpDir);
    // 预注册：title='Untitled' 触发 parseFull，status='corrupted'
    // 修复后走与 parseTail 一样的 corrupted→active 逻辑
    registry.upsert(sessionId, {
      origin: 'cli',
      cwd: '/tmp/proj',
      project_name: 'proj',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: '2026-01-01T00:00:00Z',
      title: 'Untitled (corrupted)',
      message_count: 0,
      last_message_preview: '',
      status: 'corrupted',
    });
    await registry.flush();

    const cache: FileCache = new Map();
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    expect(entry?.status).toBe('active');
  });

  // ===== fix #2: parseFull 第一个循环早退条件不应要求 lastPrompt =====
  // 之前 break 条件包含 lastPrompt，缺少 last-prompt marker 的 JSONL 会遍历全部行。
  // 修复后：拿到 cwd + aiTitle + firstUserMessage + createdAt 即 break，lastPrompt 可后取。

  it('parseFull early-exits without requiring last-prompt marker', () => {
    const sessionId = 'test-no-lastprompt-marker';
    // 50 行结构：有 ai-title + firstUserMessage + createdAt 但无 last-prompt marker
    const lines: string[] = [];
    lines.push(JSON.stringify({
      cwd: '/tmp/proj',
      type: 'ai-title',
      aiTitle: 'My Custom Title',
      timestamp: '2026-01-01T00:00:00Z',
    }));
    lines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'FIRST_USER_PROMPT' },
    }));
    for (let i = 0; i < 48; i++) {
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { cmd: `echo ${i}` } }] },
      }));
    }
    writeJsonl(`${sessionId}.jsonl`, lines.join('\n'));

    const registry = new RegistryManager(tmpDir);
    const cache: FileCache = new Map();
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    // 关键验证：title 用 aiTitle 提取（不是 'Untitled...'）
    expect(entry?.title).toBe('My Custom Title');
    // firstUserMessage 仍能被取到
    expect(entry?.last_user_preview).toBe('FIRST_USER_PROMPT');
    // createdAt 用第 1 行的 timestamp
    expect(entry?.created_at).toBe('2026-01-01T00:00:00Z');
  });

  // ===== 第二轮 review fix A: parseFull 第二个 reverse loop 也应收集 lastPrompt =====
  // 第一个 forward loop 在 ai-title + firstUserMessage + createdAt 拿到后即 break，
  // 不会到达文件末尾的 `last-prompt` marker。
  // 修复后：第二个 reverse loop 也收集 lastPrompt（从尾部找，避免依赖 forward loop 走完）。

  it('parseFull collects lastPrompt from end of file (marker after forward-loop break point)', () => {
    const sessionId = 'test-late-lastprompt';
    // 52 行：ai-title + firstUserMessage 在前 2 行（forward loop 在 line 2 break），
    // 49 行 assistant tool_use，line 52 是 last-prompt marker。
    // 没有 assistant text block（都是 tool_use），preview=''，应回退到 lastPrompt。
    const lines: string[] = [];
    lines.push(JSON.stringify({
      cwd: '/tmp/proj',
      type: 'ai-title',
      aiTitle: 'Generic Title',
      timestamp: '2026-01-01T00:00:00Z',
    }));
    lines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'first prompt' },
    }));
    for (let i = 0; i < 48; i++) {
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { cmd: `echo ${i}` } }] },
      }));
    }
    // last-prompt marker 在末尾（line 52）
    lines.push(JSON.stringify({
      type: 'last-prompt',
      lastPrompt: 'THE_LAST_PROMPT_FROM_MARKER',
      leafUuid: 'fake-uuid',
      sessionId,
    }));

    writeJsonl(`${sessionId}.jsonl`, lines.join('\n'));

    const registry = new RegistryManager(tmpDir);
    const cache: FileCache = new Map();
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    // title 优先用 aiTitle
    expect(entry?.title).toBe('Generic Title');
    // 没有 assistant text block → preview=''，last_message_preview 应回退到 lastPrompt
    expect(entry?.last_message_preview).toBe('THE_LAST_PROMPT_FROM_MARKER');
  });

  // ===== 第二轮 review fix B+C: parseFull/parseTail 3-tier fallback 一致性 =====

  it('parseTail falls back to lastPrompt when no assistant text (consistency with parseFull)', async () => {
    const sessionId = 'test-parsetail-fallback';
    // 50 行：49 行 tool_use + 1 行 last-prompt marker。文件 < 4KB 走小文件分支。
    const lines: string[] = [];
    for (let i = 0; i < 49; i++) {
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { cmd: `echo ${i}` } }] },
      }));
    }
    lines.push(JSON.stringify({
      type: 'last-prompt',
      lastPrompt: 'PRECEDING_LAST_PROMPT',
      leafUuid: 'fake-uuid',
      sessionId,
    }));
    writeJsonl(`${sessionId}.jsonl`, lines.join('\n'));

    // 预注册（parseTail 路径：registry.has(sessionId) === true）
    const registry = new RegistryManager(tmpDir);
    registry.upsert(sessionId, {
      origin: 'cli',
      cwd: '/tmp/test',
      project_name: 'test',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: '2026-01-01T00:00:00Z',
      title: 'Real Title',
      message_count: 0,
      last_message_preview: '',
    });
    await registry.flush();

    const filePath = join(projectDir, `${sessionId}.jsonl`);
    const cache: FileCache = new Map();
    cache.set(filePath, 0);  // 强制 scanner 重扫
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    // preview=''（无 assistant text）→ 应回退到 lastPrompt（与 parseFull 行为一致）
    expect(entry?.last_message_preview).toBe('PRECEDING_LAST_PROMPT');
  });

  it('parseTail falls back to [无内容] when no assistant text AND no last-prompt marker', async () => {
    const sessionId = 'test-parsetail-empty-fallback';
    // 5 行：只有 tool_use，没有 user 也没有 assistant text，没有 last-prompt
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { cmd: `echo ${i}` } }] },
      }));
    }
    writeJsonl(`${sessionId}.jsonl`, lines.join('\n'));

    const registry = new RegistryManager(tmpDir);
    registry.upsert(sessionId, {
      origin: 'cli',
      cwd: '/tmp/test',
      project_name: 'test',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: '2026-01-01T00:00:00Z',
      title: 'Real Title',
      message_count: 0,
      last_message_preview: '',
    });
    await registry.flush();

    const filePath = join(projectDir, `${sessionId}.jsonl`);
    const cache: FileCache = new Map();
    cache.set(filePath, 0);
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    // preview=''，lastPrompt='' → '[无内容]'（与 parseFull 一致）
    expect(entry?.last_message_preview).toBe('[无内容]');
  });

  // ===== BUG-1: aiTitle 必须截断到 50 字符（防止 Feishu 4KB 卡片超限）=====
  // 之前：aiTitle 直接写到 registry，无长度限制。如果 JSONL 写了一个 5000 字符的 ai-title，
  // registry 的 title 字段会被撑到 5000 字符，list 卡片/overview 卡片的 markdown 元素
  // 会超过 Feishu 4KB 限制，导致卡片渲染失败（silent failure）。
  // 修复后：parseFull 把 aiTitle 也截断到 50 字符（与 lastPrompt/firstUserMessage 一致）。

  it('parseFull truncates long ai-title to 50 chars (prevent Feishu card overflow)', () => {
    const sessionId = 'test-long-aititle';
    // 构造 5000 字符的 ai-title
    const longTitle = 'A'.repeat(5000);
    const lines: string[] = [
      JSON.stringify({
        cwd: '/tmp/proj',
        type: 'ai-title',
        aiTitle: longTitle,
        timestamp: '2026-01-01T00:00:00Z',
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'first prompt' },
      }),
    ];
    writeJsonl(`${sessionId}.jsonl`, lines.join('\n'));

    const registry = new RegistryManager(tmpDir);
    const cache: FileCache = new Map();
    const scanner = new JSONLScanner(registry, cache, join(tmpDir, '.claude'));
    scanner.scan();

    const entry = registry.get(sessionId);
    // title 必须被截断到 ≤ 50 字符（保留 '...' 3 字符）
    expect(entry?.title).toBeDefined();
    expect(entry!.title!.length).toBeLessThanOrEqual(53);  // 50 + '...'
    expect(entry!.title!.startsWith('AAAA')).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, statSync } from 'fs';  // statSync: 验证文件 > 4KB
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
    // last_assistant_preview: 80 字符（新增）
    expect(entry?.last_assistant_preview?.length).toBe(80);
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
    lines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'recent user prompt' }] },
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'recent assistant' }] },
    }));

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

  it('parseTail 4KB fallback finds user prompt beyond tail (existing session, large file)', () => {
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
    registry.flush();  // 显式 flush 写盘

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
});

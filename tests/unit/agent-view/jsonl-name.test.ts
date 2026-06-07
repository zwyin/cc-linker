// tests/unit/agent-view/jsonl-name.test.ts
//
// v2.2.7 jsonl-name 单测:JsonlIndex / extractFirstUserPrompt / deriveNameFromJsonl
// 三个公开 API 全覆盖。用 tmp dir 模拟 ~/.claude/projects/<proj>/<UUID>.jsonl 结构。

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  JsonlIndex,
  extractFirstUserPrompt,
  deriveNameFromJsonl,
} from '../../../src/agent-view/jsonl-name';

let projectsDir: string;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cc-linker-jsonl-name-'));
  projectsDir = join(tmpRoot, 'projects');
  mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

function writeJsonl(short: string, uuid: string, lines: object[]): string {
  const projDir = join(projectsDir, '-Users-test');
  mkdirSync(projDir, { recursive: true });
  const path = join(projDir, `${uuid}.jsonl`);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('extractFirstUserPrompt', () => {
  test('returns first string-content user message', () => {
    const path = writeJsonl('3a41fe73', '3a41fe73-0951-470a-bd2f-fb5a9f0fbe6b', [
      { type: 'mode', mode: 'normal' },
      { type: 'permission-mode', mode: 'acceptEdits' },
      { type: 'user', message: { role: 'user', content: '你的当前模型是？' } },
    ]);
    expect(extractFirstUserPrompt(path)).toBe('你的当前模型是？');
  });

  test('returns first array+text content user message', () => {
    const path = writeJsonl('aaaa1111', 'aaaa1111-0000-0000-0000-000000000000', [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'find the bug in foo.ts' }],
        },
      },
    ]);
    expect(extractFirstUserPrompt(path)).toBe('find the bug in foo.ts');
  });

  test('skips entries with isMeta: true (Claude continuation)', () => {
    const path = writeJsonl('bbbb2222', 'bbbb2222-0000-0000-0000-000000000000', [
      {
        type: 'user',
        isMeta: true,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Continue from where you left off.' }],
        },
      },
      { type: 'user', message: { role: 'user', content: 'real first prompt' } },
    ]);
    expect(extractFirstUserPrompt(path)).toBe('real first prompt');
  });

  test('skips entries with attachment field (hook / skill_listing injection)', () => {
    const path = writeJsonl('cccc3333', 'cccc3333-0000-0000-0000-000000000000', [
      {
        attachment: { type: 'hook_additional_context', content: 'system context' },
      },
      { attachment: { type: 'skill_listing', content: 'skill list' } },
      { type: 'user', message: { role: 'user', content: 'actual user prompt' } },
    ]);
    expect(extractFirstUserPrompt(path)).toBe('actual user prompt');
  });

  test('skips tool_result blocks (array content without text block)', () => {
    const path = writeJsonl('dddd4444', 'dddd4444-0000-0000-0000-000000000000', [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'xyz', content: 'done' }],
        },
      },
      { type: 'user', message: { role: 'user', content: 'next real prompt' } },
    ]);
    expect(extractFirstUserPrompt(path)).toBe('next real prompt');
  });

  test('skips command output text', () => {
    const path = writeJsonl('eeee5555', 'eeee5555-0000-0000-0000-000000000000', [
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<local-command-stdout>some output</local-command-stdout>',
        },
      },
      { type: 'user', message: { role: 'user', content: 'real prompt after cmd' } },
    ]);
    expect(extractFirstUserPrompt(path)).toBe('real prompt after cmd');
  });

  test('skips short replies and blacklist words (继续 / continue / ok)', () => {
    const path = writeJsonl('ffff6666', 'ffff6666-0000-0000-0000-000000000000', [
      { type: 'user', message: { role: 'user', content: '继续' } },
      { type: 'user', message: { role: 'user', content: 'ok' } },
      { type: 'user', message: { role: 'user', content: '好' } },
      { type: 'user', message: { role: 'user', content: 'finally meaningful prompt' } },
    ]);
    expect(extractFirstUserPrompt(path)).toBe('finally meaningful prompt');
  });

  test('returns null when no candidate user entry exists', () => {
    const path = writeJsonl('7777aaaa', '7777aaaa-0000-0000-0000-000000000000', [
      { type: 'mode', mode: 'normal' },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'continuation' } },
      { type: 'user', message: { role: 'user', content: '继续' } },
    ]);
    expect(extractFirstUserPrompt(path)).toBeNull();
  });

  test('returns null when file does not exist', () => {
    expect(extractFirstUserPrompt('/nonexistent/path/x.jsonl')).toBeNull();
  });

  test('handles malformed JSON lines gracefully', () => {
    const projDir = join(projectsDir, '-Users-test');
    mkdirSync(projDir, { recursive: true });
    const path = join(projDir, '8888bbbb-0000-0000-0000-000000000000.jsonl');
    writeFileSync(
      path,
      'this is not json\n' +
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'good one' } }) +
        '\n',
    );
    expect(extractFirstUserPrompt(path)).toBe('good one');
  });
});

describe('JsonlIndex', () => {
  test('lookup finds JSONL by short hash', () => {
    writeJsonl('9999cccc', '9999cccc-0000-0000-0000-000000000000', []);
    const idx = new JsonlIndex(projectsDir);
    const found = idx.lookup('9999cccc');
    expect(found).toBeTruthy();
    expect(found!.endsWith('9999cccc-0000-0000-0000-000000000000.jsonl')).toBe(true);
  });

  test('lookup returns null when short not found', () => {
    const idx = new JsonlIndex(projectsDir);
    expect(idx.lookup('deadbeef')).toBeNull();
  });

  test('lookup returns most-recent path when multiple JSONLs share short prefix', async () => {
    // Two files with same 8-char short prefix in different project dirs
    const projA = join(projectsDir, '-Users-a');
    const projB = join(projectsDir, '-Users-b');
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    const pathOld = join(projA, '12345678-0000-0000-0000-aaaaaaaaaaaa.jsonl');
    const pathNew = join(projB, '12345678-0000-0000-0000-bbbbbbbbbbbb.jsonl');
    writeFileSync(pathOld, '{}\n');
    await new Promise(r => setTimeout(r, 20)); // ensure different mtime
    writeFileSync(pathNew, '{}\n');
    const idx = new JsonlIndex(projectsDir);
    expect(idx.lookup('12345678')).toBe(pathNew);
  });

  test('refresh handles missing projects dir gracefully', () => {
    const idx = new JsonlIndex(join(tmpRoot, 'does-not-exist'));
    expect(() => idx.refresh()).not.toThrow();
    expect(idx.lookup('any-shrt')).toBeNull();
  });

  test('refresh rebuilds when filesystem changes', () => {
    const idx = new JsonlIndex(projectsDir);
    expect(idx.lookup('eeee0000')).toBeNull();
    writeJsonl('eeee0000', 'eeee0000-0000-0000-0000-000000000000', []);
    expect(idx.lookup('eeee0000')).toBeTruthy(); // refresh picks up the new file
  });
});

describe('deriveNameFromJsonl', () => {
  test('returns name + full sessionId from JSONL first user prompt', () => {
    writeJsonl('3a41fe73', '3a41fe73-0951-470a-bd2f-fb5a9f0fbe6b', [
      { type: 'user', message: { role: 'user', content: '你的当前模型是？' } },
    ]);
    const idx = new JsonlIndex(projectsDir);
    const result = deriveNameFromJsonl('3a41fe73', idx);
    expect(result).toEqual({
      name: '你的当前模型是？',
      sessionId: '3a41fe73-0951-470a-bd2f-fb5a9f0fbe6b',
    });
  });

  test('returns null when short hash has no JSONL', () => {
    const idx = new JsonlIndex(projectsDir);
    expect(deriveNameFromJsonl('missing0', idx)).toBeNull();
  });

  test('returns null when JSONL exists but has no candidate user prompt', () => {
    writeJsonl('emptyone', 'emptyone-0000-0000-0000-000000000000', [
      { type: 'mode', mode: 'normal' },
      { type: 'user', message: { role: 'user', content: '继续' } },
    ]);
    const idx = new JsonlIndex(projectsDir);
    expect(deriveNameFromJsonl('emptyone', idx)).toBeNull();
  });

  test('normalizes whitespace and truncates to 60 chars', () => {
    const longText =
      '帮我写一个 v2.2.7 修复\n  cc-linker Agent View 飞书侧已 settled session 名称退化为 short hash 的 bug';
    writeJsonl('longgggg', 'longgggg-0000-0000-0000-000000000000', [
      { type: 'user', message: { role: 'user', content: longText } },
    ]);
    const idx = new JsonlIndex(projectsDir);
    const result = deriveNameFromJsonl('longgggg', idx);
    expect(result).toBeTruthy();
    expect(result!.name.length).toBeLessThanOrEqual(60);
    expect(result!.name).not.toContain('\n');
    expect(result!.name.startsWith('帮我写一个 v2.2.7 修复')).toBe(true);
  });
});

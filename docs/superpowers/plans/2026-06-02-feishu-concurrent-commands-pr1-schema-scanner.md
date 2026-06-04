# 飞书并发命令 PR 1: Schema + Scanner 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 升 registry schema 到 v4（新增 `last_user_preview` / `last_assistant_preview` 字段），实现 `migrateV3toV4` 幂等迁移函数，让 scanner 抓取用户/助手末条 80 字符 preview，给 scan_cache 加 `schemaVersion` 失配检测机制。

**Architecture:** 数据层独立升级——只动 types.ts / registry.ts / jsonl.ts / cache.ts，**不动任何飞书侧代码**。所有改动向后兼容：CLI 仍能读 v4 registry（只忽略新字段），scanner 老 mtime 缓存自动失效（schemaVersion 失配返回空 Map 触发全量重扫）。

**Tech Stack:** Bun + TypeScript + Zod（v4 schema 验证）+ `bun:test`。复用现有 `loadCache` / `saveCache` / `parseFull` / `parseTail` / `migrateV1toV2` 模式。

**Spec:** `docs/superpowers/specs/2026-06-02-feishu-concurrent-commands-and-session-overview-design.md` 第 1-3 节（含 §2.1 scanner 缓存失效、§3.1 大文件 4KB fallback、§3.2 parseFull 全量遍历）

---

## File Structure

| 文件 | 职责 |
|------|------|
| `src/registry/types.ts` | **修改**:SessionEntry 加 `last_user_preview` / `last_assistant_preview` optional 字段,RegistrySchema version: 3→4 |
| `src/registry/registry.ts` | **修改**:加 `migrateV3toV4(parsed)` 幂等函数 + 3 调用点（`load()` / `reload()` / `readLatestState()`）+ `emptyRegistry()` version 4 |
| `src/scanner/jsonl.ts` | **修改**:`parseFull` 全量遍历提取 lastUserPreview(覆盖两种 content 形态) + `parseTail` 大文件分支加 4KB fallback + return 三个字段并存(保留 last_message_preview) |
| `src/scanner/cache.ts` | **修改**:FileCacheFile 类型 + loadCache 检测 schemaVersion 失配 + saveCache 写 meta |
| `tests/unit/registry/migration-v3-v4.test.ts` | **新增**:7 个迁移测试用例 |
| `tests/unit/scanner/cache.test.ts` | **新增**:5 个 cache schemaVersion 测试用例 |
| `tests/unit/scanner/jsonl.test.ts` | **修改**:补充 last_user_preview / last_assistant_preview 提取测试 + parseFull 全量遍历测试 |

---

## Task 1: 加 schema 字段并升 version

**Files:**
- Modify: `src/registry/types.ts:9-39`

- [ ] **Step 1: 在 SessionEntrySchema 加两个 optional 字段**

修改 `src/registry/types.ts:28-31`（在 `last_message_preview` 之后加）:

```typescript
  title: z.string().nullable(),
  message_count: z.number(),
  last_message_preview: z.string(),                    // 100 字符，向后兼容 CLI/bot 多处复用
  last_user_preview: z.string().optional(),             // 新增 80 字符
  last_assistant_preview: z.string().optional(),        // 新增 80 字符
  status: StatusSchema.optional(),
  lastKnownProvider: z.string().nullable().optional(), // Display-only: what model was used when session was created
```

- [ ] **Step 2: 升 RegistrySchema version 3 → 4**

修改 `src/registry/types.ts:34-38`:

```typescript
export const RegistrySchema = z.object({
  version: z.literal(4),  // 3 → 4
  updated_at: z.string(),
  sessions: z.record(z.string(), SessionEntrySchema),
});
```

- [ ] **Step 3: 跑 typecheck 验证**

Run: `cd /Users/wuyujun/Git/cc-linker && bun run typecheck`
Expected: 编译错误——`migrateV3toV4` 还没实现，`emptyRegistry` 还是 3，下游会失败。这是预期的。继续。

- [ ] **Step 4: Commit**

```bash
cd /Users/wuyujun/Git/cc-linker
git add src/registry/types.ts
git commit -m "feat(registry): bump schema v3→4, add last_user/last_assistant preview fields"
```

---

## Task 2: 写 failing test 给 migrateV3toV4

**Files:**
- Create: `tests/unit/registry/migration-v3-v4.test.ts`

- [ ] **Step 1: 创建测试文件**

新建 `tests/unit/registry/migration-v3-v4.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RegistryManager } from '../../../src/registry';  // 与项目其他测试一致（用 barrel export）

describe('migrateV3toV4', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'registry-v3-test-'));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeV3Registry(version: 3, sessions: Record<string, any> = {}): void {
    const data = {
      version,
      updated_at: new Date().toISOString(),
      sessions,
    };
    writeFileSync(join(tmpDir, 'registry.json'), JSON.stringify(data, null, 2));
  }

  it('migrates v3 complete registry to v4', () => {
    writeV3Registry(3, {
      'session-1': {
        origin: 'cli',
        cwd: '/tmp/proj',
        project_name: 'proj',
        jsonl_path: '/tmp/proj/.jsonl',
        project_dir: 'proj',
        created_at: '2026-01-01T00:00:00Z',
        last_active: '2026-01-02T00:00:00Z',
        title: 'Test',
        message_count: 5,
        last_message_preview: 'some preview',
      },
    });

    const manager = new RegistryManager(tmpDir);
    const data = manager.sessions;
    expect(data['session-1'].last_message_preview).toBe('some preview');
    expect(manager.path).toContain('registry.json');
  });

  it('preserves v3 entry missing optional fields', () => {
    writeV3Registry(3, {
      'session-1': {
        origin: 'cli',
        cwd: '/tmp/proj',
        project_name: null,
        jsonl_path: null,
        project_dir: null,
        created_at: '2026-01-01T00:00:00Z',
        last_active: '2026-01-02T00:00:00Z',
        title: null,
        message_count: 0,
        last_message_preview: '',
      },
    });

    const manager = new RegistryManager(tmpDir);
    expect(manager.sessions['session-1'].title).toBeNull();
    expect(manager.sessions['session-1'].last_message_preview).toBe('');
  });

  it('migrateV3toV4 is idempotent on v4 data', () => {
    writeV3Registry(3, {});
    const manager = new RegistryManager(tmpDir);
    // 触发一次 save（写盘 v4）
    manager.upsert('new-session', {
      origin: 'cli',
      cwd: '/tmp',
      project_name: null,
      jsonl_path: null,
      project_dir: null,
      created_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
      title: 'New',
      message_count: 1,
      last_message_preview: 'preview',
    });
    // 重新加载——应该是 v4 不需要再 migrate
    const manager2 = new RegistryManager(tmpDir);
    expect(manager2.sessions['new-session'].title).toBe('New');
  });

  it('handles v2 → v1toV2 → v3toV4 chain', () => {
    const v2 = {
      version: 2,
      updated_at: new Date().toISOString(),
      sessions: {
        'legacy-session': {
          origin: 'cli',
          cwd: '/tmp/legacy',
          project_name: null,
          jsonl_path: null,
          project_dir: null,
          created_at: '2025-01-01T00:00:00Z',
          last_active: '2025-01-02T00:00:00Z',
          title: 'Legacy',
          message_count: 10,
          last_message_preview: 'old preview',
        },
      },
    };
    writeFileSync(join(tmpDir, 'registry.json'), JSON.stringify(v2, null, 2));

    const manager = new RegistryManager(tmpDir);
    expect(manager.sessions['legacy-session'].title).toBe('Legacy');
    expect(manager.sessions['legacy-session'].last_message_preview).toBe('old preview');
  });

  it('createEmpty returns v4 registry when file missing', () => {
    const manager = new RegistryManager(tmpDir);
    expect(manager.sessions).toEqual({});
    // 验证写盘版本
    const raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(4);
  });

  it('recovers from corrupted v3 file via createEmpty', () => {
    writeFileSync(join(tmpDir, 'registry.json'), '{ invalid json');

    const manager = new RegistryManager(tmpDir);
    expect(manager.sessions).toEqual({});
    const raw = JSON.parse(readFileSync(join(tmpDir, 'registry.json'), 'utf8'));
    expect(raw.version).toBe(4);
  });

  it('preserves last_message_preview in v3→v4 migration', () => {
    writeV3Registry(3, {
      'session-1': {
        origin: 'cli',
        cwd: '/tmp/proj',
        project_name: null,
        jsonl_path: null,
        project_dir: null,
        created_at: '2026-01-01T00:00:00Z',
        last_active: '2026-01-02T00:00:00Z',
        title: 'Test',
        message_count: 5,
        last_message_preview: 'CRITICAL_PREVIEW_TEXT',
      },
    });

    const manager = new RegistryManager(tmpDir);
    expect(manager.sessions['session-1'].last_message_preview).toBe('CRITICAL_PREVIEW_TEXT');
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/registry/migration-v3-v4.test.ts`
Expected: 全部失败，因为 `migrateV3toV4` 未实现，`emptyRegistry` 还是 v3。`RegistrySchema.parse(v3 data)` 会抛错被 catch 走 `createEmpty`，但 `createEmpty` 当前用 v3 写盘，所以读盘再 parse 又会失败。

- [ ] **Step 3: Commit 失败测试**

```bash
cd /Users/wuyujun/Git/cc-linker
git add tests/unit/registry/migration-v3-v4.test.ts
git commit -m "test(registry): add migrateV3toV4 test suite (red)"
```

---

## Task 3: 实现 migrateV3toV4 + 3 调用点 + emptyRegistry

**Files:**
- Modify: `src/registry/registry.ts:13-45`（加 migrateV3toV4）
- Modify: `src/registry/registry.ts:87-92`（load()）
- Modify: `src/registry/registry.ts:104-115`（reload()）
- Modify: `src/registry/registry.ts:315-327`（readLatestState()）
- Modify: `src/registry/registry.ts:124-130`（emptyRegistry）

- [ ] **Step 1: 在 migrateV1toV2 之后加 migrateV3toV4**

修改 `src/registry/registry.ts:13-45`，在 `migrateV1toV2` 函数之后插入:

```typescript
/** Migrate v3 registry to v4 schema */
function migrateV3toV4(parsed: any): void {
  if (parsed.version === 3) {
    parsed.version = 4;
    // 不主动改 sessions，避免破坏数据
    // last_user_preview / last_assistant_preview 是 optional 字段，缺省 undefined
  }
  // parsed.version === 4 时跳过（多次 load 幂等）
  // 其他值让 Zod 抛错（异常路径走 restoreFromBackup）
}
```

- [ ] **Step 2: load() 加 migrateV3toV4**

修改 `src/registry/registry.ts:83-92`:

```typescript
    try {
      const raw = readFileSync(this.registryPath, 'utf8');
      let parsed = JSON.parse(raw);

      migrateV1toV2(parsed);
      migrateV3toV4(parsed);
      return RegistrySchema.parse(parsed);
    } catch (err) {
      logger.warn('Registry 损坏，尝试从备份恢复...');
      return this.restoreFromBackup() ?? this.createEmpty();
    }
```

- [ ] **Step 3: reload() 加 migrateV3toV4**

修改 `src/registry/registry.ts:104-115`:

```typescript
  async reload(): Promise<void> {
    await withReadLock(async () => {
      if (!existsSync(this.registryPath)) {
        this.data = this.createEmpty();
        return;
      }
      const raw = readFileSync(this.registryPath, 'utf8');
      let parsed = JSON.parse(raw);
      migrateV1toV2(parsed);
      migrateV3toV4(parsed);
      this.data = RegistrySchema.parse(parsed);
    });
  }
```

- [ ] **Step 4: readLatestState() 加 migrateV3toV4**

修改 `src/registry/registry.ts:315-327`:

```typescript
  private readLatestState(): Registry {
    if (!existsSync(this.registryPath)) {
      return this.emptyRegistry();
    }

    try {
      let parsed = JSON.parse(readFileSync(this.registryPath, 'utf8'));
      migrateV1toV2(parsed);
      migrateV3toV4(parsed);
      return RegistrySchema.parse(parsed);
    } catch {
      return this.restoreFromBackup() ?? this.emptyRegistry();
    }
  }
```

- [ ] **Step 5: emptyRegistry() 升 v4**

修改 `src/registry/registry.ts:124-130`:

```typescript
  private emptyRegistry(): Registry {
    return {
      version: 4,  // 3 → 4
      updated_at: new Date().toISOString(),
      sessions: {},
    };
  }
```

- [ ] **Step 6: 跑 typecheck**

Run: `cd /Users/wuyujun/Git/cc-linker && bun run typecheck`
Expected: 通过。

- [ ] **Step 7: 跑 migration 测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/registry/migration-v3-v4.test.ts`
Expected: 7 个测试全过。

- [ ] **Step 8: 跑现有 registry 相关测试，确保没破坏**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/feishu/mapping.test.ts`
Expected: 全过（mapping 不依赖 schema version）。

- [ ] **Step 9: Commit**

```bash
cd /Users/wuyujun/Git/cc-linker
git add src/registry/registry.ts
git commit -m "feat(registry): implement migrateV3toV4 (idempotent) + 3 call sites + emptyRegistry v4"
```

---

## Task 4: 写 failing test 给 cache schemaVersion

**Files:**
- Create: `tests/unit/scanner/cache.test.ts`

- [ ] **Step 1: 创建测试文件**

新建 `tests/unit/scanner/cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadCache, saveCache } from '../../../src/scanner/cache';

describe('scan_cache schemaVersion', () => {
  let tmpDir: string;
  let cachePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cache-test-'));
    cachePath = join(tmpDir, 'scan_cache.json');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty Map when cache file missing', () => {
    const cache = loadCache(cachePath);
    expect(cache.size).toBe(0);
  });

  it('returns empty Map for v3 format cache (no meta.schemaVersion)', () => {
    writeFileSync(cachePath, JSON.stringify({
      '/path/to/file.jsonl': 1234567890,
    }));
    const cache = loadCache(cachePath);
    expect(cache.size).toBe(0);
  });

  it('returns empty Map for v3 format cache (meta.schemaVersion: 3)', () => {
    writeFileSync(cachePath, JSON.stringify({
      meta: { schemaVersion: 3 },
      cache: { '/path/to/file.jsonl': 1234567890 },
    }));
    const cache = loadCache(cachePath);
    expect(cache.size).toBe(0);
  });

  it('loads v4 format cache normally', () => {
    writeFileSync(cachePath, JSON.stringify({
      meta: { schemaVersion: 4 },
      cache: { '/path/to/file.jsonl': 1234567890 },
    }));
    const cache = loadCache(cachePath);
    expect(cache.size).toBe(1);
    expect(cache.get('/path/to/file.jsonl')).toBe(1234567890);
  });

  it('returns empty Map for corrupted cache JSON', () => {
    writeFileSync(cachePath, '{ invalid json');
    const cache = loadCache(cachePath);
    expect(cache.size).toBe(0);
  });

  it('saveCache writes v4 format with meta.schemaVersion: 4', () => {
    const cache = new Map<string, number>();
    cache.set('/path/a.jsonl', 1000);
    cache.set('/path/b.jsonl', 2000);

    saveCache(cache, cachePath);

    const raw = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(raw.meta.schemaVersion).toBe(4);
    expect(raw.cache['/path/a.jsonl']).toBe(1000);
    expect(raw.cache['/path/b.jsonl']).toBe(2000);
  });

  it('round-trip: saveCache → loadCache preserves entries', () => {
    const cache = new Map<string, number>();
    cache.set('/x.jsonl', 999);

    saveCache(cache, cachePath);
    const loaded = loadCache(cachePath);

    expect(loaded.get('/x.jsonl')).toBe(999);
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/scanner/cache.test.ts`
Expected: 全部失败——当前 `loadCache` 把 v3 格式当 v4 格式读，会返回有数据的 Map；当前 `saveCache` 写纯对象无 meta 字段。

- [ ] **Step 3: Commit 失败测试**

```bash
cd /Users/wuyujun/Git/cc-linker
git add tests/unit/scanner/cache.test.ts
git commit -m "test(scanner): add cache schemaVersion test suite (red)"
```

---

## Task 5: 实现 FileCacheFile 类型 + loadCache/saveCache schemaVersion 校验

**Files:**
- Modify: `src/scanner/cache.ts`（全文件重写）

- [ ] **Step 1: 重写 cache.ts**

全文件替换 `src/scanner/cache.ts` 内容:

```typescript
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { SCAN_CACHE_PATH } from '../utils/paths';
import { logger } from '../utils/logger';

export type FileCache = Map<string, number>;
export type FileCacheMeta = { schemaVersion: number };
export type FileCacheFile = { meta: FileCacheMeta; cache: Record<string, number> };

const CURRENT_SCHEMA_VERSION = 4;

export function loadCache(cachePath?: string): FileCache {
  const path = cachePath ?? SCAN_CACHE_PATH;
  if (!existsSync(path)) return new Map();

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as FileCacheFile;
    // 关键：schemaVersion 缺失或不匹配时返回空 cache，触发 scanner 全量重扫
    if (parsed.meta?.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      logger.info(
        `scan_cache schemaVersion=${parsed.meta?.schemaVersion ?? 'missing'}，` +
        `当前要求=${CURRENT_SCHEMA_VERSION}，丢弃 cache 全量重扫`
      );
      return new Map();
    }
    return new Map(Object.entries(parsed.cache ?? {}));
  } catch {
    return new Map();
  }
}

export function saveCache(cache: FileCache, cachePath?: string): void {
  const path = cachePath ?? SCAN_CACHE_PATH;
  const data: FileCacheFile = {
    meta: { schemaVersion: CURRENT_SCHEMA_VERSION },
    cache: Object.fromEntries(cache),
  };
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}
```

- [ ] **Step 2: 跑 typecheck**

Run: `cd /Users/wuyujun/Git/cc-linker && bun run typecheck`
Expected: 通过。

- [ ] **Step 3: 跑 cache 测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/scanner/cache.test.ts`
Expected: 7 个测试全过。

- [ ] **Step 4: 跑现有 scanner 测试，确保不破坏**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/scanner/jsonl.test.ts`
Expected: 全过（jsonl 不依赖 cache 内部结构，只用 `FileCache` 类型）。

- [ ] **Step 5: Commit**

```bash
cd /Users/wuyujun/Git/cc-linker
git add src/scanner/cache.ts
git commit -m "feat(scanner): add schemaVersion to scan_cache, invalidate on version mismatch"
```

---

## Task 6: 写 failing test 给 parseTail 提取 lastUserPreview + 4KB fallback

**Files:**
- Create: `tests/unit/scanner/jsonl-preview.test.ts`（新文件，与现有 jsonl.test.ts 并列）

- [ ] **Step 1: 创建测试文件**

新建 `tests/unit/scanner/jsonl-preview.test.ts`:

```typescript
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
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
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
    const scanner = new JSONLScanner(registry, cache, tmpDir);
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
    const scanner = new JSONLScanner(registry, cache, tmpDir);
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
    const scanner = new JSONLScanner(registry, cache, tmpDir);
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
    const scanner = new JSONLScanner(registry, cache, tmpDir);
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
    const scanner = new JSONLScanner(registry, cache, tmpDir);
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
    const scanner = new JSONLScanner(registry, cache, tmpDir);
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
    const scanner = new JSONLScanner(registry, cache, tmpDir);
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
    await registry.flush();  // 显式 flush 写盘

    const cache: FileCache = new Map();
    cache.set(join(projectDir, `${sessionId}.jsonl`), 0);  // 强制 scanner 重扫
    const scanner = new JSONLScanner(registry, cache, tmpDir);
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
```

- [ ] **Step 2: 跑测试看它失败**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/scanner/jsonl-preview.test.ts`
Expected: **8 个**测试全失败——当前 `parseTail` / `parseFull` 还没提取 `lastUserPreview`，`parseTail` 也没有 4KB fallback 逻辑。
（review 修正：原计划写"7 个"，但文件含 8 个测试：6 个基础 + 1 个 parseFull 跨 10 行 + 1 个 parseTail 4KB fallback）

- [ ] **Step 3: Commit 失败测试**

```bash
cd /Users/wuyujun/Git/cc-linker
git add tests/unit/scanner/jsonl-preview.test.ts
git commit -m "test(scanner): add last_user/last_assistant preview extraction tests (red)"
```

---

## Task 7: 改 parseTail 提取 lastUserPreview + 4KB fallback

**Files:**
- Modify: `src/scanner/jsonl.ts:203-267`（parseTail 大文件分支和小文件分支）
- Modify: `src/scanner/jsonl.ts:259-263`（return 对象）

- [ ] **Step 1: 在 parseTail 函数顶部声明 lastUserPreview（review 必改——scope 修复）**

修改 `src/scanner/jsonl.ts:209-211`（与其他 let 声明并列）:

把:
```typescript
    let lastActive: string | null = null;
    let preview = '';
    let lineCount = 0;
```

改为:
```typescript
    let lastActive: string | null = null;
    let preview = '';
    let lastUserPreview = '';  // 新增：必须在函数顶部声明，让 if/else 两个分支都能访问
    let lineCount = 0;
```

- [ ] **Step 2: 在 parseTail 的大文件分支加 lastUserPreview 提取**

修改 `src/scanner/jsonl.ts:221-233` 的循环:

把:
```typescript
        for (let i = tailLines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(tailLines[i]);
            if (NON_MESSAGE_TYPES.has(entry.type)) continue;
            if (entry.type === 'assistant' || entry.type === 'user') {
              if (!lastActive) lastActive = entry.timestamp;
            }
            if (entry.type === 'assistant' && !preview) {
              const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
              if (textBlock) preview = textBlock.text.slice(0, 100);
            }
          } catch {}
        }
```

改为（加 lastUserPreview 提取）:

```typescript
        for (let i = tailLines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(tailLines[i]);
            if (NON_MESSAGE_TYPES.has(entry.type)) continue;
            if (entry.type === 'assistant' || entry.type === 'user') {
              if (!lastActive) lastActive = entry.timestamp;
            }
            if (entry.type === 'assistant' && !preview) {
              const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
              if (textBlock) preview = textBlock.text.slice(0, 100);
            }
            if (entry.type === 'user' && !lastUserPreview) {
              const content = entry.message?.content;
              if (typeof content === 'string') {
                lastUserPreview = content.slice(0, 100);
              } else if (Array.isArray(content)) {
                const textBlock = content.find((b: any) => b.type === 'text');
                if (textBlock?.text) lastUserPreview = textBlock.text.slice(0, 100);
              }
            }
          } catch {}
        }

        // 4KB 内找不到 user preview 时全量重读（fallback）
        if (!lastUserPreview && stat.size > 4096) {
          try {
            const fullContent = readFileSync(filePath, 'utf8');
            const allLines = fullContent.split('\n').filter(Boolean);
            for (let i = allLines.length - 1; i >= Math.max(0, allLines.length - 50); i--) {
              try {
                const entry = JSON.parse(allLines[i]);
                if (entry.type === 'user') {
                  const content = entry.message?.content;
                  if (typeof content === 'string') {
                    lastUserPreview = content.slice(0, 100);
                    break;
                  } else if (Array.isArray(content)) {
                    const textBlock = content.find((b: any) => b.type === 'text');
                    if (textBlock?.text) {
                      lastUserPreview = textBlock.text.slice(0, 100);
                      break;
                    }
                  }
                }
              } catch {}
            }
          } catch (err) {
            logger.warn(`parseTail 全量 fallback 失败: ${filePath}: ${err}`);
          }
        }
```

- [ ] **Step 3: 在 parseTail 的小文件分支（line 239-257）做同样改造**

把:
```typescript
      } else {
        // 小文件：直接读全部
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        lineCount = lines.length;

        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
          try {
            const entry = JSON.parse(lines[i]);
            if (NON_MESSAGE_TYPES.has(entry.type)) continue;
            if (entry.type === 'assistant' || entry.type === 'user') {
              if (!lastActive) lastActive = entry.timestamp;
            }
            if (entry.type === 'assistant' && !preview) {
              const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
              if (textBlock) preview = textBlock.text.slice(0, 100);
            }
          } catch {}
        }
      }
```

改为（同样加 lastUserPreview 提取，但小文件不需要 4KB fallback）:

```typescript
      } else {
        // 小文件：直接读全部
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        lineCount = lines.length;

        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
          try {
            const entry = JSON.parse(lines[i]);
            if (NON_MESSAGE_TYPES.has(entry.type)) continue;
            if (entry.type === 'assistant' || entry.type === 'user') {
              if (!lastActive) lastActive = entry.timestamp;
            }
            if (entry.type === 'assistant' && !preview) {
              const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
              if (textBlock) preview = textBlock.text.slice(0, 100);
            }
            if (entry.type === 'user' && !lastUserPreview) {
              const content = entry.message?.content;
              if (typeof content === 'string') {
                lastUserPreview = content.slice(0, 100);
              } else if (Array.isArray(content)) {
                const textBlock = content.find((b: any) => b.type === 'text');
                if (textBlock?.text) lastUserPreview = textBlock.text.slice(0, 100);
              }
            }
          } catch {}
        }
      }
```

**注意**：`lastUserPreview` 已在 Step 1 顶部声明，小文件分支可直接访问（无需重复声明）。

- [ ] **Step 4: 改 parseTail return 对象（保留 last_message_preview）**

修改 `src/scanner/jsonl.ts:259-263` 的 return:

把:
```typescript
      return {
        ...(lineCount > 0 ? { message_count: lineCount } : {}),
        ...(lastActive ? { last_active: lastActive } : {}),
        ...(preview ? { last_message_preview: preview } : {}),
      };
```

改为:
```typescript
      return {
        ...(lineCount > 0 ? { message_count: lineCount } : {}),
        ...(lastActive ? { last_active: lastActive } : {}),
        ...(preview ? { last_message_preview: preview } : {}),                    // 保留 100 字符（向后兼容）
        ...(preview ? { last_assistant_preview: preview.slice(0, 80) } : {}),     // 新增 80 字符
        ...(lastUserPreview ? { last_user_preview: lastUserPreview.slice(0, 80) } : {}),  // 新增
      };
```

- [ ] **Step 5: 跑 typecheck**

Run: `cd /Users/wuyujun/Git/cc-linker && bun run typecheck`
Expected: 通过。

- [ ] **Step 6: 跑 jsonl-preview 测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/scanner/jsonl-preview.test.ts`
Expected: **8 个**测试全过。

- [ ] **Step 7: 跑现有 jsonl 测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/scanner/jsonl.test.ts`
Expected: 全过（保留 last_message_preview 不破坏老断言）。

- [ ] **Step 8: Commit**

```bash
cd /Users/wuyujun/Git/cc-linker
git add src/scanner/jsonl.ts
git commit -m "feat(scanner): extract last_user/last_assistant preview with 4KB fallback"
```

---

## Task 8: 改 parseFull 全量遍历 + return 三字段

**Files:**
- Modify: `src/scanner/jsonl.ts:148-164`（parseFull 提取循环）
- Modify: `src/scanner/jsonl.ts:189-200`（parseFull return）

- [ ] **Step 1: 改 parseFull 循环为全量遍历（review 必改——合并原 Step 1/2）**

修改 `src/scanner/jsonl.ts:148-164`:

把:
```typescript
    let lastActive: string | null = null;
    let preview = '';
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (NON_MESSAGE_TYPES.has(entry.type)) continue;
        if ((entry.type === 'assistant' || entry.type === 'user') && !lastActive) {
          lastActive = entry.timestamp;
        }
        if (entry.type === 'assistant' && !preview) {
          const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
          if (textBlock) preview = textBlock.text.slice(0, 100);
        }
      } catch {
        // Silently skip malformed JSON lines
      }
    }
```

改为（全量遍历 + 加 lastUserPreview + 早退优化）:

```typescript
    let lastActive: string | null = null;
    let preview = '';
    let lastUserPreview = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (NON_MESSAGE_TYPES.has(entry.type)) continue;
        if ((entry.type === 'assistant' || entry.type === 'user') && !lastActive) {
          lastActive = entry.timestamp;
        }
        if (entry.type === 'assistant' && !preview) {
          const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
          if (textBlock) preview = textBlock.text.slice(0, 100);
        }
        if (entry.type === 'user' && !lastUserPreview) {
          const content = entry.message?.content;
          if (typeof content === 'string') {
            lastUserPreview = content.slice(0, 100);
          } else if (Array.isArray(content)) {
            const textBlock = content.find((b: any) => b.type === 'text');
            if (textBlock?.text) lastUserPreview = textBlock.text.slice(0, 100);
          }
        }
        // 三个字段都拿到就 break 提升性能
        if (lastActive && preview && lastUserPreview) break;
      } catch {
        // Silently skip malformed JSON lines
      }
    }
```

- [ ] **Step 2: 改 parseFull return 加三字段并存**

修改 `src/scanner/jsonl.ts:189-200`:

把:
```typescript
    return {
      origin,
      cwd: cwd ?? (process.env.HOME ?? homedir()),
      project_name: this.inferProjectName(cwd ?? (process.env.HOME ?? homedir())),
      project_dir,
      title,
      message_count: messageLines.length,
      created_at: createdAt ?? new Date().toISOString(),
      last_active: lastActive ?? new Date().toISOString(),
      last_message_preview: preview || lastPrompt?.slice(0, 100) || '[无内容]',
      status: 'active',
    };
```

改为（保留 last_message_preview 同时新增 80 字符版）:

```typescript
    return {
      origin,
      cwd: cwd ?? (process.env.HOME ?? homedir()),
      project_name: this.inferProjectName(cwd ?? (process.env.HOME ?? homedir())),
      project_dir,
      title,
      message_count: messageLines.length,
      created_at: createdAt ?? new Date().toISOString(),
      last_active: lastActive ?? new Date().toISOString(),
      // 三字段并存：last_message_preview 保留 100 字符（向后兼容 CLI/bot 多处复用）
      last_message_preview: preview || lastPrompt?.slice(0, 100) || '[无内容]',
      // 新增 80 字符版（bot overview 卡片用）
      last_assistant_preview: preview ? preview.slice(0, 80) : undefined,
      last_user_preview: lastUserPreview ? lastUserPreview.slice(0, 80) : undefined,
      status: 'active',
    };
```

- [ ] **Step 3: 跑 typecheck**

Run: `cd /Users/wuyujun/Git/cc-linker && bun run typecheck`
Expected: 通过。

- [ ] **Step 4: 跑全部 scanner 测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test tests/unit/scanner/`
Expected: jsonl.test.ts + jsonl-preview.test.ts + cache.test.ts 全部通过。

- [ ] **Step 5: Commit**

```bash
cd /Users/wuyujun/Git/cc-linker
git add src/scanner/jsonl.ts
git commit -m "feat(scanner): parseFull full-file iteration + 3-field return (preserve last_message_preview)"
```

---

## Task 9: 全量测试 + 验证无破坏

**Files:**
- 无代码修改，仅验证

- [ ] **Step 1: 跑所有单元测试**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test`
Expected: 全过。如有失败，必须修复后才能进入 staging。

- [ ] **Step 2: 跑 typecheck**

Run: `cd /Users/wuyujun/Git/cc-linker && bun run typecheck`
Expected: 通过。

- [ ] **Step 3: 跑测试覆盖率**

Run: `cd /Users/wuyujun/Git/cc-linker && bun test --coverage`
Expected: registry.ts 和 scanner/jsonl.ts 覆盖率 ≥ 80%。

- [ ] **Step 4: 手动 smoke test：v3 registry 升级（review 必改——路径修正）**

在临时目录构造 v3 registry 文件，启动 daemon（`bun run dev start`），观察：
- 启动日志中是否有 "scan_cache schemaVersion=missing, 当前要求=4, 丢弃 cache 全量重扫"
- `~/.cc-linker/registry.json` 的 version 字段是否升到 4
- `~/.cc-linker/scan_cache.json` 是否包含 `meta.schemaVersion: 4`

**注意路径**（review 修正）：`src/utils/paths.ts` 定义 `CC_LINKER_DIR = process.env.CC_LINKER_DIR ?? join(HOME, '.cc-linker')`，所以**必须**用 `CC_LINKER_DIR` 环境变量覆盖（而不是只覆盖 `HOME`）：

```bash
# 准备测试环境
TEST_DIR=/tmp/cc-linker-test
mkdir -p $TEST_DIR
cat > $TEST_DIR/registry.json <<EOF
{
  "version": 3,
  "updated_at": "2026-01-01T00:00:00Z",
  "sessions": {
    "test-uuid": {
      "origin": "cli",
      "cwd": "/tmp/test",
      "project_name": null,
      "jsonl_path": null,
      "project_dir": null,
      "created_at": "2026-01-01T00:00:00Z",
      "last_active": "2026-01-02T00:00:00Z",
      "title": "Old Session",
      "message_count": 5,
      "last_message_preview": "old preview"
    }
  }
}
EOF

# 启动 daemon 观察（CC_LINKER_DIR 覆盖才能把 v3 放在我们指定的位置）
cd /Users/wuyujun/Git/cc-linker
CC_LINKER_DIR=$TEST_DIR bun run dev start --no-sync
# 检查 version
head -3 $TEST_DIR/registry.json
# 预期看到 "version": 4
```

- [ ] **Step 5: 验证无破坏后无 commit**

此任务无代码修改。如果前 4 步有失败，修复对应 task 后重跑。

---

## Task 10: Commit 全部 + 创建 PR

- [ ] **Step 1: 检查 git status**

Run: `cd /Users/wuyujun/Git/cc-linker && git status`
Expected: 干净（前面 8 个 commit 已经把改动都提交了）。

- [ ] **Step 2: 推送到远端并创建 PR**

```bash
cd /Users/wuyujun/Git/cc-linker
git push origin <branch-name>
gh pr create --base master --title "feat(registry+scanner): schema v3→4 + user/assistant preview fields" --body "$(cat <<'EOF'
## 概述
PR 1 of 3: Schema 升级到 v4，新增 last_user_preview / last_assistant_preview 字段，scanner 抓取末条 80 字符 preview，scan_cache 加 schemaVersion 失效机制。

## 范围
- src/registry/types.ts: schema 字段 + version bump
- src/registry/registry.ts: migrateV3toV4 (3 调用点) + emptyRegistry v4
- src/scanner/jsonl.ts: parseFull 全量遍历 + parseTail 4KB fallback
- src/scanner/cache.ts: schemaVersion 失配检测

## 测试
- 新增 19 个测试用例（7 migration + 5 cache + 7 preview）
- 现有测试 100% 不破坏

## 风险
- 数据层独立 PR，**不影响飞书侧任何行为**
- 失败回滚简单（git revert + 老 scanner 仍能读 v4 registry，忽略新字段）
- v3→v4 是单向升级，不要回退 schema

## 部署
直接合 master，无需 staging 验证（数据层不影响外部接口）。但建议在用户量小的环境先跑一周观察：
- `last_user_preview.hit_rate` 应该 > 90%
- `scanner.cache.invalidation` 上线当天应该有 1 次清空事件

## 后续
- PR 2: bot.ts serialKey 改造（解决 command 阻塞痛点）
- PR 3: bot.ts overview 卡片 + list 运行中标记（解决切换看不到进展）
EOF
)"
```

- [ ] **Step 3: 等 CI 通过后合并**

如项目有 CI：等所有 check 通过后 merge squash。

---

## Self-Review Checklist

执行时逐项检查：

- [ ] Task 1 schema 字段顺序与 `last_message_preview` 保留一致（向后兼容）
- [ ] Task 3 `migrateV3toV4` 在 3 个调用点都加了（load / reload / readLatestState）
- [ ] Task 3 `emptyRegistry()` 升到 v4（不是漏改）
- [ ] Task 5 `CURRENT_SCHEMA_VERSION` 是常量 4 硬编码
- [ ] Task 7 parseTail 4KB fallback 触发条件是 `!lastUserPreview && stat.size > 4096`
- [ ] Task 7 parseTail return **必须**包含 `last_message_preview`（不能删！）
- [ ] Task 8 parseFull return **必须**包含 `last_message_preview`（不能删！）
- [ ] Task 8 parseFull 循环改为 `i >= 0`（全量），不是 `i >= Math.max(0, lines.length - 10)`
- [ ] Task 9 跑全量测试无破坏
- [ ] Task 10 PR body 列出 3 PR 全景，让 reviewer 知道 PR 2/3 紧随其后

---

## 工作量估算

| Task | 范围 | 预计时间 |
|------|------|---------|
| Task 1 | schema 字段 + version | 5 分钟 |
| Task 2 | migration 失败测试 | 15 分钟 |
| Task 3 | migrateV3toV4 实现 + 3 调用点 | 15 分钟 |
| Task 4 | cache 失败测试 | 10 分钟 |
| Task 5 | cache schemaVersion 实现 | 10 分钟 |
| Task 6 | preview 失败测试（含 parseTail 4KB fallback） | 25 分钟 |
| Task 7 | parseTail 改造 | 20 分钟 |
| Task 8 | parseFull 改造 | 15 分钟 |
| Task 9 | 全量测试验证 + smoke test | 15 分钟 |
| Task 10 | PR 创建 | 10 分钟 |
| **总计** | - | **~3 小时**（不含 review 反馈循环） |

（review 修正：原 2.5h 偏乐观，Task 6 新增 parseTail 4KB fallback 测试需 5 分钟，Task 9 手动 smoke test 涉及 env variable + 路径验证需 5 分钟）

---

## 下一步

PR 1 合并后，写 PR 2 计划（`2026-06-02-feishu-concurrent-commands-pr2-bot-serialkey.md`），覆盖：
- `src/feishu/bot.ts:onMessage` serialKey 计算（isCommand 走 cmd serialKey）
- messageId 白名单校验
- bot.ts 本地 esc() helper
- 测试: `tests/unit/feishu/bot-serial-key.test.ts`

PR 3 计划（`2026-06-02-feishu-concurrent-commands-pr3-overview-card.md`），覆盖：
- buildSessionOverviewCard + isSessionRunning
- doSwitch 改造（swapped=false + overview card）
- buildListCard 加 runningMark
- doCardList text 降级加 [运行中]
- 测试: `tests/unit/feishu/bot-do-switch.test.ts` + 更新 `tests/unit/feishu/bot.test.ts:620`

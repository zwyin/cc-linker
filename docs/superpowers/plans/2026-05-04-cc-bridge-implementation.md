# cc-linker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build cc-linker, a local CLI tool that bridges cc-connect (Feishu/WeChat) and Claude Code CLI sessions via a unified Session Registry.

**Architecture:** Single-package TypeScript CLI using bun runtime. Registry stored in `~/.cc-linker/registry.json` with file locking and atomic writes. Scanner runs incrementally before CLI commands using mtime-based caching.

**Tech Stack:** TypeScript, bun, commander, inquirer, proper-lockfile, @iarna/toml, chalk, cli-table3, zod

---

## File Structure

```
cc-linker/
├── src/
│   ├── index.ts                    # CLI entry point
│   ├── registry/
│   │   ├── types.ts                # Zod schemas and TypeScript types
│   │   ├── registry.ts             # Registry CRUD, locking, backup
│   │   └── index.ts                # Re-exports
│   ├── scanner/
│   │   ├── cc-connect.ts           # cc-connect session scanner
│   │   ├── jsonl.ts                # JSONL file scanner
│   │   ├── cache.ts                # mtime cache manager
│   │   └── index.ts                # Unified sync entry
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── init.ts             # cc-linker init
│   │   │   ├── list.ts             # cc-linker list
│   │   │   ├── resume.ts           # cc-linker resume
│   │   │   ├── show.ts             # cc-linker show
│   │   │   ├── sync.ts             # cc-linker sync
│   │   │   ├── status.ts           # cc-linker status
│   │   │   ├── hook.ts             # cc-linker hook install/uninstall/status
│   │   │   ├── register.ts         # cc-linker register (internal)
│   │   │   ├── export.ts           # cc-linker export
│   │   │   ├── search.ts           # cc-linker search
│   │   │   ├── clean.ts            # cc-linker clean
│   │   │   └── feishu-cmd.ts       # cc-linker feishu-cmd
│   │   └── output.ts               # Table/JSON/CSV formatting
│   ├── hook/
│   │   └── session-start.ts        # Hook script logic
│   └── utils/
│       ├── lock.ts                 # proper-lockfile wrapper
│       ├── config.ts               # TOML config loader
│       ├── logger.ts               # Logger (file + stderr)
│       ├── errors.ts               # Error codes
│       └── paths.ts                # Path constants
├── tests/
│   ├── unit/
│   │   ├── registry.test.ts
│   │   ├── scanner/
│   │   │   ├── cc-connect.test.ts
│   │   │   └── jsonl.test.ts
│   │   └── utils/
│   │       ├── lock.test.ts
│   │       └── config.test.ts
│   ├── integration/
│   │   └── cli-commands.test.ts
│   └── fixtures/
│       ├── cc-connect-session.json
│       ├── sample.jsonl
│       └── registry.json
├── package.json
├── tsconfig.json
└── README.md
```

---

## Task 1: Project Initialization

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts` (minimal placeholder)

- [ ] **Step 1: Initialize bun project**

```bash
cd /Users/wuyujun/Git/cc-linker
bun init -y
```

- [ ] **Step 2: Install production dependencies**

```bash
bun add commander inquirer proper-lockfile @iarna/toml chalk cli-table3 zod
```

- [ ] **Step 3: Install dev dependencies**

```bash
bun add -d @types/node @types/inquirer typescript
```

- [ ] **Step 4: Update package.json with scripts and bin**

```json
{
  "name": "cc-linker",
  "version": "0.1.0",
  "description": "Bridge cc-connect and Claude Code CLI sessions",
  "main": "src/index.ts",
  "bin": {
    "cc-linker": "src/index.ts"
  },
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun build src/index.ts --compile --outfile dist/cc-linker",
    "test": "bun test",
    "test:coverage": "bun test --coverage",
    "typecheck": "tsc --noEmit"
  },
  "type": "module"
}
```

- [ ] **Step 5: Configure tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "resolveJsonModule": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 6: Create minimal CLI entry point**

```typescript
// src/index.ts
#!/usr/bin/env bun
import { Command } from 'commander';

const program = new Command();

program
  .name('cc-linker')
  .description('cc-connect 与 Claude Code CLI 的会话桥接工具')
  .version('0.1.0');

program.parse();
```

- [ ] **Step 7: Test CLI runs**

```bash
bun run src/index.ts --version
# Expected: 0.1.0

bun run src/index.ts --help
# Expected: Shows help with cc-linker description
```

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json src/index.ts bun.lockb
git commit -m "feat: initialize project with bun, commander, dependencies"
```

---

## Task 2: Utils Layer - Error Codes and Paths

**Files:**
- Create: `src/utils/errors.ts`
- Create: `src/utils/paths.ts`
- Create: `tests/unit/utils/errors.test.ts`

- [ ] **Step 1: Write failing test for error codes**

```typescript
// tests/unit/utils/errors.test.ts
import { describe, it, expect } from 'bun:test';
import { CCLinkerError } from '../../../src/utils/errors';

describe('CCLinkerError', () => {
  it('creates error with code and message', () => {
    const err = new CCLinkerError('E001', 'Registry not found');
    expect(err.code).toBe('E001');
    expect(err.message).toBe('Registry not found');
    expect(err.name).toBe('CCLinkerError');
  });

  it('includes details when provided', () => {
    const err = new CCLinkerError('E006', 'Multiple matches', { count: 3 });
    expect(err.details).toEqual({ count: 3 });
  });

  it('formats toString correctly', () => {
    const err = new CCLinkerError('E001', 'Registry not found');
    expect(err.toString()).toBe('[E001] Registry not found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/utils/errors.test.ts
# Expected: FAIL - module not found
```

- [ ] **Step 3: Implement error codes**

```typescript
// src/utils/errors.ts
export class CCLinkerError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'CCLinkerError';
  }
}

export function handleError(err: unknown): never {
  if (err instanceof CCLinkerError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
    if (err.details) {
      console.error(`详情: ${JSON.stringify(err.details)}`);
    }

    const suggestions: Record<string, string[]> = {
      'E001': ['运行 cc-linker init 初始化 registry'],
      'E002': ['会话已被清理，无法恢复', '运行 cc-linker sync 重新扫描'],
      'E007': ['等待其他进程完成', '或删除 ~/.cc-linker/registry.json.lock'],
      'E008': ['会话创建目录已被删除，使用 --cwd 指定替代目录'],
    };

    if (suggestions[err.code]) {
      console.error('建议:');
      suggestions[err.code].forEach(s => console.error(`  - ${s}`));
    }

    process.exit(1);
  }

  console.error(`未知错误: ${err}`);
  process.exit(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/unit/utils/errors.test.ts
# Expected: PASS
```

- [ ] **Step 5: Implement paths module**

```typescript
// src/utils/paths.ts
import { join } from 'path';
import { homedir } from 'os';

export const HOME = homedir();
export const CC_LINKER_DIR = process.env.CC_LINKER_DIR ?? join(HOME, '.cc-linker');
export const REGISTRY_PATH = process.env.CC_LINKER_REGISTRY_PATH ?? join(CC_LINKER_DIR, 'registry.json');
export const BACKUP_DIR = join(CC_LINKER_DIR, 'backups');
export const SCAN_CACHE_PATH = join(CC_LINKER_DIR, 'scan_cache.json');
export const HOOK_LOG_PATH = join(CC_LINKER_DIR, 'hook.log');
export const CONFIG_PATH = process.env.CC_LINKER_CONFIG_PATH ?? join(CC_LINKER_DIR, 'config.toml');

export const CC_CONNECT_SESSIONS_DIR = join(HOME, '.cc-connect', 'sessions');
export const CLAUDE_PROJECTS_DIR = join(HOME, '.claude', 'projects');
export const CLAUDE_SETTINGS_PATH = join(HOME, '.claude', 'settings.json');
```

- [ ] **Step 6: Commit**

```bash
git add src/utils/errors.ts src/utils/paths.ts tests/unit/utils/errors.test.ts
git commit -m "feat: add error codes and path constants"
```

---

## Task 3: Utils Layer - Logger and Config

**Files:**
- Create: `src/utils/logger.ts`
- Create: `src/utils/config.ts`
- Create: `tests/unit/utils/config.test.ts`

- [ ] **Step 1: Implement logger**

```typescript
// src/utils/logger.ts
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { CC_LINKER_DIR, HOOK_LOG_PATH } from './paths';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: LogLevel = 'info';

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private format(level: LogLevel, message: string): string {
    return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  }

  debug(message: string): void {
    if (this.shouldLog('debug')) {
      console.debug(this.format('debug', message));
    }
  }

  info(message: string): void {
    if (this.shouldLog('info')) {
      console.log(this.format('info', message));
    }
  }

  warn(message: string): void {
    if (this.shouldLog('warn')) {
      console.warn(this.format('warn', message));
    }
  }

  error(message: string): void {
    if (this.shouldLog('error')) {
      console.error(this.format('error', message));
    }
  }

  hook(level: LogLevel, message: string): void {
    try {
      mkdirSync(dirname(HOOK_LOG_PATH), { recursive: true });
      appendFileSync(HOOK_LOG_PATH, this.format(level, message) + '\n');
    } catch {
      // Silently fail for hook logging
    }
  }
}

export const logger = new Logger();
```

- [ ] **Step 2: Write failing test for config**

```typescript
// tests/unit/utils/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ConfigManager } from '../../../src/utils/config';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ConfigManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cc-linker-config-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads default config when no file exists', () => {
    const config = new ConfigManager(join(tmpDir, 'nonexistent.toml'));
    expect(config.get('bridge.api_url', '')).toBe('http://localhost:9810');
  });

  it('loads config from TOML file', () => {
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(configPath, '[bridge]\napi_url = "http://custom:9999"');

    const config = new ConfigManager(configPath);
    expect(config.get('bridge.api_url', '')).toBe('http://custom:9999');
  });

  it('returns fallback for missing keys', () => {
    const config = new ConfigManager(join(tmpDir, 'nonexistent.toml'));
    expect(config.get('nonexistent.key', 'fallback')).toBe('fallback');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/unit/utils/config.test.ts
# Expected: FAIL - module not found
```

- [ ] **Step 4: Implement config manager**

```typescript
// src/utils/config.ts
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse } from '@iarna/toml';
import { CONFIG_PATH } from './paths';

interface ConfigData {
  general: {
    registry_path: string;
    log_level: string;
    log_path: string | null;
  };
  scanner: {
    max_file_size: number;
    incremental: boolean;
  };
  bridge: {
    api_url: string;
    token: string;
    timeout: number;
    restart_delay: number;
  };
  hook: {
    log_path: string;
    timeout: number;
  };
}

const DEFAULTS: ConfigData = {
  general: {
    registry_path: '~/.cc-linker/registry.json',
    log_level: 'info',
    log_path: null,
  },
  scanner: {
    max_file_size: 100 * 1024 * 1024,
    incremental: true,
  },
  bridge: {
    api_url: 'http://localhost:9810',
    token: '',
    timeout: 30,
    restart_delay: 5,
  },
  hook: {
    log_path: '~/.cc-linker/hook.log',
    timeout: 10,
  },
};

export class ConfigManager {
  private data: ConfigData;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? CONFIG_PATH;
    this.data = { ...DEFAULTS };

    if (existsSync(this.configPath)) {
      try {
        const fileData = parse(readFileSync(this.configPath, 'utf8'));
        this.merge(fileData);
      } catch (err) {
        console.warn(`配置文件解析失败: ${err}`);
      }
    }

    this.loadEnv();
  }

  private merge(data: any): void {
    for (const [section, values] of Object.entries(data)) {
      if (this.data[section as keyof ConfigData] && typeof values === 'object') {
        Object.assign(this.data[section as keyof ConfigData], values);
      }
    }
  }

  private loadEnv(): void {
    const mappings: [string, keyof ConfigData, string][] = [
      ['CC_LINKER_REGISTRY_PATH', 'general', 'registry_path'],
      ['CC_LINKER_LOG_LEVEL', 'general', 'log_level'],
      ['CC_LINKER_TOKEN', 'bridge', 'token'],
      ['CC_LINKER_API_URL', 'bridge', 'api_url'],
    ];

    for (const [envKey, section, key] of mappings) {
      const value = process.env[envKey];
      if (value) {
        (this.data[section] as any)[key] = value;
      }
    }
  }

  get<T>(path: string, fallback: T): T {
    const parts = path.split('.');
    let current: any = this.data;
    for (const part of parts) {
      if (current == null) return fallback;
      current = current[part];
    }
    return current ?? fallback;
  }
}

export const config = new ConfigManager();
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/unit/utils/config.test.ts
# Expected: PASS
```

- [ ] **Step 6: Commit**

```bash
git add src/utils/logger.ts src/utils/config.ts tests/unit/utils/config.test.ts
git commit -m "feat: add logger and TOML config loader"
```

---

## Task 4: Utils Layer - File Lock

**Files:**
- Create: `src/utils/lock.ts`
- Create: `tests/unit/utils/lock.test.ts`

- [ ] **Step 1: Write failing test for file lock**

```typescript
// tests/unit/utils/lock.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { withLock } from '../../../src/utils/lock';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('withLock', () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cc-linker-lock-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    testFile = join(tmpDir, 'test.json');
    writeFileSync(testFile, '{"value": 0}');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('executes function and returns result', async () => {
    const result = await withLock(testFile, async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it('allows atomic write during lock', async () => {
    await withLock(testFile, async () => {
      const tmp = testFile + '.tmp';
      writeFileSync(tmp, '{"value": 1}');
      const { renameSync } = await import('fs');
      renameSync(tmp, testFile);
    });

    const content = JSON.parse(readFileSync(testFile, 'utf8'));
    expect(content.value).toBe(1);
  });

  it('cleans up lock after error', async () => {
    try {
      await withLock(testFile, async () => {
        throw new Error('test error');
      });
    } catch {}

    // Should be able to acquire lock again
    const result = await withLock(testFile, async () => 'success');
    expect(result).toBe('success');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/utils/lock.test.ts
# Expected: FAIL - module not found
```

- [ ] **Step 3: Implement file lock wrapper**

```typescript
// src/utils/lock.ts
import lockfile from 'proper-lockfile';
import { existsSync } from 'fs';
import { CCLinkerError } from './errors';
import { logger } from './logger';

interface LockOptions {
  retries?: number;
  minTimeout?: number;
}

export async function withLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const { retries = 3, minTimeout = 100 } = options;

  // Ensure file exists for lockfile
  if (!existsSync(filePath)) {
    const { writeFileSync } = await import('fs');
    writeFileSync(filePath, '');
  }

  let release: (() => Promise<void>) | null = null;

  try {
    release = await lockfile.lock(filePath, {
      retries: {
        retries,
        factor: 1.5,
        minTimeout,
      },
      lockfilePath: filePath + '.lock',
    });

    return await fn();
  } catch (err: any) {
    if (err.code === 'ELOCKED') {
      throw new CCLinkerError('E007', '注册表被锁，等待超时');
    }
    throw err;
  } finally {
    if (release) {
      try {
        await release();
      } catch (err) {
        logger.warn(`释放锁失败: ${err}`);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/unit/utils/lock.test.ts
# Expected: PASS
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/lock.ts tests/unit/utils/lock.test.ts
git commit -m "feat: add file lock wrapper with proper-lockfile"
```

---

## Task 5: Registry Layer - Types

**Files:**
- Create: `src/registry/types.ts`
- Create: `src/registry/index.ts`

- [ ] **Step 1: Define Zod schemas and types**

```typescript
// src/registry/types.ts
import { z } from 'zod';

export const OriginSchema = z.enum(['cli', 'cc-connect']);
export type Origin = z.infer<typeof OriginSchema>;

export const StatusSchema = z.enum(['active', 'archived', 'corrupted']);
export type Status = z.infer<typeof StatusSchema>;

export const VisibilitySchema = z.enum(['private', 'team', 'public']);
export type Visibility = z.infer<typeof VisibilitySchema>;

export const SessionEntrySchema = z.object({
  origin: OriginSchema,
  source: z.string(),
  platform: z.string().nullable(),
  owner: z.string().nullable(),
  owner_user_key: z.string().nullable(),

  cwd: z.string(),
  project_name: z.string().nullable(),
  jsonl_path: z.string(),
  project_dir: z.string().nullable(),

  cc_connect_session_id: z.string().nullable(),
  cc_connect_session_file: z.string().nullable(),

  created_at: z.string(),
  last_active: z.string(),

  title: z.string().nullable(),
  message_count: z.number(),
  last_message_preview: z.string(),
  status: StatusSchema,

  visibility: VisibilitySchema.optional(),
  shared_with: z.array(z.string()).optional(),
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;

export const RegistrySchema = z.object({
  version: z.literal(1),
  updated_at: z.string(),
  sessions: z.record(z.string(), SessionEntrySchema),
});
export type Registry = z.infer<typeof RegistrySchema>;

export const CCConnectSessionSchema = z.object({
  sessions: z.record(z.string(), z.object({
    id: z.string(),
    name: z.string(),
    agent_session_id: z.string(),
    agent_type: z.string(),
    history: z.array(z.object({
      role: z.string(),
      content: z.string(),
      timestamp: z.string(),
    })).nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })),
  active_session: z.record(z.string(), z.string()),
  user_sessions: z.record(z.string(), z.array(z.string())),
  counter: z.number(),
  user_meta: z.record(z.string(), z.object({
    user_name: z.string(),
    chat_name: z.string(),
  })).optional(),
});
export type CCConnectSession = z.infer<typeof CCConnectSessionSchema>;
```

- [ ] **Step 2: Create index file**

```typescript
// src/registry/index.ts
export * from './types';
export { RegistryManager } from './registry';
```

- [ ] **Step 3: Commit**

```bash
git add src/registry/types.ts src/registry/index.ts
git commit -m "feat: add registry type definitions with Zod schemas"
```

---

## Task 6: Registry Layer - Registry Manager

**Files:**
- Create: `src/registry/registry.ts`
- Create: `tests/unit/registry.test.ts`

- [ ] **Step 1: Write failing test for registry CRUD**

```typescript
// tests/unit/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { RegistryManager } from '../../src/registry';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('RegistryManager', () => {
  let tmpDir: string;
  let registry: RegistryManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-linker-registry-test-'));
    registry = new RegistryManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates empty registry on init', () => {
    expect(registry.sessions).toEqual({});
    expect(existsSync(join(tmpDir, 'registry.json'))).toBe(true);
  });

  it('upsert creates new session', async () => {
    await registry.upsert('test-uuid-1', {
      origin: 'cli',
      source: 'terminal',
      cwd: '/test',
      title: 'Test Session',
    });

    expect(registry.has('test-uuid-1')).toBe(true);
    expect(registry.get('test-uuid-1')?.title).toBe('Test Session');
    expect(registry.get('test-uuid-1')?.origin).toBe('cli');
  });

  it('upsert updates existing session', async () => {
    await registry.upsert('test-uuid-1', { title: 'Original' });
    await registry.upsert('test-uuid-1', { title: 'Updated' });

    expect(registry.get('test-uuid-1')?.title).toBe('Updated');
  });

  it('findByPrefix finds unique match', async () => {
    await registry.upsert('b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec', { title: 'Test' });

    const match = registry.findByPrefix('b21d6d04');
    expect(match).not.toBeNull();
    expect(match![0]).toBe('b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec');
  });

  it('findByPrefix throws E006 on multiple matches', async () => {
    await registry.upsert('b21d6d04-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { title: 'A' });
    await registry.upsert('b21d6d04-bbbb-bbbb-bbbb-bbbbbbbbbbbb', { title: 'B' });

    expect(() => registry.findByPrefix('b21d6d04')).toThrow('E006');
  });

  it('findByPrefix returns null for no match', async () => {
    expect(registry.findByPrefix('nonexistent')).toBeNull();
  });

  it('remove deletes session', async () => {
    await registry.upsert('test-uuid-1', { title: 'Test' });
    await registry.remove('test-uuid-1');

    expect(registry.has('test-uuid-1')).toBe(false);
  });

  it('creates backup on save', async () => {
    await registry.upsert('test-uuid-1', { title: 'Test' });

    const backupDir = join(tmpDir, 'backups');
    expect(existsSync(backupDir)).toBe(true);

    const backups = readdirSync(backupDir).filter(f => f.startsWith('registry.'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('keeps max 3 backups', async () => {
    for (let i = 0; i < 5; i++) {
      await registry.upsert(`uuid-${i}`, { title: `Session ${i}` });
    }

    const backupDir = join(tmpDir, 'backups');
    const backups = readdirSync(backupDir).filter(f => f.startsWith('registry.'));
    expect(backups.length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/unit/registry.test.ts
# Expected: FAIL - module not found
```

- [ ] **Step 3: Implement RegistryManager**

```typescript
// src/registry/registry.ts
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, unlinkSync, symlinkSync } from 'fs';
import { join } from 'path';
import { RegistrySchema, type Registry, type SessionEntry } from './types';
import { withLock } from '../utils/lock';
import { logger } from '../utils/logger';
import { CCLinkerError } from '../utils/errors';

const MAX_BACKUPS = 3;

export class RegistryManager {
  private data: Registry;
  private basePath: string;
  private registryPath: string;
  private backupDir: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? join(process.env.HOME ?? '~', '.cc-linker');
    this.registryPath = join(this.basePath, 'registry.json');
    this.backupDir = join(this.basePath, 'backups');

    this.ensureDir();
    this.data = this.load();
  }

  private ensureDir(): void {
    mkdirSync(this.basePath, { recursive: true, mode: 0o700 });
    mkdirSync(this.backupDir, { recursive: true });
  }

  private load(): Registry {
    if (!existsSync(this.registryPath)) {
      return this.createEmpty();
    }

    try {
      const raw = readFileSync(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      return RegistrySchema.parse(parsed);
    } catch (err) {
      logger.warn('Registry 损坏，尝试从备份恢复...');
      return this.restoreFromBackup() ?? this.createEmpty();
    }
  }

  private createEmpty(): Registry {
    const empty: Registry = {
      version: 1,
      updated_at: new Date().toISOString(),
      sessions: {},
    };
    this.saveSync(empty);
    return empty;
  }

  private saveSync(data: Registry): void {
    data.updated_at = new Date().toISOString();
    const tmp = this.registryPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.registryPath);
    this.data = data;
  }

  async save(data?: Registry): Promise<void> {
    const toSave = data ?? this.data;
    await withLock(this.registryPath, async () => {
      this.rotateBackup();
      this.saveSync(toSave);
    });
  }

  get sessions(): Record<string, SessionEntry> {
    return this.data.sessions;
  }

  has(uuid: string): boolean {
    return uuid in this.data.sessions;
  }

  get(uuid: string): SessionEntry | undefined {
    return this.data.sessions[uuid];
  }

  findByPrefix(prefix: string): [string, SessionEntry] | null {
    const matches = Object.entries(this.data.sessions)
      .filter(([uuid]) => uuid.startsWith(prefix));

    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];

    throw new CCLinkerError('E006', `前缀 "${prefix}" 匹配到 ${matches.length} 个会话，请输入更长的前缀`);
  }

  async upsert(uuid: string, entry: Partial<SessionEntry>): Promise<void> {
    const existing = this.data.sessions[uuid];

    if (existing) {
      Object.assign(existing, {
        ...entry,
        last_active: entry.last_active ?? new Date().toISOString(),
      });
    } else {
      this.data.sessions[uuid] = {
        origin: 'cli',
        source: 'terminal',
        platform: null,
        owner: null,
        owner_user_key: null,
        cwd: '',
        project_name: null,
        jsonl_path: '',
        project_dir: null,
        cc_connect_session_id: null,
        cc_connect_session_file: null,
        created_at: new Date().toISOString(),
        last_active: new Date().toISOString(),
        title: null,
        message_count: 0,
        last_message_preview: '',
        status: 'active',
        ...entry,
      };
    }

    await this.save();
  }

  async remove(uuid: string): Promise<void> {
    delete this.data.sessions[uuid];
    await this.save();
  }

  private rotateBackup(): void {
    const backups = readdirSync(this.backupDir)
      .filter(f => f.startsWith('registry.') && f.endsWith('.json'))
      .sort();

    while (backups.length >= MAX_BACKUPS) {
      const oldest = backups.shift()!;
      unlinkSync(join(this.backupDir, oldest));
    }

    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const backupPath = join(this.backupDir, `registry.${timestamp}.json`);
    writeFileSync(backupPath, JSON.stringify(this.data, null, 2));

    const bakPath = this.registryPath + '.bak';
    if (existsSync(bakPath)) unlinkSync(bakPath);
    symlinkSync(backupPath, bakPath);
  }

  private restoreFromBackup(): Registry | null {
    const bakPath = this.registryPath + '.bak';
    if (!existsSync(bakPath)) return null;

    try {
      const raw = readFileSync(bakPath, 'utf8');
      return RegistrySchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/unit/registry.test.ts
# Expected: PASS
```

- [ ] **Step 5: Commit**

```bash
git add src/registry/registry.ts tests/unit/registry.test.ts
git commit -m "feat: implement RegistryManager with CRUD, locking, and backup"
```

---

## Task 7: Scanner Layer - Cache Manager

**Files:**
- Create: `src/scanner/cache.ts`

- [ ] **Step 1: Implement mtime cache**

```typescript
// src/scanner/cache.ts
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { SCAN_CACHE_PATH } from '../utils/paths';

export type FileCache = Map<string, number>;

export function loadCache(cachePath?: string): FileCache {
  const path = cachePath ?? SCAN_CACHE_PATH;
  if (!existsSync(path)) return new Map();

  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return new Map(Object.entries(data).map(([k, v]) => [k, v as number]));
  } catch {
    return new Map();
  }
}

export function saveCache(cache: FileCache, cachePath?: string): void {
  const path = cachePath ?? SCAN_CACHE_PATH;
  const obj = Object.fromEntries(cache);
  writeFileSync(path, JSON.stringify(obj, null, 2));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/scanner/cache.ts
git commit -m "feat: add mtime cache manager for incremental scanning"
```

---

## Task 8: Scanner Layer - cc-connect Scanner

**Files:**
- Create: `src/scanner/cc-connect.ts`
- Create: `tests/unit/scanner/cc-connect.test.ts`
- Create: `tests/fixtures/cc-connect-session.json`

- [ ] **Step 1: Create test fixture**

```json
// tests/fixtures/cc-connect-session.json
{
  "sessions": {
    "s1": {
      "id": "s1",
      "name": "default",
      "agent_session_id": "028037a3-a7c1-4d07-85c1-28b31af19284",
      "agent_type": "claudecode",
      "history": [
        {"role": "user", "content": "hi", "timestamp": "2026-05-03T16:55:23.287294+08:00"},
        {"role": "assistant", "content": "你好！", "timestamp": "2026-05-03T16:55:38.176008+08:00"}
      ],
      "created_at": "2026-05-03T16:55:23.275844+08:00",
      "updated_at": "2026-05-03T16:55:23.275844+08:00"
    },
    "s2": {
      "id": "s2",
      "name": "default",
      "agent_session_id": "b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec",
      "agent_type": "claudecode",
      "history": null,
      "created_at": "2026-05-03T17:17:32.418541+08:00",
      "updated_at": "2026-05-03T17:52:52.117522+08:00"
    }
  },
  "active_session": {
    "feishu:oc_xxx:ou_user1": "s1",
    "feishu:oc_xxx:ou_user2": "s2"
  },
  "user_sessions": {
    "feishu:oc_xxx:ou_user1": ["s1"],
    "feishu:oc_xxx:ou_user2": ["s2"]
  },
  "counter": 2
}
```

- [ ] **Step 2: Write failing test for cc-connect scanner**

```typescript
// tests/unit/scanner/cc-connect.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { CCConnectScanner } from '../../../src/scanner/cc-connect';
import { RegistryManager } from '../../../src/registry';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('CCConnectScanner', () => {
  let tmpDir: string;
  let registry: RegistryManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-connect-scanner-test-'));
    registry = new RegistryManager(tmpDir);

    // Create mock cc-connect sessions directory
    const sessionsDir = join(tmpDir, '.cc-connect', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    copyFileSync(
      join(__dirname, '../fixtures/cc-connect-session.json'),
      join(sessionsDir, 'claude-code-feishu_test.json')
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scans cc-connect sessions and returns UUIDs', () => {
    const scanner = new CCConnectScanner(registry, join(tmpDir, '.cc-connect'));
    const { uuids, sids } = scanner.scan();

    expect(uuids.size).toBe(2);
    expect(uuids.has('028037a3-a7c1-4d07-85c1-28b31af19284')).toBe(true);
    expect(uuids.has('b21d6d04-d4bf-42aa-9a8d-c87dc16ae5ec')).toBe(true);
    expect(sids.size).toBe(2);
  });

  it('registers sessions in registry', async () => {
    const scanner = new CCConnectScanner(registry, join(tmpDir, '.cc-connect'));
    scanner.scan();

    expect(registry.has('028037a3-a7c1-4d07-85c1-28b31af19284')).toBe(true);
    const entry = registry.get('028037a3-a7c1-4d07-85c1-28b31af19284');
    expect(entry?.origin).toBe('cc-connect');
    expect(entry?.cc_connect_session_id).toBe('s1');
    expect(entry?.platform).toBe('feishu');
  });

  it('detects platform from filename', () => {
    const scanner = new CCConnectScanner(registry, join(tmpDir, '.cc-connect'));
    scanner.scan();

    const entry = registry.get('028037a3-a7c1-4d07-85c1-28b31af19284');
    expect(entry?.platform).toBe('feishu');
  });

  it('returns empty sets when directory does not exist', () => {
    const scanner = new CCConnectScanner(registry, '/nonexistent');
    const { uuids, sids } = scanner.scan();

    expect(uuids.size).toBe(0);
    expect(sids.size).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/unit/scanner/cc-connect.test.ts
# Expected: FAIL - module not found
```

- [ ] **Step 4: Implement cc-connect scanner**

```typescript
// src/scanner/cc-connect.ts
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { CCConnectSessionSchema, type CCConnectSession } from '../registry/types';
import type { RegistryManager } from '../registry/registry';
import { logger } from '../utils/logger';

export class CCConnectScanner {
  private registry: RegistryManager;
  private sessionsDir: string;

  constructor(registry: RegistryManager, ccConnectDir?: string) {
    this.registry = registry;
    this.sessionsDir = join(ccConnectDir ?? homedir(), '.cc-connect', 'sessions');
  }

  scan(): { uuids: Set<string>; sids: Set<string> } {
    if (!existsSync(this.sessionsDir)) {
      return { uuids: new Set(), sids: new Set() };
    }

    const uuids = new Set<string>();
    const sids = new Set<string>();

    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = join(this.sessionsDir, file);
        const raw = readFileSync(filePath, 'utf8');
        const data = CCConnectSessionSchema.parse(JSON.parse(raw));
        const platform = this.detectPlatform(file);

        const sidToUser = new Map<string, string>();
        for (const [userKey, userSids] of Object.entries(data.user_sessions ?? {})) {
          for (const sid of userSids) {
            sidToUser.set(sid, userKey);
          }
        }
        for (const [userKey, sid] of Object.entries(data.active_session ?? {})) {
          if (!sidToUser.has(sid)) sidToUser.set(sid, userKey);
        }

        for (const [sid, session] of Object.entries(data.sessions ?? {})) {
          const agentId = session.agent_session_id;
          if (!agentId) continue;

          uuids.add(agentId);
          sids.add(sid);

          const userKey = sidToUser.get(sid) ?? null;

          this.registry.upsert(agentId, {
            origin: 'cc-connect',
            source: userKey ?? sid,
            platform,
            owner: this.publicOwner(userKey),
            owner_user_key: userKey,
            cc_connect_session_id: sid,
            cc_connect_session_file: filePath,
          });
        }
      } catch (err) {
        logger.warn(`解析 cc-connect session 文件失败: ${file}: ${err}`);
      }
    }

    this.cleanStaleMappings(sids);

    return { uuids, sids };
  }

  private cleanStaleMappings(activeSids: Set<string>): void {
    for (const entry of Object.values(this.registry.sessions)) {
      if (entry.cc_connect_session_id && !activeSids.has(entry.cc_connect_session_id)) {
        entry.cc_connect_session_id = null;
        entry.cc_connect_session_file = null;
      }
    }
  }

  private detectPlatform(filename: string): string | null {
    for (const p of ['feishu', 'weixin', 'dingtalk', 'slack']) {
      if (filename.toLowerCase().includes(p)) return p;
    }
    return null;
  }

  private publicOwner(userKey: string | null): string | null {
    if (!userKey) return null;
    const parts = userKey.split(':');
    return parts.length >= 3 ? `${parts[0]}:${parts[parts.length - 1]}` : userKey;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/unit/scanner/cc-connect.test.ts
# Expected: PASS
```

- [ ] **Step 6: Commit**

```bash
git add src/scanner/cc-connect.ts tests/unit/scanner/cc-connect.test.ts tests/fixtures/cc-connect-session.json
git commit -m "feat: implement cc-connect session scanner"
```

---

## Task 9: Scanner Layer - JSONL Scanner

**Files:**
- Create: `src/scanner/jsonl.ts`
- Create: `tests/unit/scanner/jsonl.test.ts`
- Create: `tests/fixtures/sample.jsonl`

- [ ] **Step 1: Create test fixture**

```jsonl
{"type":"attachment","entrypoint":"sdk-cli","cwd":"/Users/test/project","sessionId":"test-session-1234","timestamp":"2026-05-03T09:00:00Z"}
{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"hi"},"uuid":"uuid-1","timestamp":"2026-05-03T09:01:00Z","entrypoint":"sdk-cli","cwd":"/Users/test/project","sessionId":"test-session-1234"}
{"parentUuid":"uuid-1","isSidechain":false,"message":{"role":"assistant","content":[{"type":"text","text":"Hello! How can I help?"}]},"type":"assistant","uuid":"uuid-2","timestamp":"2026-05-03T09:01:05Z","sessionId":"test-session-1234"}
{"type":"ai-title","aiTitle":"Test Project Setup","sessionId":"test-session-1234"}
{"type":"last-prompt","lastPrompt":"Help me set up the project","leafUuid":"uuid-2","sessionId":"test-session-1234"}
```

- [ ] **Step 2: Write failing test for JSONL scanner**

```typescript
// tests/unit/scanner/jsonl.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { JSONLScanner } from '../../../src/scanner/jsonl';
import { RegistryManager } from '../../../src/registry';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('JSONLScanner', () => {
  let tmpDir: string;
  let registry: RegistryManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-scanner-test-'));
    registry = new RegistryManager(tmpDir);

    // Create mock Claude projects directory
    const projectDir = join(tmpDir, '.claude', 'projects', '-Users-test-project');
    mkdirSync(projectDir, { recursive: true });
    copyFileSync(
      join(__dirname, '../fixtures/sample.jsonl'),
      join(projectDir, 'test-session-1234.jsonl')
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scans JSONL files and registers sessions', () => {
    const scanner = new JSONLScanner(
      registry,
      new Set(),
      new Map(),
      join(tmpDir, '.claude')
    );
    scanner.scan();

    expect(registry.has('test-session-1234')).toBe(true);
    const entry = registry.get('test-session-1234');
    expect(entry?.origin).toBe('cli');
    expect(entry?.title).toBe('Test Project Setup');
    expect(entry?.cwd).toBe('/Users/test/project');
    expect(entry?.message_count).toBeGreaterThan(0);
  });

  it('detects cc-connect origin from entrypoint', () => {
    const scanner = new JSONLScanner(
      registry,
      new Set(['test-session-1234']),
      new Map(),
      join(tmpDir, '.claude')
    );
    scanner.scan();

    const entry = registry.get('test-session-1234');
    expect(entry?.origin).toBe('cc-connect');
  });

  it('skips unchanged files on incremental scan', () => {
    const cache = new Map<string, number>();
    const scanner = new JSONLScanner(
      registry,
      new Set(),
      cache,
      join(tmpDir, '.claude')
    );

    // First scan
    scanner.scan();
    expect(registry.has('test-session-1234')).toBe(true);

    // Second scan with cache
    const scanner2 = new JSONLScanner(
      registry,
      new Set(),
      cache,
      join(tmpDir, '.claude')
    );
    scanner2.scan();

    // Should still have the entry
    expect(registry.has('test-session-1234')).toBe(true);
  });

  it('returns empty when directory does not exist', () => {
    const scanner = new JSONLScanner(
      registry,
      new Set(),
      new Map(),
      '/nonexistent'
    );
    scanner.scan();

    expect(Object.keys(registry.sessions).length).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/unit/scanner/jsonl.test.ts
# Expected: FAIL - module not found
```

- [ ] **Step 4: Implement JSONL scanner**

```typescript
// src/scanner/jsonl.ts
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { RegistryManager, SessionEntry, Origin } from '../registry';
import type { FileCache } from './cache';
import { logger } from '../utils/logger';

export class JSONLScanner {
  private registry: RegistryManager;
  private ccConnectUuids: Set<string>;
  private fileCache: FileCache;
  private claudeDir: string;

  constructor(
    registry: RegistryManager,
    ccConnectUuids: Set<string>,
    fileCache: FileCache,
    claudeDir?: string
  ) {
    this.registry = registry;
    this.ccConnectUuids = ccConnectUuids;
    this.fileCache = fileCache;
    this.claudeDir = claudeDir ?? join(homedir(), '.claude');
  }

  scan(): void {
    const projectsDir = join(this.claudeDir, 'projects');
    if (!existsSync(projectsDir)) return;

    for (const projectDir of readdirSync(projectsDir)) {
      const fullPath = join(projectsDir, projectDir);
      try {
        if (!statSync(fullPath).isDirectory()) continue;
      } catch {
        continue;
      }

      for (const file of readdirSync(fullPath)) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = join(fullPath, file);
        const sessionId = file.replace('.jsonl', '');

        try {
          const stat = statSync(filePath);
          const mtime = stat.mtimeMs;

          const cachedMtime = this.fileCache.get(filePath);
          if (cachedMtime && mtime <= cachedMtime) continue;

          if (!this.registry.has(sessionId)) {
            const meta = this.parseFull(filePath, sessionId);
            this.registry.upsert(sessionId, {
              ...meta,
              jsonl_path: filePath,
              source: 'terminal',
            });
          } else {
            const meta = this.parseTail(filePath);
            this.registry.upsert(sessionId, meta);
          }

          this.fileCache.set(filePath, mtime);
        } catch (err) {
          logger.warn(`解析 JSONL 文件失败: ${filePath}: ${err}`);
        }
      }
    }
  }

  private parseFull(filePath: string, sessionId: string): Partial<SessionEntry> {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);

    let entrypoint: string | null = null;
    let cwd: string | null = null;
    let aiTitle: string | null = null;
    let lastPrompt: string | null = null;

    for (let i = 0; i < Math.min(lines.length, 20); i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (!entrypoint && entry.entrypoint) entrypoint = entry.entrypoint;
        if (!cwd && entry.cwd) cwd = entry.cwd;
        if (entry.type === 'ai-title' && !aiTitle) aiTitle = entry.aiTitle;
        if (entry.type === 'last-prompt' && !lastPrompt) lastPrompt = entry.lastPrompt;
      } catch {}
    }

    let lastActive: string | null = null;
    let preview = '';
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if ((entry.type === 'assistant' || entry.type === 'user') && !lastActive) {
          lastActive = entry.timestamp;
        }
        if (entry.type === 'assistant' && !preview) {
          const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
          if (textBlock) preview = textBlock.text.slice(0, 100);
        }
      } catch {}
    }

    const origin: Origin = this.ccConnectUuids.has(sessionId)
      ? 'cc-connect'
      : entrypoint === 'sdk-cli'
        ? 'cc-connect'
        : 'cli';

    const title = aiTitle
      ?? (lastPrompt ? lastPrompt.slice(0, 50) + (lastPrompt.length > 50 ? '...' : '') : null)
      ?? `Untitled (${sessionId.slice(0, 8)})`;

    return {
      origin,
      cwd: cwd ?? homedir(),
      project_name: this.inferProjectName(cwd ?? homedir()),
      title,
      message_count: lines.length,
      last_active: lastActive ?? new Date().toISOString(),
      last_message_preview: preview || lastPrompt?.slice(0, 100) || '[无内容]',
      status: 'active',
    };
  }

  private parseTail(filePath: string): Partial<SessionEntry> {
    const stat = statSync(filePath);
    const readSize = Math.min(4096, stat.size);
    const fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, stat.size - readSize);
    closeSync(fd);

    const tail = buffer.toString('utf8');
    const lines = tail.split('\n').filter(Boolean).slice(-10);

    let lastActive: string | null = null;
    let preview = '';

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'assistant' || entry.type === 'user') {
          if (!lastActive) lastActive = entry.timestamp;
        }
        if (entry.type === 'assistant' && !preview) {
          const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
          if (textBlock) preview = textBlock.text.slice(0, 100);
        }
      } catch {}
    }

    return {
      last_active: lastActive ?? undefined,
      last_message_preview: preview || undefined,
      message_count: readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length,
    };
  }

  private inferProjectName(cwd: string): string | null {
    if (!cwd || cwd === homedir()) return 'Home';

    const { basename } = require('path');
    return basename(cwd);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/unit/scanner/jsonl.test.ts
# Expected: PASS
```

- [ ] **Step 6: Commit**

```bash
git add src/scanner/jsonl.ts tests/unit/scanner/jsonl.test.ts tests/fixtures/sample.jsonl
git commit -m "feat: implement JSONL file scanner with incremental scanning"
```

---

## Task 10: Scanner Layer - Unified Entry

**Files:**
- Create: `src/scanner/index.ts`

- [ ] **Step 1: Implement unified sync entry**

```typescript
// src/scanner/index.ts
import { RegistryManager } from '../registry';
import { CCConnectScanner } from './cc-connect';
import { JSONLScanner } from './jsonl';
import { loadCache, saveCache, type FileCache } from './cache';
import { SCAN_CACHE_PATH } from '../utils/paths';
import { logger } from '../utils/logger';

export async function syncBeforeCommand(
  registry: RegistryManager,
  cachePath?: string,
  claudeDir?: string
): Promise<void> {
  const path = cachePath ?? SCAN_CACHE_PATH;
  const cache = loadCache(path);

  logger.debug('开始同步扫描...');

  // Step 1: Scan cc-connect sessions
  const ccScanner = new CCConnectScanner(registry);
  const { uuids } = ccScanner.scan();
  logger.debug(`cc-connect 扫描完成: ${uuids.size} 个会话`);

  // Step 2: Scan JSONL files
  const jsonlScanner = new JSONLScanner(registry, uuids, cache, claudeDir);
  jsonlScanner.scan();
  logger.debug(`JSONL 扫描完成`);

  // Save cache
  saveCache(cache, path);
}

export { CCConnectScanner } from './cc-connect';
export { JSONLScanner } from './jsonl';
export { loadCache, saveCache } from './cache';
```

- [ ] **Step 2: Commit**

```bash
git add src/scanner/index.ts
git commit -m "feat: add unified scanner entry point"
```

---

## Task 11: CLI Layer - Output Formatting

**Files:**
- Create: `src/cli/output.ts`

- [ ] **Step 1: Implement output formatting**

```typescript
// src/cli/output.ts
import Table from 'cli-table3';
import chalk from 'chalk';
import type { SessionEntry } from '../registry';

export function formatTimeAgo(isoDate: string): string {
  const now = new Date();
  const date = new Date(isoDate);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return '刚刚';
  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 30) return `${diffDays} 天前`;
  return date.toLocaleDateString('zh-CN');
}

export function formatOrigin(origin: string): string {
  return origin === 'cc-connect' ? '🟢 飞书' : '💻 终端';
}

export function formatTable(sessions: Array<[string, SessionEntry]>): string {
  const table = new Table({
    head: ['Ref', '标题', '来源', '项目', '消息', '最后活跃'],
    colWidths: [10, 30, 10, 15, 8, 15],
  });

  for (const [uuid, s] of sessions) {
    table.push([
      uuid.slice(0, 8),
      s.title?.slice(0, 28) ?? 'Untitled',
      formatOrigin(s.origin),
      s.project_name?.slice(0, 13) ?? '?',
      s.message_count.toString(),
      formatTimeAgo(s.last_active),
    ]);
  }

  return table.toString();
}

export function formatJson(sessions: Array<[string, SessionEntry]>): string {
  return JSON.stringify(
    sessions.map(([uuid, s]) => ({
      ref: uuid.slice(0, 8),
      uuid,
      title: s.title,
      origin: s.origin,
      platform: s.platform,
      project_name: s.project_name,
      cwd: s.cwd,
      message_count: s.message_count,
      last_active: s.last_active,
    })),
    null,
    2
  );
}

export function formatCsv(sessions: Array<[string, SessionEntry]>): string {
  const header = 'ref,uuid,title,origin,platform,project_name,cwd,message_count,last_active';
  const rows = sessions.map(([uuid, s]) =>
    `${uuid.slice(0, 8)},${uuid},"${(s.title ?? '').replace(/"/g, '""')}",${s.origin},${s.platform ?? ''},${s.project_name ?? ''},${s.cwd},${s.message_count},${s.last_active}`
  );
  return [header, ...rows].join('\n');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/output.ts
git commit -m "feat: add table/JSON/CSV output formatting"
```

---

## Task 12: CLI Commands - Init and List

**Files:**
- Create: `src/cli/commands/init.ts`
- Create: `src/cli/commands/list.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement init command**

```typescript
// src/cli/commands/init.ts
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { syncBeforeCommand } from '../../scanner';

export async function init(registry: RegistryManager): Promise<void> {
  console.log(chalk.green('✅ Created ~/.cc-linker/registry.json'));

  console.log(chalk.blue('🔍 Scanning for existing sessions...'));
  await syncBeforeCommand(registry);

  const sessions = Object.values(registry.sessions);
  const ccConnect = sessions.filter(s => s.origin === 'cc-connect').length;
  const cli = sessions.filter(s => s.origin === 'cli').length;

  console.log(`   Found ${ccConnect} cc-connect sessions`);
  console.log(`   Found ${cli} Claude Code sessions`);
  console.log(chalk.green(`✅ Registered ${sessions.length} sessions total`));

  console.log('\nNext steps:');
  console.log('  1. Run \'cc-linker hook install\' to install Claude Code hook');
  console.log('  2. Run \'cc-linker list\' to view all sessions');
  console.log('  3. Run \'cc-linker resume\' to resume a session');
}
```

- [ ] **Step 2: Implement list command**

```typescript
// src/cli/commands/list.ts
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { formatTable, formatJson, formatCsv, formatTimeAgo, formatOrigin } from '../output';

interface ListOptions {
  project?: string;
  platform?: string;
  origin?: string;
  active?: boolean;
  format?: string;
  limit?: string;
  sort?: string;
}

export async function list(registry: RegistryManager, opts: ListOptions): Promise<void> {
  let sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => s.status === 'active');

  // Apply filters
  if (opts.project) {
    sessions = sessions.filter(([_, s]) => s.project_name?.includes(opts.project!));
  }
  if (opts.platform) {
    sessions = sessions.filter(([_, s]) => s.platform === opts.platform);
  }
  if (opts.origin) {
    sessions = sessions.filter(([_, s]) => s.origin === opts.origin);
  }
  if (opts.active) {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    sessions = sessions.filter(([_, s]) => s.last_active > twoHoursAgo);
  }

  // Sort
  const sortField = opts.sort ?? 'last_active';
  sessions.sort((a, b) => {
    if (sortField === 'created_at') return b[1].created_at.localeCompare(a[1].created_at);
    if (sortField === 'message_count') return b[1].message_count - a[1].message_count;
    return b[1].last_active.localeCompare(a[1].last_active);
  });

  // Limit
  const limit = parseInt(opts.limit ?? '20', 10);
  sessions = sessions.slice(0, limit);

  // Output
  const format = opts.format ?? 'table';
  if (format === 'json') {
    console.log(formatJson(sessions));
  } else if (format === 'csv') {
    console.log(formatCsv(sessions));
  } else {
    if (sessions.length === 0) {
      console.log(chalk.yellow('没有找到会话'));
      return;
    }

    console.log(formatTable(sessions));
    console.log(`\n共 ${sessions.length} 个会话。使用 cc-linker resume <Ref> 或完整 UUID 恢复会话。`);
  }
}
```

- [ ] **Step 3: Update CLI entry point with init and list commands**

```typescript
// src/index.ts
#!/usr/bin/env bun
import { Command } from 'commander';
import { RegistryManager } from './registry';
import { syncBeforeCommand } from './scanner';
import { handleError } from './utils/errors';
import { init } from './cli/commands/init';
import { list } from './cli/commands/list';

const program = new Command();

program
  .name('cc-linker')
  .description('cc-connect 与 Claude Code CLI 的会话桥接工具')
  .version('0.1.0');

// Helper to run sync before command
async function withSync(fn: () => Promise<void>, skipSync = false) {
  const registry = new RegistryManager();
  if (!skipSync) {
    await syncBeforeCommand(registry);
  }
  await fn();
}

program
  .command('init')
  .description('初始化 registry 并扫描已有会话')
  .action(() => withSync(async () => {
    const registry = new RegistryManager();
    await init(registry);
  }, true));

program
  .command('list')
  .description('列出所有可恢复的会话')
  .option('-p, --project <name>', '按项目名过滤')
  .option('-P, --platform <name>', '按平台过滤')
  .option('-o, --origin <type>', '按来源过滤')
  .option('-a, --active', '只显示最近 2 小时活跃的会话')
  .option('-f, --format <type>', '输出格式: table/json/csv', 'table')
  .option('-l, --limit <n>', '最多显示 n 条', '20')
  .option('-s, --sort <field>', '排序字段', 'last_active')
  .option('--no-sync', '跳过自动同步')
  .action((opts) => withSync(async () => {
    const registry = new RegistryManager();
    await list(registry, opts);
  }, opts.noSync));

// Parse and handle errors
program.parseAsync(process.argv).catch(handleError);
```

- [ ] **Step 4: Test commands work**

```bash
bun run src/index.ts init
# Expected: Scans and registers sessions

bun run src/index.ts list
# Expected: Shows session table
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init.ts src/cli/commands/list.ts src/index.ts
git commit -m "feat: implement init and list CLI commands"
```

---

## Task 13: CLI Commands - Resume and Show

**Files:**
- Create: `src/cli/commands/resume.ts`
- Create: `src/cli/commands/show.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement resume command**

```typescript
// src/cli/commands/resume.ts
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { chdir } from 'process';
import { RegistryManager } from '../../registry';
import { CCLinkerError } from '../../utils/errors';
import { formatOrigin, formatTimeAgo } from '../output';
import { CLAUDE_PROJECTS_DIR } from '../../utils/paths';

interface ResumeOptions {
  search?: string;
  latest?: boolean;
  project?: string;
  platform?: string;
  dryRun?: boolean;
  noConfirm?: boolean;
}

export async function resume(registry: RegistryManager, target?: string, opts: ResumeOptions = {}): Promise<void> {
  let uuid: string;

  if (opts.latest) {
    uuid = findLatestSession(registry, opts.project, opts.platform);
  } else if (opts.search) {
    uuid = await searchAndSelect(registry, opts.search);
  } else if (target) {
    const match = registry.findByPrefix(target);
    if (!match) throw new CCLinkerError('E002', `未找到匹配 "${target}" 的会话`);
    uuid = match[0];
  } else {
    uuid = await interactiveSelect(registry);
  }

  const entry = registry.get(uuid);
  if (!entry) throw new CCLinkerError('E002', '会话不存在');

  // Verify JSONL exists
  if (!existsSync(entry.jsonl_path)) {
    const found = findJsonlFile(uuid);
    if (found) {
      await registry.upsert(uuid, { jsonl_path: found });
      entry.jsonl_path = found;
    } else {
      throw new CCLinkerError('E002', 'JSONL 文件不存在，会话可能已被清理');
    }
  }

  // CWD check
  const currentDir = process.cwd();
  if (entry.cwd !== currentDir && !opts.noConfirm && !opts.dryRun) {
    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: `此会话在 ${entry.cwd} 中创建，将切换到该目录并恢复。继续？`,
      default: true,
    }]);
    if (!confirmed) return;
  }

  // Execute
  const cmd = `claude --resume ${uuid}`;
  if (opts.dryRun) {
    console.log(chalk.blue(`将执行: cd ${entry.cwd} && ${cmd}`));
    return;
  }

  console.log(chalk.green(`恢复会话: ${entry.title ?? uuid}`));
  chdir(entry.cwd);
  execSync(cmd, { stdio: 'inherit' });
}

function findLatestSession(registry: RegistryManager, project?: string, platform?: string): string {
  let sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => s.status === 'active');

  if (project) {
    sessions = sessions.filter(([_, s]) => s.project_name?.includes(project));
  }
  if (platform) {
    sessions = sessions.filter(([_, s]) => s.platform === platform);
  }

  if (sessions.length === 0) {
    throw new CCLinkerError('E002', '没有找到活跃会话');
  }

  sessions.sort((a, b) => b[1].last_active.localeCompare(a[1].last_active));
  return sessions[0][0];
}

async function searchAndSelect(registry: RegistryManager, query: string): Promise<string> {
  const matches = Object.entries(registry.sessions)
    .filter(([_, s]) => s.title?.toLowerCase().includes(query.toLowerCase()));

  if (matches.length === 0) {
    throw new CCLinkerError('E002', `未找到包含 "${query}" 的会话`);
  }
  if (matches.length === 1) return matches[0][0];

  const { selected } = await inquirer.prompt([{
    type: 'list',
    name: 'selected',
    message: '找到多个匹配，请选择:',
    choices: matches.map(([uuid, s]) => ({
      name: `${uuid.slice(0, 8)}  ${s.title}  (${formatOrigin(s.origin)})`,
      value: uuid,
    })),
  }]);

  return selected;
}

async function interactiveSelect(registry: RegistryManager): Promise<string> {
  const sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => s.status === 'active')
    .sort((a, b) => b[1].last_active.localeCompare(a[1].last_active))
    .slice(0, 20);

  if (sessions.length === 0) {
    throw new CCLinkerError('E002', '没有找到会话');
  }

  const { selected } = await inquirer.prompt([{
    type: 'list',
    name: 'selected',
    message: '选择要恢复的会话:',
    choices: sessions.map(([uuid, s]) => ({
      name: `${uuid.slice(0, 8)}  ${s.title ?? 'Untitled'}  (${formatOrigin(s.origin)}, ${s.project_name ?? '?'}, ${s.message_count}条, ${formatTimeAgo(s.last_active)})`,
      value: uuid,
    })),
  }]);

  return selected;
}

function findJsonlFile(uuid: string): string | null {
  try {
    const projects = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const project of projects) {
      const jsonlPath = join(CLAUDE_PROJECTS_DIR, project, `${uuid}.jsonl`);
      if (existsSync(jsonlPath)) return jsonlPath;
    }
  } catch {}
  return null;
}
```

- [ ] **Step 2: Implement show command**

```typescript
// src/cli/commands/show.ts
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { CCLinkerError } from '../../utils/errors';
import { formatOrigin, formatTimeAgo } from '../output';

export async function show(registry: RegistryManager, target: string): Promise<void> {
  const match = registry.findByPrefix(target);
  if (!match) {
    throw new CCLinkerError('E002', `未找到匹配 "${target}" 的会话`);
  }

  const [uuid, s] = match;

  console.log(chalk.bold('会话详情'));
  console.log('─'.repeat(40));
  console.log(`UUID:        ${uuid}`);
  console.log(`标题:        ${s.title ?? 'Untitled'}`);
  console.log(`来源:        ${formatOrigin(s.origin)} (${s.source})`);
  console.log(`项目:        ${s.project_name ?? '?'}`);
  console.log(`工作目录:    ${s.cwd}`);
  console.log(`状态:        ${s.status}`);
  console.log(`创建时间:    ${new Date(s.created_at).toLocaleString('zh-CN')}`);
  console.log(`最后活跃:    ${formatTimeAgo(s.last_active)}`);
  console.log(`消息数:      ${s.message_count}`);
  console.log(`\nJSONL 文件: ${s.jsonl_path}`);
  console.log(`\n操作:`);
  console.log(`  cc-linker resume ${uuid.slice(0, 8)}   恢复此会话`);
}
```

- [ ] **Step 3: Update CLI entry point**

```typescript
// src/index.ts - add resume and show commands
import { resume } from './cli/commands/resume';
import { show } from './cli/commands/show';

// ... existing code ...

program
  .command('resume [target]')
  .description('恢复指定会话到 Claude Code CLI')
  .option('-s, --search <query>', '按标题搜索')
  .option('-L, --latest', '恢复最近活跃的会话')
  .option('-p, --project <name>', '指定项目')
  .option('-n, --dry-run', '只显示命令，不执行')
  .option('--no-confirm', '跳过 CWD 变更提示')
  .option('--no-sync', '跳过自动同步')
  .action((target, opts) => withSync(async () => {
    const registry = new RegistryManager();
    await resume(registry, target, opts);
  }, opts.noSync));

program
  .command('show <target>')
  .description('查看会话详情')
  .option('--no-sync', '跳过自动同步')
  .action((target, opts) => withSync(async () => {
    const registry = new RegistryManager();
    await show(registry, target);
  }, opts.noSync));
```

- [ ] **Step 4: Test commands work**

```bash
bun run src/index.ts list
# Pick a UUID prefix

bun run src/index.ts show <prefix>
# Expected: Shows session details

bun run src/index.ts resume <prefix> --dry-run
# Expected: Shows command to execute
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/resume.ts src/cli/commands/show.ts src/index.ts
git commit -m "feat: implement resume and show CLI commands"
```

---

## Task 14: CLI Commands - Sync and Status

**Files:**
- Create: `src/cli/commands/sync.ts`
- Create: `src/cli/commands/status.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement sync command**

```typescript
// src/cli/commands/sync.ts
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { syncBeforeCommand } from '../../scanner';
import { existsSync } from 'fs';

interface SyncOptions {
  scan?: boolean;
  force?: boolean;
  clean?: boolean;
}

export async function sync(registry: RegistryManager, opts: SyncOptions): Promise<void> {
  console.log(chalk.blue('🔄 Syncing sessions...'));

  if (opts.clean) {
    let cleaned = 0;
    for (const [uuid, entry] of Object.entries(registry.sessions)) {
      if (!existsSync(entry.jsonl_path) && entry.origin === 'cli') {
        await registry.remove(uuid);
        cleaned++;
      }
    }
    console.log(`   Cleaned ${cleaned} invalid sessions`);
  }

  if (!opts.scan) {
    await syncBeforeCommand(registry);
  }

  const sessions = Object.values(registry.sessions);
  const ccConnect = sessions.filter(s => s.origin === 'cc-connect').length;
  const cli = sessions.filter(s => s.origin === 'cli').length;

  console.log(chalk.green(`✅ Sync complete. Total registered: ${sessions.length}`));
  console.log(`   From CLI: ${cli}`);
  console.log(`   From cc-connect: ${ccConnect}`);
}
```

- [ ] **Step 2: Implement status command**

```typescript
// src/cli/commands/status.ts
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { formatTimeAgo } from '../output';
import { existsSync, statSync } from 'fs';
import { REGISTRY_PATH } from '../../utils/paths';

export async function status(registry: RegistryManager): Promise<void> {
  const sessions = Object.values(registry.sessions);
  const active = sessions.filter(s => s.status === 'active').length;
  const archived = sessions.filter(s => s.status === 'archived').length;
  const fromCli = sessions.filter(s => s.origin === 'cli').length;
  const fromCcConnect = sessions.filter(s => s.origin === 'cc-connect').length;

  console.log(chalk.bold('cc-linker Status'));
  console.log('─'.repeat(40));
  console.log(`Registry:      ${REGISTRY_PATH}`);

  if (existsSync(REGISTRY_PATH)) {
    const stat = statSync(REGISTRY_PATH);
    console.log(`Last modified: ${formatTimeAgo(stat.mtime.toISOString())}`);
  }

  console.log(`Total sessions: ${sessions.length}`);
  console.log(`  From CLI:       ${fromCli}`);
  console.log(`  From cc-connect: ${fromCcConnect}`);
  console.log(`  Active:         ${active}`);
  console.log(`  Archived:       ${archived}`);
}
```

- [ ] **Step 3: Update CLI entry point**

```typescript
// src/index.ts - add sync and status commands
import { sync } from './cli/commands/sync';
import { status } from './cli/commands/status';

// ... existing code ...

program
  .command('sync')
  .description('手动同步会话')
  .option('--scan', '只扫描不更新')
  .option('--force', '强制刷新')
  .option('--clean', '清理无效记录')
  .action((opts) => withSync(async () => {
    const registry = new RegistryManager();
    await sync(registry, opts);
  }));

program
  .command('status')
  .description('查看桥接工具状态')
  .option('--no-sync', '跳过自动同步')
  .action((opts) => withSync(async () => {
    const registry = new RegistryManager();
    await status(registry);
  }, opts.noSync));
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/sync.ts src/cli/commands/status.ts src/index.ts
git commit -m "feat: implement sync and status CLI commands"
```

---

## Task 15: Hook Mechanism

**Files:**
- Create: `src/hook/session-start.ts`
- Create: `src/cli/commands/hook.ts`
- Create: `src/cli/commands/register.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement hook session-start**

```typescript
// src/hook/session-start.ts
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { execSync } from 'child_process';
import { HOOK_LOG_PATH } from '../utils/paths';

export function hookSessionStart(): void {
  try {
    const sessionId = detectSessionId();
    if (!sessionId) {
      logHook('WARN', '无法获取 session ID，跳过注册');
      return;
    }

    const cwd = process.env.PWD || process.cwd();

    execSync(`cc-linker register "${sessionId}" --origin cli --cwd "${cwd}" --source terminal`, {
      stdio: 'pipe',
      timeout: 5000,
    });

    logHook('INFO', `已注册会话 ${sessionId} (cwd: ${cwd})`);
  } catch (err: any) {
    logHook('ERROR', `Hook 执行失败: ${err.message}`);
  }
}

function detectSessionId(): string | null {
  const candidates = [
    'CLAUDE_CODE_SESSION_ID',
    'SESSION_ID',
    'CLAUDE_SESSION_ID',
  ];

  for (const name of candidates) {
    const value = process.env[name];
    if (value && isValidUUID(value)) {
      return value;
    }
  }

  return null;
}

function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function logHook(level: string, message: string): void {
  try {
    mkdirSync(dirname(HOOK_LOG_PATH), { recursive: true });
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    appendFileSync(HOOK_LOG_PATH, line);
  } catch {
    // Silently fail
  }
}
```

- [ ] **Step 2: Implement hook commands**

```typescript
// src/cli/commands/hook.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { dirname } from 'path';
import chalk from 'chalk';
import { CLAUDE_SETTINGS_PATH, HOOK_LOG_PATH } from '../../utils/paths';

export function hookInstall(): void {
  let settings: any = {};
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  }

  if (settings.hooks?.SessionStart?.includes('cc-linker')) {
    console.log(chalk.green('✅ Hook 已安装'));
    return;
  }

  settings.hooks = settings.hooks ?? {};
  settings.hooks.SessionStart = 'cc-linker hook session-start';

  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));

  console.log(chalk.green('✅ Hook 安装成功'));
  console.log(`已添加到 ${CLAUDE_SETTINGS_PATH}:`);
  console.log('  "hooks": { "SessionStart": "cc-linker hook session-start" }');
}

export function hookUninstall(): void {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) {
    console.log(chalk.yellow('未找到 settings.json'));
    return;
  }

  const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  if (settings.hooks?.SessionStart?.includes('cc-linker')) {
    delete settings.hooks.SessionStart;
    writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log(chalk.green('✅ Hook 已卸载'));
  } else {
    console.log(chalk.yellow('Hook 未安装'));
  }
}

export function hookStatus(): void {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) {
    console.log(chalk.red('❌ 未找到 settings.json'));
    return;
  }

  const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  const installed = settings.hooks?.SessionStart?.includes('cc-linker');

  console.log(`Hook 状态: ${installed ? chalk.green('✅ 已安装') : chalk.red('❌ 未安装')}`);

  if (existsSync(HOOK_LOG_PATH)) {
    const logs = readFileSync(HOOK_LOG_PATH, 'utf8').split('\n').filter(Boolean);
    const recent = logs.slice(-5);
    console.log('\n最近日志:');
    recent.forEach(l => console.log(`  ${l}`));
  }
}
```

- [ ] **Step 3: Implement register command**

```typescript
// src/cli/commands/register.ts
import { RegistryManager } from '../../registry';

interface RegisterOptions {
  origin?: string;
  cwd?: string;
  source?: string;
}

export async function registerSession(
  registry: RegistryManager,
  uuid: string,
  opts: RegisterOptions = {}
): Promise<void> {
  await registry.upsert(uuid, {
    origin: (opts.origin as any) ?? 'cli',
    source: opts.source ?? 'terminal',
    cwd: opts.cwd ?? process.cwd(),
  });
}
```

- [ ] **Step 4: Update CLI entry point**

```typescript
// src/index.ts - add hook and register commands
import { hookInstall, hookUninstall, hookStatus, hookSessionStart } from './cli/commands/hook';
import { registerSession } from './cli/commands/register';

// ... existing code ...

const hookCmd = program.command('hook').description('管理 Claude Code 钩子');
hookCmd.command('install').action(() => hookInstall());
hookCmd.command('uninstall').action(() => hookUninstall());
hookCmd.command('status').action(() => hookStatus());
hookCmd.command('session-start').action(() => hookSessionStart());

program
  .command('register <uuid>')
  .description('注册会话到 registry（内部命令）')
  .option('-o, --origin <type>', '来源', 'cli')
  .option('-c, --cwd <path>', '工作目录')
  .option('--source <id>', '来源标识', 'terminal')
  .action((uuid, opts) => withSync(async () => {
    const registry = new RegistryManager();
    await registerSession(registry, uuid, opts);
  }, true));
```

- [ ] **Step 5: Commit**

```bash
git add src/hook/session-start.ts src/cli/commands/hook.ts src/cli/commands/register.ts src/index.ts
git commit -m "feat: implement SessionStart hook and register command"
```

---

## Task 16: Feishu Commands

**Files:**
- Create: `src/cli/commands/feishu-cmd.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement feishu-cmd**

```typescript
// src/cli/commands/feishu-cmd.ts
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { CCLinkerError } from '../../utils/errors';
import { formatTimeAgo, formatOrigin } from '../output';

interface FeishuCmdOptions {
  caller?: string;
}

export function feishuCmd(
  registry: RegistryManager,
  subcommand: string,
  args: string[],
  opts: FeishuCmdOptions
): void {
  switch (subcommand) {
    case 'list':
      feishuList(registry, opts.caller);
      break;
    case 'switch':
      feishuSwitch(registry, opts.caller, args[0]);
      break;
    case 'resume':
      feishuResume(registry, args[0]);
      break;
    case 'status':
      feishuStatus(registry);
      break;
    default:
      console.error(`未知子命令: ${subcommand}`);
      process.exit(1);
  }
}

function feishuList(registry: RegistryManager, caller?: string): void {
  if (!caller) {
    console.error('错误: 缺少调用者身份，请检查 cc-connect [[commands]] 配置');
    process.exit(1);
  }

  let sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => s.status === 'active');

  if (!caller.startsWith('terminal:')) {
    sessions = sessions.filter(([_, s]) =>
      s.origin === 'cli' ||
      s.owner_user_key === caller ||
      s.owner === normalizeOwner(caller) ||
      s.visibility === 'public' ||
      (s.shared_with ?? []).includes(caller)
    );
  }

  sessions.sort((a, b) => b[1].last_active.localeCompare(a[1].last_active));

  const lines: string[] = [`📋 我的会话（共 ${sessions.length} 个）\n`];

  for (const [uuid, s] of sessions.slice(0, 20)) {
    const ref = uuid.slice(0, 8);
    const icon = s.origin === 'cc-connect' ? '🟢 飞书' : '💻 终端';
    const timeAgo = formatTimeAgo(s.last_active);

    lines.push(`\`${ref}\` ${s.title ?? 'Untitled'}`);
    lines.push(`   💬 ${s.message_count} 条消息 | 🕒 ${timeAgo}`);
    lines.push(`   📂 ${s.project_name ?? '?'} | ${icon}`);
    lines.push(`   最后: "${s.last_message_preview.slice(0, 30)}..."`);
    lines.push('');
  }

  lines.push('回复 /bridge switch <Ref> 切换到此会话');
  lines.push('回复 /bridge resume <Ref> 在终端恢复此会话');

  console.log(lines.join('\n'));
}

function feishuSwitch(registry: RegistryManager, caller: string | undefined, target: string): void {
  if (!target) {
    console.error('用法: /bridge switch <UUID或短前缀>');
    process.exit(1);
  }

  const match = registry.findByPrefix(target);
  if (!match) {
    console.error(`未找到匹配 "${target}" 的会话`);
    process.exit(1);
  }

  const [uuid, entry] = match;

  if (entry.cc_connect_session_id) {
    console.log(`✅ 已切换到「${entry.title}」(${entry.message_count} 条消息)`);
    console.log(`💻 此会话来自终端，包含完整的开发历史`);
    console.log(`⚡ 无需重启，已即时生效`);
    return;
  }

  console.log(`⚠️ 此会话来自终端，尚未映射到 cc-connect`);
  console.log(`首次切换需要创建映射并重启 cc-connect，可能中断其他用户的会话。`);
  console.log(`\n请在终端执行以下命令手动映射：`);
  console.log(`\n  cc-linker resume ${uuid.slice(0, 8)}\n`);
  console.log(`后续版本将支持自动映射。`);
}

function feishuResume(registry: RegistryManager, target: string): void {
  const match = registry.findByPrefix(target);
  if (!match) {
    console.error(`未找到匹配 "${target}" 的会话`);
    process.exit(1);
  }

  const [uuid] = match;
  console.log(`📱 请在终端执行以下命令恢复此会话：\n`);
  console.log(`  cc-linker resume ${uuid.slice(0, 8)}\n`);
  console.log(`或直接运行：`);
  console.log(`  claude --resume ${uuid}`);
}

function feishuStatus(registry: RegistryManager): void {
  const sessions = Object.values(registry.sessions);
  const active = sessions.filter(s => s.status === 'active').length;
  const fromCli = sessions.filter(s => s.origin === 'cli').length;
  const fromCcConnect = sessions.filter(s => s.origin === 'cc-connect').length;

  console.log(`🔗 cc-linker 状态`);
  console.log(`注册会话: ${sessions.length}`);
  console.log(`来源: ${fromCli} 个来自终端，${fromCcConnect} 个来自飞书`);
  console.log(`活跃: ${active}`);
}

function normalizeOwner(caller: string): string {
  const parts = caller.split(':');
  return parts.length >= 3 ? `${parts[0]}:${parts[parts.length - 1]}` : caller;
}
```

- [ ] **Step 2: Update CLI entry point**

```typescript
// src/index.ts - add feishu-cmd
import { feishuCmd } from './cli/commands/feishu-cmd';

// ... existing code ...

program
  .command('feishu-cmd <subcommand> [args...]')
  .description('飞书侧 /bridge 命令入口')
  .option('--caller <user>', '调用者标识')
  .action((subcommand, args, opts) => withSync(async () => {
    const registry = new RegistryManager();
    feishuCmd(registry, subcommand, args, opts);
  }));
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/feishu-cmd.ts src/index.ts
git commit -m "feat: implement feishu-cmd for /bridge commands"
```

---

## Task 17: Advanced Commands - Export, Search, Clean

**Files:**
- Create: `src/cli/commands/export.ts`
- Create: `src/cli/commands/search.ts`
- Create: `src/cli/commands/clean.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement export command**

```typescript
// src/cli/commands/export.ts
import { readFileSync, writeFileSync } from 'fs';
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { CCLinkerError } from '../../utils/errors';

interface ExportOptions {
  format?: string;
  output?: string;
  includeThinking?: boolean;
  includeTools?: boolean;
  maxMessages?: string;
}

export async function exportSession(
  registry: RegistryManager,
  target: string,
  opts: ExportOptions = {}
): Promise<void> {
  const match = registry.findByPrefix(target);
  if (!match) {
    throw new CCLinkerError('E002', `未找到匹配 "${target}" 的会话`);
  }

  const [uuid, entry] = match;
  const format = opts.format ?? 'markdown';
  const outputFile = opts.output ?? `./export-${uuid.slice(0, 8)}.${format === 'markdown' ? 'md' : format}`;
  const maxMessages = opts.maxMessages ? parseInt(opts.maxMessages, 10) : undefined;

  console.log(chalk.blue(`导出会话: ${entry.title ?? uuid}`));

  const content = readFileSync(entry.jsonl_path, 'utf8');
  const lines = content.split('\n').filter(Boolean);

  const messages: string[] = [];
  let count = 0;

  for (const line of lines) {
    if (maxMessages && count >= maxMessages) break;

    try {
      const item = JSON.parse(line);

      if (item.type === 'user' || item.type === 'assistant') {
        count++;
        const time = new Date(item.timestamp).toLocaleTimeString('zh-CN');
        const role = item.type === 'user' ? 'User' : 'Assistant';

        let text = '';
        if (item.type === 'user') {
          text = typeof item.message?.content === 'string'
            ? item.message.content
            : item.message?.content?.[0]?.text ?? '';
        } else {
          const textBlock = item.message?.content?.find((b: any) => b.type === 'text');
          text = textBlock?.text ?? '';
        }

        if (format === 'markdown') {
          messages.push(`**${role}** (${time}): ${text}\n`);
        } else {
          messages.push(`[${time}] ${role}: ${text}\n`);
        }
      }
    } catch {}
  }

  const output = format === 'markdown'
    ? `# ${entry.title ?? 'Untitled'}\n\n> Session: ${uuid}\n> Source: ${entry.origin}\n> Messages: ${count}\n\n---\n\n${messages.join('\n')}`
    : messages.join('\n');

  writeFileSync(outputFile, output);
  console.log(chalk.green(`✅ 导出完成: ${outputFile} (${count} 条消息)`));
}
```

- [ ] **Step 2: Implement search command**

```typescript
// src/cli/commands/search.ts
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { formatTable } from '../output';

interface SearchOptions {
  inTitle?: boolean;
  inContent?: boolean;
}

export async function search(
  registry: RegistryManager,
  query: string,
  opts: SearchOptions = {}
): Promise<void> {
  const lowerQuery = query.toLowerCase();

  let matches = Object.entries(registry.sessions)
    .filter(([_, s]) => {
      if (opts.inTitle) {
        return s.title?.toLowerCase().includes(lowerQuery);
      }
      return s.title?.toLowerCase().includes(lowerQuery) ||
        s.last_message_preview.toLowerCase().includes(lowerQuery);
    });

  if (matches.length === 0) {
    console.log(chalk.yellow(`未找到包含 "${query}" 的会话`));
    return;
  }

  console.log(`找到 ${matches.length} 个匹配:\n`);
  console.log(formatTable(matches));
}
```

- [ ] **Step 3: Implement clean command**

```typescript
// src/cli/commands/clean.ts
import chalk from 'chalk';
import { existsSync } from 'fs';
import { RegistryManager } from '../../registry';

interface CleanOptions {
  dryRun?: boolean;
  olderThan?: string;
}

export async function clean(registry: RegistryManager, opts: CleanOptions = {}): Promise<void> {
  const olderThanDays = opts.olderThan ? parseInt(opts.olderThan, 10) : undefined;
  const cutoff = olderThanDays
    ? new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const toClean: string[] = [];

  for (const [uuid, entry] of Object.entries(registry.sessions)) {
    // Clean if JSONL doesn't exist
    if (!existsSync(entry.jsonl_path)) {
      toClean.push(uuid);
      continue;
    }

    // Clean if older than threshold
    if (cutoff && entry.last_active < cutoff) {
      toClean.push(uuid);
    }
  }

  if (toClean.length === 0) {
    console.log(chalk.green('没有需要清理的会话'));
    return;
  }

  console.log(`将清理 ${toClean.length} 个会话:`);
  for (const uuid of toClean) {
    const entry = registry.get(uuid);
    console.log(`  - ${uuid.slice(0, 8)}  ${entry?.title ?? 'Untitled'}`);
  }

  if (opts.dryRun) {
    console.log(chalk.yellow('\n（dry run，未实际删除）'));
    return;
  }

  for (const uuid of toClean) {
    await registry.remove(uuid);
  }

  console.log(chalk.green(`\n✅ 已清理 ${toClean.length} 个会话`));
}
```

- [ ] **Step 4: Update CLI entry point**

```typescript
// src/index.ts - add export, search, clean commands
import { exportSession } from './cli/commands/export';
import { search } from './cli/commands/search';
import { clean } from './cli/commands/clean';

// ... existing code ...

program
  .command('export <target>')
  .description('导出会话为 markdown/text/json')
  .option('-f, --format <type>', '输出格式', 'markdown')
  .option('-o, --output <path>', '输出文件')
  .option('--max-messages <n>', '最大消息数')
  .option('--no-sync', '跳过自动同步')
  .action((target, opts) => withSync(async () => {
    const registry = new RegistryManager();
    await exportSession(registry, target, opts);
  }, opts.noSync));

program
  .command('search <query>')
  .description('搜索会话')
  .option('--in-title', '只搜索标题')
  .option('--no-sync', '跳过自动同步')
  .action((query, opts) => withSync(async () => {
    const registry = new RegistryManager();
    await search(registry, query, opts);
  }, opts.noSync));

program
  .command('clean')
  .description('清理无效记录')
  .option('--dry-run', '预览')
  .option('--older-than <days>', '清理 N 天前的')
  .option('--no-sync', '跳过自动同步')
  .action((opts) => withSync(async () => {
    const registry = new RegistryManager();
    await clean(registry, opts);
  }, opts.noSync));
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/export.ts src/cli/commands/search.ts src/cli/commands/clean.ts src/index.ts
git commit -m "feat: implement export, search, and clean commands"
```

---

## Task 18: Integration Tests

**Files:**
- Create: `tests/integration/cli-commands.test.ts`

- [ ] **Step 1: Write integration tests**

```typescript
// tests/integration/cli-commands.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

describe('CLI Commands Integration', () => {
  let tmpDir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-linker-integration-'));
    env = {
      ...process.env,
      CC_LINKER_DIR: tmpDir,
      HOME: tmpDir,
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(args: string): string {
    try {
      return execSync(`bun run src/index.ts ${args}`, {
        cwd: '/Users/wuyujun/Git/cc-linker',
        env,
        encoding: 'utf8',
      });
    } catch (err: any) {
      return err.stdout || err.stderr || err.message;
    }
  }

  it('init creates registry', () => {
    const output = run('init');
    expect(output).toContain('Created');
    expect(output).toContain('Scanning');
  });

  it('list shows sessions after init', () => {
    run('init');
    const output = run('list');
    expect(output).toContain('会话');
  });

  it('status shows registry info', () => {
    run('init');
    const output = run('status');
    expect(output).toContain('cc-linker Status');
    expect(output).toContain('Total sessions');
  });

  it('sync updates registry', () => {
    run('init');
    const output = run('sync');
    expect(output).toContain('Sync complete');
  });
});
```

- [ ] **Step 2: Run integration tests**

```bash
bun test tests/integration/cli-commands.test.ts
# Expected: PASS
```

- [ ] **Step 3: Commit**

```bash
git add tests/integration/cli-commands.test.ts
git commit -m "test: add integration tests for CLI commands"
```

---

## Task 19: Final Cleanup and Documentation

**Files:**
- Modify: `README.md`
- Create: `LICENSE`

- [ ] **Step 1: Update README with installation and usage**

Add to README.md:

```markdown
## Installation

```bash
# From npm (when published)
npm install -g cc-linker

# From source
git clone https://github.com/xxx/cc-linker.git
cd cc-linker
bun install
bun run build
```

## Quick Start

```bash
# Initialize
cc-linker init

# List sessions
cc-linker list

# Resume a session
cc-linker resume <prefix>

# Install hook for auto-registration
cc-linker hook install
```

## Feishu Integration

Add to cc-connect config.toml:

```toml
[[commands]]
name = "bridge"
description = "Cross-platform session management"
exec = "cc-linker feishu-cmd --caller {{user}} {{args}}"
```

Then use in Feishu:
- `/bridge list` - List all sessions
- `/bridge switch <ref>` - Switch to session
- `/bridge resume <ref>` - Get resume command
```

- [ ] **Step 2: Run full test suite**

```bash
bun test
# Expected: All tests pass
```

- [ ] **Step 3: Type check**

```bash
bun run typecheck
# Expected: No errors
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "docs: update README with installation and usage guide"
```

---

## Self-Review Checklist

- [x] All spec sections covered by tasks
- [x] No placeholders (TBD, TODO, etc.)
- [x] Type/method names consistent across tasks
- [x] Each task produces working, testable code
- [x] TDD approach: test first, then implement
- [x] Bite-sized steps (2-5 minutes each)
- [x] Exact file paths and code provided
- [x] Commit messages follow conventional format

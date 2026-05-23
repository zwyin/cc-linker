# cc-linker 自建方案 Phase 1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Version:** v1.1
> **Goal:** 将 cc-linker 从 cc-connect 方案迁移到自建飞书 Bot 方案，6 轮递进实现，每轮可独立验证。

**Architecture:** 单进程架构，内部通过 import 直接调用模块。Feishu Bot（WSClient）+ Session Manager（Claude 进程管理）+ Spool Queue（可靠消息队列）+ Runtime Coordinator（运行态单写者）。

**Tech Stack:** Bun runtime, Commander CLI, @larksuiteoapi/node-sdk, Zod v4, TOML config, proper-lockfile

**执行说明：**
- 文中的文件删除和提交步骤表达的是操作意图，不要求必须使用文中的 shell 命令逐字执行
- `git commit` 为建议性的阶段性提交点；若工作区不干净或当前改动不适合独立提交，应按实际情况调整

---

## 文件地图

### 第 1 轮：基础设施重构（本轮计划详述）

**删除**：
- `src/scanner/cc-connect.ts` + `tests/unit/scanner/cc-connect.test.ts`
- `src/bridge/client.ts` + `tests/unit/bridge/client.test.ts`
- `src/cli/commands/feishu-cmd.ts`

**修改**：
- `src/registry/types.ts` — 移除 cc-connect 字段，新增自建方案字段
- `src/registry/registry.ts` — 更新 `buildSessionEntry()` 匹配新类型
- `src/utils/config.ts` — 移除 `[bridge]`，新增 `[feishu_bot]`/`[runtime]`/`[security]`/`[queue]`/`[cli_proxy]`
- `src/utils/paths.ts` — 新增自建方案路径常量
- `src/utils/errors.ts` — 新增 Phase 1 错误码
- `src/scanner/index.ts` — 移除 cc-connect 扫描
- `src/scanner/jsonl.ts` — 移除 `ccConnectUuids` 参数
- `src/hook/session-start.ts` — 改为写 session-events
- `src/cli/commands/resume.ts` — 新增状态语义，移除 cc-connect 逻辑
- `src/cli/commands/init.ts` — 更新输出文案
- `src/cli/commands/sync.ts` — 移除 cc-connect 引用
- `src/cli/commands/clean.ts` — 移除 cc-connect 逻辑
- `src/cli/commands/status.ts` — 更新展示
- `src/cli/commands/register.ts` — 适配新类型
- `src/index.ts` — 移除 feishu-cmd 注册
- `src/cli/output.ts` — 按需要调整

### 第 2 轮+：新模块（概要描述）

| 轮次 | 新文件 |
|------|--------|
| 2 | `src/proxy/session.ts` |
| 3 | `src/feishu/mapping.ts`, `src/feishu/list-snapshot.ts` |
| 4 | `src/queue/spool.ts`, `src/feishu/bot.ts`, `src/cli/commands/start.ts` |
| 5 | `src/runtime/state-coordinator.ts`, `src/runtime/reconciler.ts` |
| 6 | 测试文件 + 故障注入脚本 |

---

# 第 1 轮：基础设施重构

> **目标**：清理 cc-connect 残留，建立新类型系统，确保纯 CLI 命令可用。
> **原则**：每步 TDD，频繁提交，`bun test` 全绿后进入下一步。

### Task 1.1: 删除 cc-connect 模块

**Files:**
- Delete: `src/scanner/cc-connect.ts`
- Delete: `src/bridge/client.ts`
- Delete: `src/cli/commands/feishu-cmd.ts`
- Delete: `tests/unit/scanner/cc-connect.test.ts`
- Delete: `tests/unit/bridge/client.test.ts`
- Delete: `tests/fixtures/cc-connect-session.json`
- Delete: `tests/unit/scanner/source-override.test.ts`（测试 cc-connect origin 覆盖逻辑，已无意义）

- [ ] **Step 1: 删除文件**

通过 IDE / 安全文件工具删除以下文件：
- `src/scanner/cc-connect.ts`
- `src/bridge/client.ts`
- `src/cli/commands/feishu-cmd.ts`
- `tests/unit/scanner/cc-connect.test.ts`
- `tests/unit/bridge/client.test.ts`
- `tests/fixtures/cc-connect-session.json`
- `tests/unit/scanner/source-override.test.ts`

- [ ] **Step 2: 清理引用（暂不编译，后续 task 处理）**

先删除，然后在后续 task 中逐个修复 import 报错。

- [ ] **Step 3: 阶段性提交（如当前工作区干净且适合提交）**

---

### Task 1.2: 重构 `src/registry/types.ts`

**Files:**
- Modify: `src/registry/types.ts`

**当前类型**（cc-connect 方案）：
- 包含 `source`、`platform`、`owner`、`cc_connect_session_id`、`visibility`、`shared_with` 等字段
- `OriginSchema` = `z.enum(['cli', 'cc-connect'])`
- `StatusSchema` = `z.enum(['active', 'archived', 'corrupted'])`

**新类型**（自建方案）：
- 移除上述字段
- `OriginSchema` = `z.enum(['cli', 'feishu'])`
- `StatusSchema` = `z.enum(['provisioning', 'active', 'archived', 'degraded', 'corrupted'])`
- 新增 `jsonl_path: z.string().nullable()`、`feishu_session_id`、`feishu_user_id`、`last_error` 等

- [ ] **Step 1: 更新类型定义**

覆盖写入 `src/registry/types.ts`：

```typescript
import { z } from 'zod';

export const OriginSchema = z.enum(['cli', 'feishu']);
export type Origin = z.infer<typeof OriginSchema>;

export const StatusSchema = z.enum([
  'provisioning',
  'active',
  'archived',
  'degraded',
  'corrupted',
]);
export type Status = z.infer<typeof StatusSchema>;

export const SessionEntrySchema = z.object({
  origin: OriginSchema,

  cwd: z.string(),
  project_name: z.string().nullable(),
  project_dir: z.string().nullable(),
  jsonl_path: z.string().nullable(),

  created_at: z.string(),
  last_active: z.string(),

  title: z.string().nullable(),
  message_count: z.number(),
  last_message_preview: z.string(),
  status: StatusSchema.optional(),

  // Feishu-specific fields (optional, present when origin='feishu')
  feishu_session_id: z.string().nullable().optional(),
  feishu_user_id: z.string().nullable().optional(),
  last_error: z.string().nullable().optional(),
  pending_jsonl_resolve: z.boolean().optional(),
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;

export const RegistrySchema = z.object({
  version: z.literal(1),
  updated_at: z.string(),
  sessions: z.record(z.string(), SessionEntrySchema),
});
export type Registry = z.infer<typeof RegistrySchema>;
```

> **向后兼容策略**：Zod v4 的 `.parse()` 默认 strip 未知字段，旧 `registry.json` 中的 `source`、`platform` 等字段会被静默丢弃。这是预期行为。

- [ ] **Step 2: 提交**

```bash
git add src/registry/types.ts
git commit -m "refactor: update registry types for self-hosted Feishu bot scheme"
```

---

### Task 1.3: 更新 `src/registry/registry.ts` 的 `buildSessionEntry()`

**Files:**
- Modify: `src/registry/registry.ts`

当前 `buildSessionEntry()` 返回包含 `source`、`platform`、`owner`、`cc_connect_session_id` 等字段的对象。除此之外，还需要同步更新 `merge()` / scanner 集成调用链，移除对 cc-connect scanner 及旧字段的依赖。

- [ ] **Step 1: 更新 buildSessionEntry 方法**

找到 `src/registry/registry.ts` 中的 `buildSessionEntry()` 方法（约 273-294 行），替换为：

```typescript
  private buildSessionEntry(entry: Partial<SessionEntry>): SessionEntry {
    return {
      origin: 'cli',
      cwd: '',
      project_name: null,
      project_dir: null,
      jsonl_path: null,
      created_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
      title: null,
      message_count: 0,
      last_message_preview: '',
      status: 'active',
      feishu_session_id: null,
      feishu_user_id: null,
      last_error: null,
      pending_jsonl_resolve: false,
      ...entry,
    };
  }
```

- [ ] **Step 2: 更新 `merge()` / scanner 集成调用链**

检查 `src/registry/registry.ts` 中所有与 scanner 合并结果相关的方法，确保：
- 不再引用 cc-connect scanner 或 `ccConnectUuids`
- 不再读写 `source`、`platform`、`owner`、`cc_connect_session_id`
- 合并时优先保留增强元数据：`origin='feishu'`、`status`、`jsonl_path`、`last_error`
- JSONL 扫描只提供基础会话发现，不单独覆盖飞书来源判定
- [ ] **Step 3: 提交**

```bash
git add src/registry/registry.ts
git commit -m "refactor: update RegistryManager buildSessionEntry for new types"
```

---

### Task 1.4: 重构 `src/utils/config.ts`

**Files:**
- Modify: `src/utils/config.ts`

当前配置有 `[general]`、`[scanner]`、`[bridge]`、`[hook]` 四个段。需要移除 `[bridge]`，新增 `[feishu_bot]`、`[runtime]`、`[security]`、`[queue]`、`[cli_proxy]`。

- [ ] **Step 1: 覆盖写入 `src/utils/config.ts`**

```typescript
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse } from '@iarna/toml';
import { CONFIG_PATH, REGISTRY_PATH } from './paths';

interface ConfigData {
  general: {
    log_level: string;
    log_path: string | null;
    claude_bin: string;
  };
  scanner: {
    max_file_size: number;
    incremental: boolean;
  };
  feishu_bot: {
    app_id: string;
    app_secret: string;
    owner_open_id: string;
    allow_auto_bind_owner: boolean;
    default_cwd: string;
  };
  runtime: {
    owner_lock_path: string;
    session_event_dir: string;
  };
  security: {
    allowed_roots: string[];
    denied_roots: string[];
    confirm_risky_actions: boolean;
  };
  queue: {
    spool_dir: string;
    max_pending: number;
    worker_concurrency: number;
    done_retention_hours: number;
    done_max_files: number;
    failed_retention_days: number;
    failed_max_files: number;
    delivery_retention_days: number;
    list_snapshot_ttl_minutes: number;
  };
  cli_proxy: {
    port: number;
    host: string;
    timeout_ms: number;
  };
  hook: {
    log_path: string;
    timeout: number;
  };
}

function getHome(): string {
  return process.env.HOME ?? homedir();
}

const DEFAULTS: ConfigData = {
  general: {
    log_level: 'info',
    log_path: null,
    claude_bin: 'claude',
  },
  scanner: {
    max_file_size: 100 * 1024 * 1024,
    incremental: true,
  },
  feishu_bot: {
    app_id: '',
    app_secret: '',
    owner_open_id: '',
    allow_auto_bind_owner: false,
    default_cwd: '',
  },
  runtime: {
    owner_lock_path: join(getHome(), '.cc-linker', 'runtime', 'owner.lock'),
    session_event_dir: join(getHome(), '.cc-linker', 'runtime', 'session-events'),
  },
  security: {
    allowed_roots: [],
    denied_roots: ['~', '/', '~/Downloads', '~/Desktop'],
    confirm_risky_actions: true,
  },
  queue: {
    spool_dir: join(getHome(), '.cc-linker', 'spool'),
    max_pending: 100,
    worker_concurrency: 2,
    done_retention_hours: 24,
    done_max_files: 1000,
    failed_retention_days: 7,
    failed_max_files: 200,
    delivery_retention_days: 7,
    list_snapshot_ttl_minutes: 10,
  },
  cli_proxy: {
    port: 9820,
    host: 'localhost',
    timeout_ms: 30 * 60 * 1000,
  },
  hook: {
    log_path: '~/.cc-linker/hook.log',
    timeout: 10,
  },
};

function cloneDefaults(): ConfigData {
  return {
    general: { ...DEFAULTS.general },
    scanner: { ...DEFAULTS.scanner },
    feishu_bot: { ...DEFAULTS.feishu_bot },
    runtime: { ...DEFAULTS.runtime },
    security: { ...DEFAULTS.security },
    queue: { ...DEFAULTS.queue },
    cli_proxy: { ...DEFAULTS.cli_proxy },
    hook: { ...DEFAULTS.hook },
  };
}

export class ConfigManager {
  private data: ConfigData;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? CONFIG_PATH;
    this.data = cloneDefaults();

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
      ['CC_LINKER_LOG_LEVEL', 'general', 'log_level'],
      ['CC_LINKER_LOG_PATH', 'general', 'log_path'],
      ['CC_LINKER_FEISHU_APP_ID', 'feishu_bot', 'app_id'],
      ['CC_LINKER_FEISHU_APP_SECRET', 'feishu_bot', 'app_secret'],
      ['CC_LINKER_FEISHU_OWNER_OPEN_ID', 'feishu_bot', 'owner_open_id'],
      ['CC_LINKER_FEISHU_DEFAULT_CWD', 'feishu_bot', 'default_cwd'],
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

- [ ] **Step 2: 提交**

```bash
git add src/utils/config.ts
git commit -m "refactor: update config for self-hosted Feishu bot (remove bridge, add feishu_bot/runtime/security/queue)"
```

---

### Task 1.5: 重构 `src/utils/paths.ts`

**Files:**
- Modify: `src/utils/paths.ts`

- [ ] **Step 1: 覆盖写入 `src/utils/paths.ts`**

```typescript
import { join } from 'path';
import { homedir } from 'os';

function getHome(): string {
  return process.env.HOME ?? homedir();
}

export const HOME = getHome();
export const CC_LINKER_DIR = process.env.CC_LINKER_DIR ?? join(HOME, '.cc-linker');
export const REGISTRY_PATH = process.env.CC_LINKER_REGISTRY_PATH ?? join(CC_LINKER_DIR, 'registry.json');
export const BACKUP_DIR = join(CC_LINKER_DIR, 'backups');
export const SCAN_CACHE_PATH = join(CC_LINKER_DIR, 'scan_cache.json');
export const HOOK_LOG_PATH = join(CC_LINKER_DIR, 'hook.log');
export const CONFIG_PATH = process.env.CC_LINKER_CONFIG_PATH ?? join(CC_LINKER_DIR, 'config.toml');

// User mapping & list snapshot
export const USER_MAPPING_PATH = join(CC_LINKER_DIR, 'user-mapping.json');
export const LIST_SNAPSHOT_PATH = join(CC_LINKER_DIR, 'list-snapshot.json');

// Runtime
export const RUNTIME_DIR = join(CC_LINKER_DIR, 'runtime');
export const RUNTIME_OWNER_LOCK_PATH = join(RUNTIME_DIR, 'owner.lock');
export const RUNTIME_SESSION_EVENTS_DIR = join(RUNTIME_DIR, 'session-events');

// Spool queue
export const SPOOL_DIR = join(CC_LINKER_DIR, 'spool');
export const SPOOL_PENDING = join(SPOOL_DIR, 'pending');
export const SPOOL_PROCESSING = join(SPOOL_DIR, 'processing');
export const SPOOL_REPLIED = join(SPOOL_DIR, 'replied');
export const SPOOL_DONE = join(SPOOL_DIR, 'done');
export const SPOOL_FAILED = join(SPOOL_DIR, 'failed');
export const SPOOL_RECEIPTS = join(SPOOL_DIR, 'receipts');
export const SPOOL_DELIVERIES = join(SPOOL_DIR, 'deliveries');

// Claude Code
export const CLAUDE_PROJECTS_DIR = join(HOME, '.claude', 'projects');
export const CLAUDE_SETTINGS_PATH = join(HOME, '.claude', 'settings.json');
```

- [ ] **Step 2: 提交**

```bash
git add src/utils/paths.ts
git commit -m "refactor: update paths for self-hosted scheme (add user-mapping, runtime, spool dirs)"
```

---

### Task 1.6: 新增 Phase 1 错误码

**Files:**
- Modify: `src/utils/errors.ts`

- [ ] **Step 1: 更新错误码**

在 `src/utils/errors.ts` 的 `handleError` 函数中，更新 `suggestions` 映射：

```typescript
  const suggestions: Record<string, string[]> = {
    'E001': ['运行 cc-linker init 初始化 registry'],
    'E002': ['会话已被清理或状态异常，无法恢复', '运行 cc-linker sync 重新扫描'],
    'E007': ['等待其他进程完成', '或删除 ~/.cc-linker/registry.json.lock'],
    'E008': ['会话创建目录已被删除，使用 --cwd 指定替代目录'],
    'E010': ['会话处于降级状态，执行 cc-linker start 触发自动修复'],
    'E011': ['会话仍在创建中，请稍后重试'],
    'E012': ['会话已损坏，无法恢复。请使用 /bridge switch 切换到其他会话'],
    'E013': ['服务正在运行，请先执行 cc-linker stop 后再执行此命令'],
  };
```

- [ ] **Step 2: 提交**

```bash
git add src/utils/errors.ts
git commit -m "feat: add Phase 1 error codes (E010-E013)"
```

---

### Task 1.7: 更新 `src/scanner/index.ts`

**Files:**
- Modify: `src/scanner/index.ts`

移除 `CCConnectScanner` 导入和调用。JSONLScanner 不再接收 `ccConnectUuids` 参数。

- [ ] **Step 1: 覆盖写入 `src/scanner/index.ts`**

```typescript
import { RegistryManager } from '../registry';
import { JSONLScanner } from './jsonl';
import { loadCache, saveCache, type FileCache } from './cache';
import { SCAN_CACHE_PATH } from '../utils/paths';
import { logger } from '../utils/logger';

export async function syncBeforeCommand(
  registry: RegistryManager,
  cachePath?: string,
  claudeDir?: string,
  skipFlush = false,
  force = false
): Promise<void> {
  const path = cachePath ?? SCAN_CACHE_PATH;
  const cache = force ? new Map() : loadCache(path);

  logger.debug('开始同步扫描...');

  // Scan JSONL files (synchronous, memory-only)
  const jsonlScanner = new JSONLScanner(registry, cache, claudeDir);
  jsonlScanner.scan();
  logger.debug(`JSONL 扫描完成`);

  // Flush all changes to disk (single lock + backup)
  if (!skipFlush) {
    await registry.flush();
    saveCache(cache, path);
  }
}

export { JSONLScanner } from './jsonl';
export { loadCache, saveCache } from './cache';
```

- [ ] **Step 2: 提交**

```bash
git add src/scanner/index.ts
git commit -m "refactor: remove cc-connect scanner from sync pipeline"
```

---

### Task 1.8: 更新 `src/scanner/jsonl.ts`

**Files:**
- Modify: `src/scanner/jsonl.ts`

移除 `ccConnectUuids` 参数和相关逻辑。**注意**：JSONL 扫描只负责基础会话发现，`origin='feishu'` 属于增强元数据，不能仅基于 `entrypoint` 直接可靠恢复。

- [ ] **Step 1: 更新构造函数**

在 `src/scanner/jsonl.ts` 中，将构造函数从：

```typescript
  constructor(
    registry: RegistryManager,
    ccConnectUuids: Set<string>,
    fileCache: FileCache,
    claudeDir?: string
  ) {
    this.registry = registry;
    this.ccConnectUuids = ccConnectUuids;
    this.fileCache = fileCache;
    this.claudeDir = claudeDir ?? join(process.env.HOME ?? homedir(), '.claude');
  }
```

改为：

```typescript
  constructor(
    registry: RegistryManager,
    fileCache: FileCache,
    claudeDir?: string
  ) {
    this.registry = registry;
    this.fileCache = fileCache;
    this.claudeDir = claudeDir ?? join(process.env.HOME ?? homedir(), '.claude');
  }
```

- [ ] **Step 2: 移除 ccConnectUuids 字段**

删除类中的 `private ccConnectUuids: Set<string>;` 声明。

- [ ] **Step 3: 更新 origin 判定**

在 `parseFull()` 方法中（约 202-204 行），将：

```typescript
    const origin: Origin = entrypoint
      ? (entrypoint === 'sdk-cli' ? 'cc-connect' : 'cli')
      : (this.ccConnectUuids.has(sessionId) ? 'cc-connect' : 'cli');
```

改为：

```typescript
    // Phase 1: JSONL 扫描只提供基础发现能力，不单独推断历史飞书来源
    // 若已有 registry 中存在更强的来源信息（如 origin='feishu'），在 merge 阶段保留
    const origin: Origin = 'cli';
```

- [ ] **Step 4: 更新 detectOriginFromJsonl**

将 `detectOriginFromJsonl()` 方法中（约 136 行）的：

```typescript
            const origin = entry.entrypoint === 'sdk-cli' ? 'cc-connect' : 'cli';
```

改为：

```typescript
            const origin = 'cli';
```

- [ ] **Step 5: 更新 parseFull 中的 source 设置**

在 scan() 方法中，将 `this.registry.upsert()` 调用里的：

```typescript
              ...(meta.origin === 'cli' ? { source: 'terminal' } : {}),
```

改为直接移除（因为新类型中不再有 `source` 字段）。具体修改 scan() 方法中的两处 upsert 调用：

第一处（新会话注册，约 77-83 行）改为：

```typescript
            this.registry.upsert(sessionId, {
              ...meta,
              jsonl_path: filePath,
            });
```

第二处（已有会话更新，约 91-97 行）改为：

```typescript
              this.registry.upsert(sessionId, {
                ...meta,
                jsonl_path: filePath,
              });
```

- [ ] **Step 6: 验证编译通过**

```bash
bun run typecheck
```

预期：无错误（如果还有未修复的引用报错，那是后续 task 要处理的）。

- [ ] **Step 7: 提交**

```bash
git add src/scanner/jsonl.ts
git commit -m "refactor: remove ccConnectUuids from JSONLScanner, update origin detection"
```

---

### Task 1.9: 更新 `src/hook/session-start.ts`

**Files:**
- Modify: `src/hook/session-start.ts`

Hook 不再调用 `cc-linker register` 写 registry，改为写 `runtime/session-events/` 发现事件文件。

- [ ] **Step 1: 覆盖写入 `src/hook/session-start.ts`**

```typescript
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger';
import { isValidUUID } from '../utils/validation';
import { RUNTIME_SESSION_EVENTS_DIR } from '../utils/paths';

export function hookSessionStart(): void {
  try {
    const sessionId = detectSessionId();
    if (!sessionId) {
      logger.hook('warn', '无法获取 session ID，跳过注册');
      return;
    }

    const cwd = process.env.PWD || process.cwd();
    const origin = detectOrigin();

    // 写入 session discovery event 文件（由主进程或 sync 归并）
    writeSessionEvent(sessionId, { origin, cwd });

    logger.hook('info', `已写入 session 发现事件: ${sessionId} (origin: ${origin}, cwd: ${cwd})`);
  } catch (err: any) {
    logger.hook('error', `Hook 执行失败: ${err.message}`);
  }
}

function writeSessionEvent(sessionId: string, meta: { origin: string; cwd: string }): void {
  const dir = RUNTIME_SESSION_EVENTS_DIR;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filename = `${sessionId}.json`;
  const filePath = join(dir, filename);

  // 如果文件已存在，跳过（避免重复写入）
  if (existsSync(filePath)) return;

  const event = {
    session_id: sessionId,
    origin: meta.origin,
    cwd: meta.cwd,
    detected_at: new Date().toISOString(),
  };

  writeFileSync(filePath, JSON.stringify(event), { mode: 0o600 });
}

export function detectSessionId(): string | null {
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

export function detectOrigin(): string {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    ?? process.env.ENTRYPOINT
    ?? process.env.CLAUDE_ENTRYPOINT;
  if (entrypoint === 'sdk-cli') return 'feishu';
  return 'cli';
}
```

- [ ] **Step 2: 更新 `src/cli/commands/hook.ts`**

在 hook.ts 中找到调用 `registerSession` 的部分（如果有），以及 `hookSessionStart` 的调用方式，确认无需更新。由于 `hookSessionStart` 签名未变（仍无参数、返回 void），命令层不需要修改。

- [ ] **Step 3: 提交**

```bash
git add src/hook/session-start.ts
git commit -m "refactor: hook writes session-events instead of calling register command"
```

---

### Task 1.10: 更新 `src/cli/commands/resume.ts`

**Files:**
- Modify: `src/cli/commands/resume.ts`

移除 cc-connect 特有的 reset_on_idle 检测、platform/user 过滤等逻辑。新增状态语义：provisioning/degraded/corrupted 分别处理。

- [ ] **Step 1: 覆盖写入 `src/cli/commands/resume.ts`**

```typescript
import { existsSync } from 'fs';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { CCLinkerError } from '../../utils/errors';
import { formatOrigin, formatTimeAgo } from '../output';
import { RUNTIME_OWNER_LOCK_PATH } from '../../utils/paths';
import { config } from '../../utils/config';

interface ResumeOptions {
  search?: string;
  latest?: boolean;
  project?: string;
  dryRun?: boolean;
  confirm?: boolean;
  cwd?: string;
}

export async function resume(registry: RegistryManager, target?: string, opts: ResumeOptions = {}): Promise<void> {
  let uuid: string;

  if (opts.latest) {
    uuid = findLatestSession(registry, opts.project);
  } else if (opts.search) {
    uuid = await searchAndSelect(registry, opts.search);
  } else if (target) {
    const match = registry.findByPrefix(target);
    if (!match) throw new CCLinkerError('E002', `未找到匹配 "${target}" 的会话`);
    uuid = match[0];
  } else {
    uuid = await interactiveSelect(registry);
  }

  let entry = registry.get(uuid);
  if (!entry) throw new CCLinkerError('E002', '会话不存在');

  // 状态检测（第 1 轮仅提示，不触发真正的 repair）
  const status = entry.status ?? 'active';
  switch (status) {
    case 'active':
    case 'archived':
      break; // 允许恢复
    case 'provisioning':
      throw new CCLinkerError('E011', '会话仍在创建中，请稍后重试');
    case 'degraded':
      throw new CCLinkerError('E010', `会话处于降级状态: ${entry.last_error ?? '原因未知'}`);
    case 'corrupted':
      throw new CCLinkerError('E012', '会话已损坏，无法恢复。请切换到其他会话或重新创建');
    default:
      break;
  }

  // Execute dry-run（先于 JSONL 检查，dry-run 只显示命令不验证文件）
  const targetCwd = opts.cwd ?? entry.cwd;
  const claudeBin = config.get<string>('general.claude_bin', 'claude');
  if (opts.dryRun) {
    console.log(chalk.blue(`将执行: cd ${targetCwd} && ${claudeBin} --resume ${uuid}`));
    return;
  }

  // 第 1 轮不做 repair / 状态回写。只基于当前 registry 状态做提示。
  if (entry.jsonl_path && !existsSync(entry.jsonl_path)) {
    throw new CCLinkerError('E002', 'JSONL 文件不存在，会话可能已被清理。请稍后执行 sync，或等待第 5 轮 repair/reconciler 能力接入。');
  }

  // CWD check
  const currentDir = process.cwd();
  if (targetCwd !== currentDir && opts.confirm !== false) {
    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: `此会话在 ${targetCwd} 中创建，将切换到该目录并恢复。继续？`,
      default: true,
    }]);
    if (!confirmed) return;
  }

  if (!existsSync(targetCwd)) {
    throw new CCLinkerError('E008', `工作目录不存在: ${targetCwd}，使用 --cwd 指定替代目录`);
  }

  console.log(chalk.green(`恢复会话: ${entry.title ?? uuid}`));
  process.chdir(targetCwd);
  const result = Bun.spawnSync([claudeBin, '--resume', uuid], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(result.exitCode ?? 1);
}

function findLatestSession(registry: RegistryManager, project?: string): string {
  let sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => !s.status || s.status === 'active');

  if (project) {
    sessions = sessions.filter(([_, s]) => s.project_name?.includes(project));
  }

  if (sessions.length === 0) {
    throw new CCLinkerError('E002', '没有找到活跃会话');
  }

  sessions.sort((a, b) => b[1].last_active.localeCompare(a[1].last_active));
  return sessions[0][0];
}

async function searchAndSelect(registry: RegistryManager, query: string): Promise<string> {
  let matches = Object.entries(registry.sessions)
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
  let sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => !s.status || s.status === 'active');

  sessions = sessions
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
```

- [ ] **Step 2: 阶段性提交（如适合）**

---

### Task 1.11: 更新 `src/cli/commands/init.ts`

**Files:**
- Modify: `src/cli/commands/init.ts`

移除 cc-connect 计数。

- [ ] **Step 1: 覆盖写入 `src/cli/commands/init.ts`**

```typescript
import chalk from 'chalk';
import { existsSync } from 'fs';
import { RegistryManager } from '../../registry';
import { syncBeforeCommand } from '../../scanner';
import { CCLinkerError } from '../../utils/errors';
import { RUNTIME_OWNER_LOCK_PATH } from '../../utils/paths';

export async function init(registry: RegistryManager): Promise<void> {
  const isFresh = Object.keys(registry.sessions).length === 0;
  if (isFresh) {
    console.log(chalk.green(`✅ Created ${registry.path}`));
  } else {
    console.log(chalk.cyan(`📁 Registry exists at ${registry.path}, will refresh`));
  }

  if (existsSync(RUNTIME_OWNER_LOCK_PATH)) {
    throw new CCLinkerError('E013', '检测到 cc-linker start 正在运行，init 会写 registry，请停止服务后重试');
  }

  console.log(chalk.blue('🔍 Scanning for existing sessions...'));
  await syncBeforeCommand(registry, undefined, undefined, false, true);

  const sessions = Object.values(registry.sessions);
  const fromFeishu = sessions.filter(s => s.origin === 'feishu').length;
  const fromCli = sessions.filter(s => s.origin === 'cli').length;

  console.log(`   Found ${fromCli} CLI sessions`);
  console.log(`   Found ${fromFeishu} Feishu sessions`);
  console.log(chalk.green(`✅ Registered ${sessions.length} sessions total`));

  console.log('\nNext steps:');
  console.log('  1. Run \'cc-linker hook install\' to install Claude Code hook');
  console.log('  2. Run \'cc-linker list\' to view all sessions');
  console.log('  3. Run \'cc-linker resume\' to resume a session');
}
```

- [ ] **Step 2: 阶段性提交（如适合）**

---

### Task 1.12: 更新 `src/cli/commands/sync.ts`

**Files:**
- Modify: `src/cli/commands/sync.ts`

移除 cc-connect 引用。

- [ ] **Step 1: 覆盖写入 `src/cli/commands/sync.ts`**

```typescript
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { syncBeforeCommand } from '../../scanner';
import { existsSync } from 'fs';
import { CCLinkerError } from '../../utils/errors';
import { RUNTIME_OWNER_LOCK_PATH } from '../../utils/paths';

interface SyncOptions {
  scan?: boolean;
  force?: boolean;
  clean?: boolean;
}

export async function sync(registry: RegistryManager, opts: SyncOptions): Promise<void> {
  if (existsSync(RUNTIME_OWNER_LOCK_PATH)) {
    throw new CCLinkerError('E013', '检测到 cc-linker start 正在运行，sync 会写 registry，请停止服务后重试');
  }

  console.log(chalk.blue('🔄 Syncing sessions...'));

  const beforeKeys = new Set(Object.keys(registry.sessions));

  if (opts.clean) {
    const toClean: string[] = [];
    for (const [uuid, entry] of Object.entries(registry.sessions)) {
      if (entry.jsonl_path && !existsSync(entry.jsonl_path)) {
        toClean.push(uuid);
      }
    }
    if (toClean.length > 0) {
      await registry.removeBatch(toClean);
    }
    console.log(`   Cleaned ${toClean.length} invalid sessions`);
  }

  if (opts.scan) {
    await syncBeforeCommand(registry, undefined, undefined, true, opts.force);
  } else {
    await syncBeforeCommand(registry, undefined, undefined, false, opts.force);
  }

  const sessions = Object.values(registry.sessions);
  const afterKeys = new Set(Object.keys(registry.sessions));
  const fromFeishu = sessions.filter(s => s.origin === 'feishu').length;
  const fromCli = sessions.filter(s => s.origin === 'cli').length;

  const newSessions = [...afterKeys].filter(k => !beforeKeys.has(k)).length;
  const updatedSessions = [...afterKeys].filter(k => beforeKeys.has(k)).length;
  const removedSessions = [...beforeKeys].filter(k => !afterKeys.has(k)).length;

  console.log(`   Found ${fromCli} CLI sessions, ${fromFeishu} Feishu sessions`);
  if (!opts.scan) {
    console.log(`   New sessions registered: ${newSessions}`);
    console.log(`   Sessions updated: ${updatedSessions}`);
  }
  if (opts.clean) console.log(`   Sessions cleaned: ${removedSessions}`);

  const label = opts.scan ? 'Scan' : 'Sync';
  console.log(chalk.green(`✅ ${label} complete. Total registered: ${sessions.length}`));
}
```

- [ ] **Step 2: 阶段性提交（如适合）**

---

### Task 1.13: 更新 `src/cli/commands/clean.ts`

**Files:**
- Modify: `src/cli/commands/clean.ts`

移除 cc-connect 映射判断逻辑。

- [ ] **Step 1: 覆盖写入 `src/cli/commands/clean.ts`**

```typescript
import chalk from 'chalk';
import { existsSync } from 'fs';
import { RegistryManager } from '../../registry';
import { CCLinkerError } from '../../utils/errors';
import { RUNTIME_OWNER_LOCK_PATH } from '../../utils/paths';

interface CleanOptions {
  dryRun?: boolean;
  olderThan?: string;
}

export async function clean(registry: RegistryManager, opts: CleanOptions = {}): Promise<void> {
  if (existsSync(RUNTIME_OWNER_LOCK_PATH)) {
    throw new CCLinkerError('E013', '检测到 cc-linker start 正在运行，clean 会写 registry，请停止服务后重试');
  }

  const olderThanDays = opts.olderThan ? (() => {
    const n = parseInt(opts.olderThan, 10);
    if (isNaN(n)) throw new CCLinkerError('E005', `无效的天数: ${opts.olderThan}`);
    return n;
  })() : undefined;
  const cutoff = olderThanDays
    ? new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const toClean: string[] = [];

  for (const [uuid, entry] of Object.entries(registry.sessions)) {
    const jsonlMissing = entry.jsonl_path ? !existsSync(entry.jsonl_path) : true;

    if (jsonlMissing) {
      toClean.push(uuid);
      continue;
    }

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

  await registry.removeBatch(toClean);

  console.log(chalk.green(`\n已清理 ${toClean.length} 个会话`));
}
```

- [ ] **Step 2: 阶段性提交（如适合）**

---

### Task 1.14: 更新 `src/cli/commands/status.ts`

**Files:**
- Modify: `src/cli/commands/status.ts`

移除 cc-connect 引用，更新状态展示。

- [ ] **Step 1: 覆盖写入 `src/cli/commands/status.ts`**

```typescript
import chalk from 'chalk';
import { readFileSync, existsSync, statSync } from 'fs';
import { RegistryManager } from '../../registry';
import { formatTimeAgo } from '../output';
import { CLAUDE_SETTINGS_PATH } from '../../utils/paths';

export async function status(registry: RegistryManager): Promise<void> {
  const sessions = Object.values(registry.sessions);
  const active = sessions.filter(s => !s.status || s.status === 'active').length;
  const provisioning = sessions.filter(s => s.status === 'provisioning').length;
  const degraded = sessions.filter(s => s.status === 'degraded').length;
  const archived = sessions.filter(s => s.status === 'archived').length;
  const fromCli = sessions.filter(s => s.origin === 'cli').length;
  const fromFeishu = sessions.filter(s => s.origin === 'feishu').length;
  const corrupted = sessions.filter(s => s.status === 'corrupted').length;

  console.log(chalk.bold('cc-linker Status'));
  console.log('─'.repeat(40));
  console.log(`Registry:      ${registry.path}`);

  if (existsSync(registry.path)) {
    const stat = statSync(registry.path);
    console.log(`Last modified: ${formatTimeAgo(stat.mtime.toISOString())}`);
  }

  console.log(`Total sessions: ${sessions.length}`);
  console.log(`  From CLI:       ${fromCli}`);
  console.log(`  From Feishu:    ${fromFeishu}`);
  console.log(`  Active:         ${active}`);
  console.log(`  Provisioning:   ${provisioning}`);
  console.log(`  Degraded:       ${degraded}`);
  console.log(`  Archived:       ${archived}`);
  console.log(`  Corrupted:      ${corrupted}`);

  let hookInstalled = false;
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
      const sessionStart = settings.hooks?.SessionStart;
      if (Array.isArray(sessionStart)) {
        hookInstalled = sessionStart.some((matcher: any) =>
          matcher?.hooks?.some((h: any) => h?.command?.includes('cc-linker'))
        );
      }
    } catch {}
  }
  console.log(`\nHook:`);
  console.log(`  Claude Code hook:   ${hookInstalled ? chalk.green('installed') : chalk.red('not installed')}`);
}
```

- [ ] **Step 2: 提交**

```bash
git add src/cli/commands/status.ts
git commit -m "refactor: update status command for self-hosted scheme"
```

---

### Task 1.15: 更新 `src/cli/commands/register.ts`

**Files:**
- Modify: `src/cli/commands/register.ts`

新类型中不再有 `source` 字段。

- [ ] **Step 1: 覆盖写入 `src/cli/commands/register.ts`**

```typescript
import { RegistryManager, type SessionEntry } from '../../registry';
import { OriginSchema } from '../../registry/types';
import { CCLinkerError } from '../../utils/errors';
import { isValidUUID } from '../../utils/validation';

interface RegisterOptions {
  origin?: string;
  cwd?: string;
  dryRun?: boolean;
}

export async function registerSession(
  registry: RegistryManager,
  uuid: string,
  opts: RegisterOptions = {}
): Promise<void> {
  if (!isValidUUID(uuid)) {
    throw new CCLinkerError('E005', `无效的 UUID 格式: ${uuid}`);
  }

  const originResult = OriginSchema.safeParse(opts.origin ?? 'cli');
  if (!originResult.success) {
    throw new CCLinkerError('E005', `无效的 origin 值: ${opts.origin}`);
  }

  const entry: Partial<SessionEntry> = {
    origin: originResult.data,
    cwd: opts.cwd ?? process.cwd(),
    last_active: new Date().toISOString(),
  };

  if (opts.dryRun) {
    console.log(`[dry-run] 将要注册会话:`);
    console.log(`  UUID:   ${uuid}`);
    console.log(`  Origin: ${entry.origin}`);
    console.log(`  CWD:    ${entry.cwd}`);
    if (registry.has(uuid)) {
      console.log(`  注: 该 UUID 已存在，将更新 last_active 字段`);
    }
    return;
  }

  registry.upsert(uuid, entry);
  await registry.flush();
}
```

- [ ] **Step 2: 提交**

```bash
git add src/cli/commands/register.ts
git commit -m "refactor: update register command for new types (remove source field)"
```

---

### Task 1.16: 更新 `src/index.ts`

**Files:**
- Modify: `src/index.ts`

移除 `feishu-cmd` 导入和注册。移除已废弃的 CLI 选项（`-P --platform`、`-u --user` 等）。

- [ ] **Step 1: 覆盖写入 `src/index.ts`**

```typescript
#!/usr/bin/env bun
import { Command } from 'commander';
import { RegistryManager } from './registry';
import { syncBeforeCommand } from './scanner';
import { handleError } from './utils/errors';
import { init } from './cli/commands/init';
import { list } from './cli/commands/list';
import { resume } from './cli/commands/resume';
import { show } from './cli/commands/show';
import { sync } from './cli/commands/sync';
import { status } from './cli/commands/status';
import { hookInstall, hookUninstall, hookStatus, hookSessionStart } from './cli/commands/hook';
import { registerSession } from './cli/commands/register';
import { exportSession } from './cli/commands/export';
import { search } from './cli/commands/search';
import { clean } from './cli/commands/clean';

const program = new Command();

program
  .name('cc-linker')
  .description('飞书 ↔ Claude Code CLI 桥接工具')
  .version('0.2.0');

async function withSync(fn: (registry: RegistryManager) => Promise<void>, skipSync = false) {
  const registry = new RegistryManager();
  if (!skipSync) {
    await syncBeforeCommand(registry);
  }
  await fn(registry);
}

program
  .command('init')
  .description('初始化 registry 并扫描已有会话')
  .action(() => withSync(async (registry) => {
    await init(registry);
  }, true));

program
  .command('list')
  .description('列出所有可恢复的会话')
  .option('-p, --project <name>', '按项目名过滤')
  .option('-o, --origin <type>', '按来源过滤')
  .option('-a, --active', '只显示最近 2 小时活跃的会话')
  .option('--archived', '显示 archived/corrupted 会话（默认仅显示 active）')
  .option('-f, --format <type>', '输出格式: table/json/csv', 'table')
  .option('-l, --limit <n>', '最多显示 n 条', '20')
  .option('-s, --sort <field>', '排序字段', 'last_active')
  .option('--no-sync', '跳过自动同步')
  .action((opts) => withSync(async (registry) => {
    await list(registry, opts);
  }, !opts.sync));

program
  .command('resume [target]')
  .description('恢复指定会话到 Claude Code CLI')
  .option('-s, --search <query>', '按标题搜索')
  .option('-L, --latest', '恢复最近活跃的会话')
  .option('-p, --project <name>', '指定项目')
  .option('-n, --dry-run', '只显示命令，不执行')
  .option('--no-confirm', '跳过 CWD 变更提示')
  .option('--cwd <path>', '手动指定工作目录')
  .option('--no-sync', '跳过自动同步')
  .action((target, opts) => withSync(async (registry) => {
    await resume(registry, target, opts);
  }, !opts.sync));

program
  .command('show <target>')
  .description('查看会话详情')
  .option('--no-sync', '跳过自动同步')
  .action((target, opts) => withSync(async (registry) => {
    await show(registry, target);
  }, !opts.sync));

program
  .command('sync')
  .description('手动同步会话')
  .option('--scan', '只扫描，不写入 registry（dry run）')
  .option('--force', '强制刷新')
  .option('--clean', '清理无效记录')
  .action((opts) => withSync(async (registry) => {
    await sync(registry, opts);
  }));

program
  .command('status')
  .description('查看桥接工具状态')
  .option('--no-sync', '跳过自动同步')
  .action((opts) => withSync(async (registry) => {
    await status(registry);
  }, !opts.sync));

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
  .option('-n, --dry-run', '只显示将要注册的条目，不实际写入')
  .action((uuid, opts) => withSync(async (registry) => {
    await registerSession(registry, uuid, opts);
  }, true));

program
  .command('export <target>')
  .description('导出会话为 markdown/text/json')
  .option('-f, --format <type>', '输出格式: markdown/text/json', 'markdown')
  .option('-o, --output <path>', '输出文件')
  .option('--include-thinking', '包含 thinking block')
  .option('--include-tools', '包含工具调用详情')
  .option('--max-messages <n>', '最大消息数')
  .option('--no-sync', '跳过自动同步')
  .action((target, opts) => withSync(async (registry) => {
    await exportSession(registry, target, opts);
  }, !opts.sync));

program
  .command('search <query>')
  .description('搜索会话')
  .option('--in-title', '只搜索标题')
  .option('--in-content', '搜索 JSONL 内容（较慢）')
  .option('-l, --limit <n>', '最多显示 n 条', '20')
  .option('--no-sync', '跳过自动同步')
  .action((query, opts) => withSync(async (registry) => {
    await search(registry, query, opts);
  }, !opts.sync));

program
  .command('clean')
  .description('清理无效记录')
  .option('--dry-run', '预览')
  .option('--older-than <days>', '清理 N 天前的')
  .option('--no-sync', '跳过自动同步')
  .action((opts) => withSync(async (registry) => {
    await clean(registry, opts);
  }, !opts.sync));

program.parseAsync(process.argv).catch(handleError);
```

- [ ] **Step 2: 提交**

```bash
git add src/index.ts
git commit -m "refactor: remove feishu-cmd from CLI, update program description"
```

---

### Task 1.17: 更新 `src/cli/commands/list.ts` 和 `src/cli/commands/show.ts`

这两个命令引用了旧的 SessionEntry 字段（`platform`、`owner`、`source` 等）。需要适配新类型。

**Files:**
- Modify: `src/cli/commands/list.ts`
- Modify: `src/cli/commands/show.ts`
- Modify: `src/cli/output.ts`

- [ ] **Step 1: 覆盖写入 `src/cli/output.ts`**

更新 `formatOrigin` 和 CSV/JSON 输出以匹配新类型（移除 `platform`）：

```typescript
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
  return origin === 'feishu' ? chalk.green('飞书') : chalk.blue('终端');
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
      status: s.status ?? 'active',
      project_name: s.project_name,
      cwd: s.cwd,
      jsonl_path: s.jsonl_path,
      message_count: s.message_count,
      last_active: s.last_active,
    })),
    null,
    2
  );
}

function sanitizeCsvField(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) {
    return "'" + value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

export function formatCsv(sessions: Array<[string, SessionEntry]>): string {
  const header = 'ref,uuid,title,origin,status,project_name,cwd,jsonl_path,message_count,last_active';
  const rows = sessions.map(([uuid, s]) =>
    [uuid.slice(0, 8), uuid, sanitizeCsvField(s.title ?? ''), s.origin, s.status ?? 'active', sanitizeCsvField(s.project_name ?? ''), sanitizeCsvField(s.cwd), sanitizeCsvField(s.jsonl_path ?? ''), s.message_count, s.last_active].join(',')
  );
  return [header, ...rows].join('\n');
}
```

- [ ] **Step 2: 覆盖写入 `src/cli/commands/list.ts`**

移除 `platform` 过滤选项：

```typescript
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { formatTable, formatJson, formatCsv, formatTimeAgo, formatOrigin } from '../output';

interface ListOptions {
  project?: string;
  origin?: string;
  active?: boolean;
  archived?: boolean;
  format?: string;
  limit?: string;
  sort?: string;
}

export async function list(registry: RegistryManager, opts: ListOptions): Promise<void> {
  let sessions = Object.entries(registry.sessions);

  // 默认显示 active/provisioning/degraded；--archived 显示 archived/corrupted
  if (!opts.archived) {
    sessions = sessions.filter(([_, s]) =>
      !s.status || s.status === 'active' || s.status === 'provisioning' || s.status === 'degraded'
    );
  } else {
    sessions = sessions.filter(([_, s]) => s.status === 'archived' || s.status === 'corrupted');
  }

  if (opts.project) {
    sessions = sessions.filter(([_, s]) => s.project_name?.includes(opts.project!));
  }
  if (opts.origin) {
    sessions = sessions.filter(([_, s]) => s.origin === opts.origin);
  }
  if (opts.active) {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    sessions = sessions.filter(([_, s]) => s.last_active > twoHoursAgo);
  }

  const sortField = opts.sort ?? 'last_active';
  sessions.sort((a, b) => {
    if (sortField === 'created_at') return b[1].created_at.localeCompare(a[1].created_at);
    if (sortField === 'message_count') return b[1].message_count - a[1].message_count;
    return b[1].last_active.localeCompare(a[1].last_active);
  });

  const limit = parseInt(opts.limit ?? '20', 10);
  sessions = sessions.slice(0, limit);

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

- [ ] **Step 3: 覆盖写入 `src/cli/commands/show.ts`**

移除 `source` 字段显示，新增新字段：

```typescript
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
  console.log(`来源:        ${formatOrigin(s.origin)}`);
  console.log(`项目:        ${s.project_name ?? '?'}`);
  console.log(`工作目录:    ${s.cwd}`);
  console.log(`状态:        ${s.status ?? 'active'}`);
  console.log(`创建时间:    ${new Date(s.created_at).toLocaleString('zh-CN')}`);
  console.log(`最后活跃:    ${formatTimeAgo(s.last_active)}`);
  console.log(`消息数:      ${s.message_count}`);
  console.log(`\nJSONL 文件: ${s.jsonl_path ?? '未补齐'}`);
  if (s.last_error) {
    console.log(`最后错误:    ${s.last_error}`);
  }
  console.log(`\n操作:`);
  console.log(`  cc-linker resume ${uuid.slice(0, 8)}   恢复此会话`);
}
```

- [ ] **Step 4: 提交**

```bash
git add src/cli/output.ts src/cli/commands/list.ts src/cli/commands/show.ts
git commit -m "refactor: update list/show/output for new types (remove platform/source, add status/jsonl_path)"
```

---

### Task 1.18: 修复测试

**Files:**
- Modify: `tests/unit/registry.test.ts`
- Modify: `tests/unit/scanner/jsonl.test.ts`
- Modify: `tests/unit/utils/config.test.ts`
- Modify: `tests/unit/utils/errors.test.ts`
- Modify: `tests/unit/hook/session-start.test.ts`
- Delete: `tests/unit/scanner/source-override.test.ts`（已在 Task 1.1 中删除）
- Modify: `tests/integration/cli-commands.test.ts`
- Modify: `tests/integration/acceptance.test.ts`
- Modify: `tests/fixtures/sample.jsonl`

- [ ] **Step 1: 运行测试看失败**

```bash
bun test 2>&1 | head -100
```

- [ ] **Step 2: 逐个修复**

根据测试失败信息，调整测试 fixtures 和断言以匹配新类型。关键变更：
- 所有 `origin: 'cc-connect'` 改为 `origin: 'feishu'`
- 移除 `source`、`platform`、`owner`、`cc_connect_session_id` 等字段的断言
- `status` 值更新为新枚举
- `jsonl_path` 现在可以是 `null`

- [ ] **Step 3: 确保 bun test 全绿**

```bash
bun test
```

预期：全部通过。

- [ ] **Step 4: 提交**

```bash
git add tests/
git commit -m "test: update tests for self-hosted scheme types"
```

---

### Task 1.19: 第 1 轮验证

- [ ] **Step 1: 全量验证**

```bash
bun run typecheck && bun test && bun build src/index.ts --compile --outfile dist/cc-linker
```

- [ ] **Step 2: 手动验证 CLI 命令**

```bash
# 确保 cc-linker 命令可用
bun link

cc-linker --version
cc-linker --help
cc-linker list --help
cc-linker resume --help
cc-linker status --help
cc-linker init --help
cc-linker sync --help
cc-linker clean --help
cc-linker search --help
cc-linker export --help
cc-linker hook --help
```

- [ ] **Step 3: 提交最终**

```bash
git add -A
git commit -m "round 1 complete: infrastructure refactor for self-hosted Feishu bot"
```

---

# 第 2 轮：Claude Session Manager（概要）

> **目标**：实现 Claude Code 进程管理。
> **新文件**：`src/proxy/session.ts`

### 核心设计

```typescript
interface SendMessageResult {
  response: string;
  costUsd: number;
  durationMs: number;
  sessionId: string;
  jsonlPath: string | null;
  sessionStatus: 'active' | 'provisioning' | 'degraded';
}

class ClaudeSessionManager {
  private activeRequests = new Map<string, Promise<void>>(); // per-session lock
  private runningProcesses = 0;
  private processWaiters: Array<() => void> = [];
  private readonly maxConcurrentProcesses = 2;

  async sendMessage(sessionId: string | null, text: string, cwd: string, isNew?: boolean): Promise<SendMessageResult>;
  listSessions(): ClaudeSession[];  // 内存中活跃进程
  cleanupIdleSessions(idleTimeoutMs: number): void;
}
```

### 关键任务

1. **Task 2.1**: 创建 `src/proxy/session.ts` — `_doSendMessage()` 核心逻辑（spawn、JSON 解析、超时）
2. **Task 2.2**: 实现 `resolveJsonlPath()` — 短轮询查找 JSONL 文件
3. **Task 2.3**: 实现并发控制 — per-session 锁 + 全局槽位
4. **Task 2.4**: 实现进程组回收 — `terminateProcessTree()`
5. **Task 2.5**: 编写单元测试 — mock spawn 验证 JSON 解析和超时
6. **Task 2.6**: 集成测试 — 真实 `claude -p` 验证端到端

---

# 第 3 轮：User Mapping + List Snapshot（概要）

> **目标**：飞书 open_id → session_uuid 映射 + 列表快照。
> **新文件**：`src/feishu/mapping.ts`, `src/feishu/list-snapshot.ts`

### 关键任务

1. **Task 3.1**: 创建 `src/feishu/mapping.ts` — 加载/保存 user-mapping.json
2. **Task 3.2**: 实现 `compareAndSwap()` — CAS 原子抢占（文件锁 + version 递增）
3. **Task 3.3**: 实现 owner 校验和自动绑定
4. **Task 3.4**: 实现 `pending_new_session_claimed` 超时回滚
5. **Task 3.5**: 创建 `src/feishu/list-snapshot.ts` — 序号快照管理
6. **Task 3.6**: 单元测试 — CAS 原子性、超时回滚、快照过期

---

# 第 4 轮：Feishu Bot + Spool Queue（概要）

> **目标**：飞书消息接收 → 可靠队列 → Claude 处理 → 飞书回复。
> **新文件**：`src/queue/spool.ts`, `src/feishu/bot.ts`, `src/cli/commands/start.ts`

### 关键任务

1. **Task 4.1**: 创建 `src/queue/spool.ts` — 消息原子写入 + 状态流转
2. **Task 4.2**: 实现入站/出站幂等（receipts + deliveries + stable uuid）
3. **Task 4.3**: 实现 Target Snapshot 固化 + Dispatcher 调度
4. **Task 4.4**: 创建 `src/feishu/bot.ts` — WSClient + 命令路由
5. **Task 4.5**: 实现 `/bridge help/list/new/switch/resume/status` 命令处理
6. **Task 4.6**: 实现飞书回复（分片 + 限流重试）
7. **Task 4.7**: 创建 `cc-linker start` 命令
8. **Task 4.8**: 集成测试 — mock WSClient + API 验证全链路

---

# 第 5 轮：Runtime Coordinator + Startup Reconciler（概要）

> **目标**：运行态单写者 + 启动自愈。
> **新文件**：`src/runtime/state-coordinator.ts`, `src/runtime/reconciler.ts`

### 关键任务

1. **Task 5.1**: 创建 `src/runtime/state-coordinator.ts` — owner.lock 管理
2. **Task 5.2**: CLI 写命令检测 lock → 拒绝
3. **Task 5.3**: 创建 `src/runtime/reconciler.ts` — startupReconcile
4. **Task 5.4**: 实现定时归档清理
5. **Task 5.5**: 实现 SIGINT/SIGTERM 优雅停机
6. **Task 5.6**: 模拟崩溃恢复测试

---

# 第 6 轮：端到端测试 + 故障注入（概要）

### 关键任务

1. **Task 6.1**: 正常链路端到端测试
2. **Task 6.2**: `/bridge switch` 竞态测试
3. **Task 6.3**: 连续消息不创建两个新会话测试
4. **Task 6.4**: 崩溃恢复 + 不重复回复测试
5. **Task 6.5**: 出站幂等测试
6. **Task 6.6**: owner.lock 冲突测试
7. **Task 6.7**: jsonl_path 延迟补齐测试
8. **Task 6.8**: 列表快照过期测试
9. **Task 6.9**: Claude 超时 kill 测试

---

## 规范自审

### 1. Spec coverage

| 规范项 | 对应 Task |
|--------|-----------|
| 删除 cc-connect 模块 | Task 1.1 |
| 重构 types.ts | Task 1.2 |
| 更新 buildSessionEntry | Task 1.3 |
| 重构 config.ts | Task 1.4 |
| 重构 paths.ts | Task 1.5 |
| 新增错误码 | Task 1.6 |
| 更新 scanner/index.ts | Task 1.7 |
| 更新 jsonl.ts | Task 1.8 |
| 更新 hook/session-start.ts | Task 1.9 |
| 更新 resume.ts（状态检测） | Task 1.10 |
| 更新 init.ts | Task 1.11 |
| 更新 sync.ts | Task 1.12 |
| 更新 clean.ts | Task 1.13 |
| 更新 status.ts | Task 1.14 |
| 更新 register.ts | Task 1.15 |
| 更新 index.ts | Task 1.16 |
| 更新 list/show/output | Task 1.17 |
| 修复测试 | Task 1.18 |
| 全量验证 | Task 1.19 |
| Session Manager | 第 2 轮概要 |
| User Mapping + List Snapshot | 第 3 轮概要 |
| Feishu Bot + Spool Queue | 第 4 轮概要 |
| Runtime Coordinator + Reconciler | 第 5 轮概要 |
| 端到端测试 + 故障注入 | 第 6 轮概要 |

✅ 所有规范项均有对应 task。

### 2. Placeholder scan

搜索计划中的 TBD/TODO："无"。第 2-6 轮为概要描述，但这是分阶段计划的预期设计——详细实现步骤会在每轮开始前展开。

### 3. Type consistency

第 1 轮中定义的新类型（SessionEntry、Status、Origin 等）在后续命令修改中保持一致。`CCLinkerError` 代码 E010-E013 与 resume.ts 中的使用匹配。

### 4. Scope check

本计划仅覆盖第 1 轮的详细实现步骤，第 2-6 轮为概要描述。每轮可独立构建和测试。

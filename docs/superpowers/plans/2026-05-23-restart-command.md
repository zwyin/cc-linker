# restart 命令实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `cc-linker restart` CLI 命令，提供一键重启 Bot 服务的能力（容错启动模式）

**Architecture:** 复用现有的 `stop()` 和 `start()` 函数，先检查运行状态，按需停止后再启动。新增独立文件 `restart.ts` 保持职责单一。

**Tech Stack:** TypeScript, Bun, Commander.js

---

### Task 1: 创建 restart 命令实现

**Files:**
- Create: `src/cli/commands/restart.ts`
- Modify: `src/cli/commands/start.ts`（确认导出 `isDaemonRunning`）

- [ ] **Step 1: 确认 `isDaemonRunning` 已导出**

检查 `src/cli/commands/start.ts` 中 `isDaemonRunning` 是否已导出。如果未导出，添加 `export` 关键字。

```typescript
// 在 start.ts 中确认这个函数是导出的
export function isDaemonRunning(): boolean {
```

- [ ] **Step 2: 创建 restart.ts**

```typescript
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { isDaemonRunning, stop, StartOptions } from './start';

export interface RestartOptions {
  daemon?: boolean;
}

export async function restart(registry: RegistryManager, opts: RestartOptions = {}): Promise<void> {
  const wasRunning = isDaemonRunning();

  if (wasRunning) {
    console.log(chalk.cyan('🔄 正在重启 cc-linker...'));
    await stop();
    console.log(chalk.gray('  等待进程完全停止...'));
    await new Promise(r => setTimeout(r, 1000));
  } else {
    console.log(chalk.cyan('🚀 Bot 未运行，直接启动...'));
  }

  const { start } = await import('./start');
  await start(registry, { daemon: true, ...opts });
}
```

- [ ] **Step 3: 在 index.ts 注册 restart 命令**

修改 `src/index.ts`，在 start/stop 命令附近注册 restart：

```typescript
// 在已有的 start 命令注册之后添加
program
  .command('restart')
  .description('重启 Bot 服务（先 stop 再 start --daemon）')
  .option('--daemon', '以守护进程模式重启', true)
  .action((opts) => withSync(async (registry) => {
    const { restart } = await import('./cli/commands/restart');
    await restart(registry, opts);
  }, true));
```

注意：restart 应该使用 `withSync(..., true)`（第二个参数 true 表示需要 registry），与 start 保持一致。

- [ ] **Step 4: 运行类型检查**

```bash
bun run typecheck
```

Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/restart.ts src/index.ts
git commit -m "feat(cli): add restart command"
```

### Task 2: 添加测试

**Files:**
- Create: `tests/unit/cli/commands/restart.test.ts`

- [ ] **Step 1: 编写 restart 测试**

```typescript
import { describe, it, expect, beforeEach, jest } from 'bun:test';
import { restart } from '../../../../src/cli/commands/restart';

// Mock start.ts
const mockIsDaemonRunning = jest.fn();
const mockStop = jest.fn();
const mockStart = jest.fn();

jest.mock('../../../../src/cli/commands/start', () => ({
  isDaemonRunning: () => mockIsDaemonRunning(),
  stop: () => mockStop(),
  start: (registry: any, opts: any) => mockStart(registry, opts),
}));

describe('restart', () => {
  beforeEach(() => {
    mockIsDaemonRunning.mockReset();
    mockStop.mockReset();
    mockStart.mockReset();
  });

  it('should stop then start when daemon is running', async () => {
    mockIsDaemonRunning.mockReturnValue(true);
    mockStop.mockResolvedValue(undefined);
    mockStart.mockResolvedValue(undefined);

    const registry = { sessions: {} } as any;
    await restart(registry, {});

    expect(mockStop).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledWith(registry, expect.objectContaining({ daemon: true }));
  });

  it('should start directly when daemon is not running', async () => {
    mockIsDaemonRunning.mockReturnValue(false);
    mockStart.mockResolvedValue(undefined);

    const registry = { sessions: {} } as any;
    await restart(registry, {});

    expect(mockStop).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledWith(registry, expect.objectContaining({ daemon: true }));
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
bun test tests/unit/cli/commands/restart.test.ts
```

Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add tests/unit/cli/commands/restart.test.ts
git commit -m "test(cli): add restart command tests"
```

### Task 3: 更新 README 文档

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在 Bot 运行管理表格中添加 restart 命令**

在 README.md 第 124-131 行附近的表格中添加：

```markdown
| `cc-linker restart` | 重启 Bot 服务（先 stop 再 start） |
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add restart command to README"
```

### Task 4: 最终验证

- [ ] **Step 1: 运行全部测试**

```bash
bun test
```

Expected: 全部通过

- [ ] **Step 2: 运行类型检查**

```bash
bun run typecheck
```

Expected: 无错误

- [ ] **Step 3: 验证命令注册**

```bash
bun run dev -- --help | grep restart
```

Expected: 输出中包含 restart 命令

#!/usr/bin/env node
/**
 * postinstall hook — runs after `npm install -g cc-linker@latest`.
 *
 * Purpose: if a cc-linker daemon is already running, restart it to apply the
 * update. This gives end-users a one-step "upgrade" experience.
 *
 * Safety: idempotent, no-op if daemon not running, no-op on fresh install.
 * The hook does NOT install the launchd plist (that's `cc-linker daemon install`)
 * and does NOT init Feishu credentials (that's `cc-linker init-feishu` or
 * `cc-linker setup`).
 *
 * For developers: `bun run deploy` uses `--ignore-scripts` to skip this,
 * so deploy handles its own restart sequence without competing.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

const home = process.env.HOME ?? homedir();
const pidFile = join(home, '.cc-linker', 'cc-linker.pid');

try {
  if (!existsSync(pidFile)) {
    // 没有 daemon 在跑 — 静默退出, 用户需手动 cc-linker setup + start
    process.exit(0);
  }

  const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  if (isNaN(pid)) process.exit(0);

  // 检查进程是否还活着
  process.kill(pid, 0);

  // daemon 在跑, 自动 restart
  console.log('cc-linker: 检测到 daemon 运行 (PID ' + pid + '), 自动 restart...');
  execFileSync('cc-linker', ['restart'], { stdio: 'inherit' });
} catch (e) {
  if (e.code === 'ESRCH') {
    // pid file stale, daemon 已死 — 静默退出
    process.exit(0);
  }
  // execFileSync 失败 (cc-linker not in PATH?) — 不报错, 用户会手动 restart
  process.exit(0);
}

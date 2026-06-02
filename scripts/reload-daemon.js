#!/usr/bin/env node
/**
 * reload-daemon — build + auto-restart if daemon is running.
 *
 * Usage:
 *   bun run reload          # build + restart if running
 *   bun run reload:force    # build + always restart (start if not running)
 */

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync, spawn } from 'child_process';

const FORCE = process.argv.includes('--force') || process.argv.includes('-f');

function log(...args) {
  console.log('  ' + args.join(' '));
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

try {
  const home = process.env.HOME ?? homedir();
  const pidFile = join(home, '.cc-linker', 'cc-linker.pid');

  const hasPidFile = existsSync(pidFile);
  const pid = hasPidFile ? parseInt(readFileSync(pidFile, 'utf-8').trim(), 10) : null;
  const running = pid && !isNaN(pid) ? isRunning(pid) : false;

  if (!running && !FORCE) {
    log('ℹ️  No daemon running — skipping restart.');
    log('   To start the daemon: cc-linker start --daemon');
    log('   To force restart anyway: bun run reload:force');
    process.exit(0);
  }

  if (running) {
    log('🔄 Daemon detected (PID ' + pid + '), restarting...');
    log('');
  } else if (FORCE) {
    log('🔄 Force mode: no daemon running, starting fresh...');
    log('');
  }

  // Delegate to cc-linker restart (works for both launchd and pure --daemon)
  execFileSync('cc-linker', ['restart'], { stdio: 'inherit' });
} catch (e) {
  if (e.code === 'ESRCH') {
    // Stale PID file — clean it up
    try {
      const home = process.env.HOME ?? homedir();
      const pidFile = join(home, '.cc-linker', 'cc-linker.pid');
      unlinkSync(pidFile);
      log('🧹 Stale PID file removed.');
    } catch {}
    process.exit(0);
  }
  // execFileSync failed — user sees error output
  process.exit(1);
}

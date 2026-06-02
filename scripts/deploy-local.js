#!/usr/bin/env node
/**
 * deploy-local — build, pack, install globally, then restart daemon.
 *
 * Usage:
 *   bun run deploy          # build + global install + restart if running
 *   bun run deploy:force    # build + global install + always restart
 */

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execFileSync, execSync } from 'child_process';

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

function findGlobalInstallDir() {
  try {
    const globalBin = execSync('which cc-linker', { encoding: 'utf8' }).trim();
    const realPath = execSync(`readlink -f "${globalBin}"`, { encoding: 'utf8' }).trim();
    return dirname(realPath); // .../node_modules/cc-linker/dist
  } catch {
    return null;
  }
}

try {
  // Step 1: Build
  log('📦 Building npm package...');
  execFileSync('bun', ['run', 'build:npm'], { stdio: 'inherit' });

  // Step 2: Pack
  log('📦 Packing...');
  execFileSync('npm', ['pack'], { stdio: 'inherit' });

  // Step 3: Find tarball
  const tgz = execSync('ls -t *.tgz | head -1', { encoding: 'utf8' }).trim();
  if (!tgz || !existsSync(tgz)) {
    log('❌ No tarball found');
    process.exit(1);
  }

  // Step 4: Install globally
  log('📦 Installing globally:', tgz);
  execFileSync('npm', ['install', '-g', tgz], { stdio: 'inherit' });

  // Step 5: Check if daemon is running
  const home = process.env.HOME ?? homedir();
  const pidFile = join(home, '.cc-linker', 'cc-linker.pid');
  const hasPidFile = existsSync(pidFile);
  const pid = hasPidFile ? parseInt(readFileSync(pidFile, 'utf-8').trim(), 10) : null;
  const running = pid && !isNaN(pid) ? isRunning(pid) : false;

  if (!running && !FORCE) {
    log('ℹ️  No daemon running — skipping restart.');
    log('   To start the daemon: cc-linker start --daemon');
    log('   To force restart anyway: bun run deploy:force');
    process.exit(0);
  }

  if (running) {
    log('🔄 Daemon detected (PID ' + pid + '), restarting...');
    log('');
  } else if (FORCE) {
    log('🔄 Force mode: starting daemon...');
    log('');
  }

  // Step 6: Restart
  execFileSync('cc-linker', ['restart'], { stdio: 'inherit' });
} catch (e) {
  if (e.code === 'ESRCH') {
    try {
      const home = process.env.HOME ?? homedir();
      const pidFile = join(home, '.cc-linker', 'cc-linker.pid');
      unlinkSync(pidFile);
      log('🧹 Stale PID file removed.');
    } catch {}
    process.exit(0);
  }
  process.exit(1);
}

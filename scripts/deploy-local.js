#!/usr/bin/env node
/**
 * deploy-local — build, pack, install globally, then verify-and-restart.
 *
 * Reliability fixes (7 项):
 *   1. 用 package.json version 构造 tgz 名, 清旧 tgz (避免 ls -t 选错)
 *   2. Deploy lock file 防并发
 *   3. sha256 验证 global cli.js 真换了 + rollback
 *   4. launchctl unload/load 强制 launchd 重新解析 binary
 *   5. Post-deploy 验证 daemon log 含新版本
 *   6. 删 postinstall 自动 restart (避免双重 restart)
 *   7. Atomic build: 写到 tmp 再 rename
 *
 * Usage:
 *   bun run deploy          # build + global install + restart if running
 *   bun run deploy:force    # build + global install + always restart
 *   bun run deploy --skip-build  # skip build, use existing dist/ + tgz
 */

import {
  readFileSync, writeFileSync, existsSync, unlinkSync,
  copyFileSync, statSync, readdirSync, mkdirSync, rmSync, renameSync,
} from 'fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { execFileSync, execSync } from 'child_process';

const FORCE = process.argv.includes('--force') || process.argv.includes('-f');
const SKIP_BUILD = process.argv.includes('--skip-build');

const HOME = process.env.HOME ?? homedir();
const CC_LINKER_DIR = join(HOME, '.cc-linker');
const PID_FILE = join(CC_LINKER_DIR, 'cc-linker.pid');
const DEPLOY_LOCK = join(CC_LINKER_DIR, '.deploy.lock');
const LOG_FILE = join(CC_LINKER_DIR, 'cc-linker.log');
const BACKUP_GLOBAL = join(CC_LINKER_DIR, '.cli.js.backup');
const PLIST = join(HOME, 'Library', 'LaunchAgents', 'com.cclinker.daemon.plist');
const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

function log(...args) {
  console.log('  ' + args.join(' '));
}

function logErr(...args) {
  console.error('  ❌ ' + args.join(' '));
}

function die(msg, code = 1) {
  logErr(msg);
  cleanup();
  process.exit(code);
}

function isRunning(pid) {
  if (!pid || isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function sha256(file) {
  const h = createHash('sha256');
  h.update(readFileSync(file));
  return h.digest('hex');
}

function cleanup() {
  // Release deploy lock
  if (existsSync(DEPLOY_LOCK)) {
    try { unlinkSync(DEPLOY_LOCK); } catch {}
  }
}

function acquireLock() {
  if (existsSync(DEPLOY_LOCK)) {
    const oldPid = parseInt(readFileSync(DEPLOY_LOCK, 'utf8').trim(), 10);
    if (isRunning(oldPid)) {
      die(`另一个 deploy (PID ${oldPid}) 正在进行, 退出`, 1);
    }
    log(`🧹 清理 stale lock (PID ${oldPid} 已死)`);
    try { unlinkSync(DEPLOY_LOCK); } catch {}
  }
  writeFileSync(DEPLOY_LOCK, String(process.pid));
  process.on('exit', cleanup);
  process.on('SIGINT', () => die('SIGINT 收到, 退出', 130));
  process.on('SIGTERM', () => die('SIGTERM 收到, 退出', 143));
}

function readPkgVersion() {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

function cleanOldTgzs(currentTgz) {
  // 删所有 tgz 除了当前要装的 (避免 ls -t 或 npm install 选错)
  for (const f of readdirSync(PROJECT_ROOT)) {
    if (f.endsWith('.tgz') && f !== currentTgz) {
      try { unlinkSync(join(PROJECT_ROOT, f)); log(`🧹 删旧 tgz: ${f}`); }
      catch (e) { logErr(`删 ${f} 失败: ${e.message}`); }
    }
  }
}

function atomicBuild() {
  // 7. atomic build: build 到 tmp 目录, 整目录 rename 到 dist
  // 避免 dist/index.js 存在但 cli.js 已被删的窗口
  const distTmp = join(PROJECT_ROOT, 'dist.tmp');
  if (existsSync(distTmp)) rmSync(distTmp, { recursive: true, force: true });
  if (existsSync(join(PROJECT_ROOT, 'dist'))) {
    rmSync(join(PROJECT_ROOT, 'dist'), { recursive: true, force: true });
  }
  log('📦 Building (atomic, into dist.tmp/)...');
  // 走 build:npm 但改 outdir 为 dist.tmp
  // bun build 不会自己建子目录, 我们建好 dist.tmp 后 build:npm 写入它
  mkdirSync(distTmp, { recursive: true });
  // build:npm 脚本: bun build src/index.ts --outdir dist --target bun --sourcemap && mv dist/index.js dist/cli.js ...
  // 改用 env 变量让 build:npm 写到 dist.tmp
  const buildScript = `bun build src/index.ts --outdir ${JSON.stringify(distTmp)} --target bun --sourcemap && mv ${JSON.stringify(join(distTmp, 'index.js'))} ${JSON.stringify(join(distTmp, 'cli.js'))} && mv ${JSON.stringify(join(distTmp, 'index.js.map'))} ${JSON.stringify(join(distTmp, 'cli.js.map'))} 2>/dev/null; chmod +x ${JSON.stringify(join(distTmp, 'cli.js'))}`;
  execFileSync('sh', ['-c', buildScript], { stdio: 'inherit', cwd: PROJECT_ROOT });
  // 验证 build 产物
  const cliPath = join(distTmp, 'cli.js');
  if (!existsSync(cliPath)) die('build 后 dist.tmp/cli.js 不存在');
  const size = statSync(cliPath).size;
  if (size < 1_000_000) die(`build 产物太小 (${size} bytes), 可能 build 没成功`);
  // atomic rename: dist.tmp → dist
  renameSync(distTmp, join(PROJECT_ROOT, 'dist'));
  log(`✅ Build 成功: dist/cli.js (${(size / 1024 / 1024).toFixed(2)} MB)`);
}

function packTgz(version) {
  log('📦 Packing tgz...');
  // 删所有 tgz, 避免 npm install -g 选错
  for (const f of readdirSync(PROJECT_ROOT)) {
    if (f.endsWith('.tgz')) {
      try { unlinkSync(join(PROJECT_ROOT, f)); } catch {}
    }
  }
  // npm pack
  execFileSync('npm', ['pack'], { stdio: 'inherit', cwd: PROJECT_ROOT });
  // 验证产物
  const tgz = `cc-linker-${version}.tgz`;
  const tgzPath = join(PROJECT_ROOT, tgz);
  if (!existsSync(tgzPath)) die(`${tgz} 生成失败 (npm pack 阶段)`);
  const size = statSync(tgzPath).size;
  log(`✅ Pack 成功: ${tgz} (${(size / 1024).toFixed(1)} KB)`);
  return tgz;
}

function installGlobal(tgz) {
  const localCli = join(PROJECT_ROOT, 'dist', 'cli.js');
  const globalCli = '/usr/local/lib/node_modules/cc-linker/dist/cli.js';
  const localSha = sha256(localCli);

  // 备份当前 global cli.js
  if (existsSync(globalCli)) {
    copyFileSync(globalCli, BACKUP_GLOBAL);
  }

  log('📦 Installing globally:', tgz);
  // --ignore-scripts: 避免触发 package.json postinstall (它会调 cc-linker restart),
  // 跟我们 deploy script 自己的 restart 逻辑竞争导致双重 restart
  execFileSync('npm', ['install', '-g', '--ignore-scripts', join(PROJECT_ROOT, tgz)], {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
  });

  // 3. sha256 验证
  if (!existsSync(globalCli)) die('install 后 global cli.js 不存在');
  const globalSha = sha256(globalCli);
  if (localSha !== globalSha) {
    logErr(`sha256 不匹配:`);
    logErr(`  local:  ${localSha}`);
    logErr(`  global: ${globalSha}`);
    // rollback
    if (existsSync(BACKUP_GLOBAL)) {
      copyFileSync(BACKUP_GLOBAL, globalCli);
      log('🔙 已 rollback 到 backup');
    }
    die('install 验证失败, deploy 终止', 1);
  }
  log(`✅ sha256 验证通过: ${localSha.slice(0, 12)}...`);
}

function findGlobalInstallDir() {
  try {
    const globalBin = execSync('which cc-linker', { encoding: 'utf8' }).trim();
    const realPath = execSync(`readlink -f "${globalBin}"`, { encoding: 'utf8' }).trim();
    return dirname(realPath);
  } catch {
    return null;
  }
}

function restartDaemon() {
  // 4. 用 launchctl unload/load 强制 launchd 重新读 binary
  // 比 cc-linker restart 可靠: 不靠 cache, 不与 postinstall 竞争
  if (!existsSync(PLIST)) {
    log(`⚠️  launchd plist 不存在 (${PLIST}), 跳过 restart, 用 cc-linker start --daemon`);
    execFileSync('cc-linker', ['start', '--daemon'], { stdio: 'inherit' });
    return;
  }

  const oldPid = existsSync(PID_FILE) ? parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10) : null;
  if (isRunning(oldPid)) {
    log(`🔄 launchctl unload (停止 daemon PID ${oldPid})...`);
    try {
      execFileSync('launchctl', ['unload', PLIST], { stdio: 'inherit' });
    } catch (e) {
      logErr(`launchctl unload 失败: ${e.message}`);
    }
    // 等 daemon exit (launchd unload 后会等几秒)
    const start = Date.now();
    while (isRunning(oldPid) && Date.now() - start < 15000) {
      // busy wait
      // eslint-disable-next-line no-undef
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (isRunning(oldPid)) {
      logErr(`daemon PID ${oldPid} 15s 后仍在跑, kill -9`);
      try { process.kill(oldPid, 'SIGKILL'); } catch {}
    }
  } else {
    log('ℹ️  daemon 未跑, 跳过 unload');
  }

  log('🔄 launchctl load (用新 binary 启 daemon)...');
  try {
    execFileSync('launchctl', ['load', PLIST], { stdio: 'inherit' });
  } catch (e) {
    // launchctl load 对已 loaded plist 返 "service already loaded" — 可接受
    log(`  (launchctl load: ${e.message.split('\n')[0]})`);
  }

  // 等 daemon 起来
  const start = Date.now();
  let newPid = null;
  while (Date.now() - start < 15000) {
    if (existsSync(PID_FILE)) {
      newPid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (isRunning(newPid)) break;
    }
    // eslint-disable-next-line no-undef
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  if (!newPid || !isRunning(newPid)) {
    die('daemon 15s 内未起来', 1);
  }
  log(`✅ Daemon 重启成功 (新 PID ${newPid})`);
}

function verifyNewVersion(version) {
  // 5. 验证 daemon 真的用新 binary 启了
  //    信号源 1: daemon 启动时间戳晚于 backup global cli.js 的 mtime
  //    (新 binary 替换后才可能启动)
  //    信号源 2: log 最新启动段 ("cc-linker daemon started") 时间戳
  if (!existsSync(LOG_FILE)) {
    log(`⚠️  ${LOG_FILE} 不存在, 跳过版本验证`);
    return;
  }
  // 等 daemon 写入启动 banner
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);

  const logContent = readFileSync(LOG_FILE, 'utf8');
  // 找最新 "cc-linker daemon started" 段
  const startedMatches = [...logContent.matchAll(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[INFO\] cc-linker daemon started/g)];
  if (startedMatches.length === 0) {
    logErr('daemon log 没找到 "cc-linker daemon started" 段');
    die('post-deploy 版本验证失败', 1);
  }
  const latestStartedAt = startedMatches[startedMatches.length - 1][1];
  // 跟 backup 的 mtime 比 (新 binary mtime > backup mtime)
  // 用 local time 格式跟 log 时间戳对齐 (log 是 local time, mtime.toISOString 是 UTC)
  let backupMtimeStr = 'N/A';
  if (existsSync(BACKUP_GLOBAL)) {
    const d = statSync(BACKUP_GLOBAL).mtime;
    const pad = (n) => String(n).padStart(2, '0');
    backupMtimeStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  log(`  daemon latest started: ${latestStartedAt}`);
  log(`  global cli.js backup mtime: ${backupMtimeStr}`);
  if (latestStartedAt < backupMtimeStr) {
    logErr(`daemon 在 backup 之前启动, 可能是旧 binary 启的`);
    logErr(`  started=${latestStartedAt} < backup=${backupMtimeStr}`);
    die('post-deploy 验证失败: daemon 用旧 binary 启了', 1);
  }
  // 附加检查: 当前跑的 daemon PID 的 process 启动时间晚于 backup mtime
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isRunning(pid)) {
      // 读 /proc/PID/stat 拿进程启动时间
      try {
        const out = execSync(`ps -p ${pid} -o lstart=`, { encoding: 'utf8' }).trim();
        // ps lstart 格式: "Sat Jun 13 20:34:01 2026"
        const daemonStartDate = new Date(out);
        const d = daemonStartDate;
        const pad = (n) => String(n).padStart(2, '0');
        const daemonStartStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        log(`  current daemon (PID ${pid}) lstart: ${daemonStartStr}`);
        if (daemonStartStr < backupMtimeStr) {
          logErr(`daemon 进程启动时间早于 backup, 是 launchd 用旧 binary 启的`);
          die('post-deploy 验证失败: launchd 用了旧 binary', 1);
        }
      } catch (e) { /* ps 命令失败, 跳过 */ }
    }
  }
  log(`✅ Post-deploy 验证: daemon ${latestStartedAt} 启动, 进程 lstart 晚于 backup mtime (新 binary)`);
}

function rollback() {
  const globalCli = '/usr/local/lib/node_modules/cc-linker/dist/cli.js';
  if (existsSync(BACKUP_GLOBAL)) {
    copyFileSync(BACKUP_GLOBAL, globalCli);
    log('🔙 Rollback 完成: 已恢复 backup');
  }
}

function cleanupBackup() {
  if (existsSync(BACKUP_GLOBAL)) {
    try { unlinkSync(BACKUP_GLOBAL); } catch {}
  }
}

// ============== MAIN ==============
try {
  acquireLock();

  const version = readPkgVersion();
  log(`📌 Target version: ${version}`);

  if (!SKIP_BUILD) {
    atomicBuild();
    const tgz = packTgz(version);
    installGlobal(tgz);
    // 装完 tgz 已无意义, 删掉 (留 dist/ 和 backup 即可)
    try { unlinkSync(join(PROJECT_ROOT, tgz)); } catch {}
  } else {
    log('⏭️  --skip-build 模式, 跳过 build + pack + install');
    if (!existsSync(join(PROJECT_ROOT, 'dist', 'cli.js'))) {
      die('skip-build 模式但 dist/cli.js 不存在, 跑一次 build:npm');
    }
  }

  // 清理旧 tgz (按用户建议, 任何残留 tgz 都可能干扰未来 deploy)
  for (const f of readdirSync(PROJECT_ROOT)) {
    if (f.endsWith('.tgz')) {
      try { unlinkSync(join(PROJECT_ROOT, f)); } catch {}
    }
  }

  // 决定要不要 restart
  const oldPid = existsSync(PID_FILE) ? parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10) : null;
  const running = isRunning(oldPid);

  if (!running && !FORCE) {
    log('ℹ️  Daemon 未跑, 跳过 restart');
    log('   启动 daemon: cc-linker start --daemon');
  } else {
    if (running) {
      log(`🔄 Restarting daemon (PID ${oldPid})...`);
    } else {
      log('🔄 Force mode: starting daemon...');
    }
    restartDaemon();
    verifyNewVersion(version);
  }

  cleanupBackup();
  log('✅ Deploy 完成');
  cleanup();
  process.exit(0);
} catch (e) {
  logErr(`Deploy 失败: ${e.message}`);
  if (e.stack) console.error(e.stack);
  rollback();
  cleanup();
  process.exit(1);
}

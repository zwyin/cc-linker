import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { userManager, listSnapshotManager, FeishuBot, FeishuMessageEvent, FeishuReplyFn, FeishuBotCardReplyFn, FeishuBotCardAction } from '../../feishu';
import { SpoolQueue } from '../../queue/spool';
import { StateCoordinator } from '../../runtime/state-coordinator';
import { startupReconcile } from '../../runtime/reconciler';
import { logger } from '../../utils/logger';
import { config } from '../../utils/config';
import { ProviderManager } from '../../utils/providers';
import { ClaudeSessionManager, cleanupOrphanProcesses } from '../../proxy/session';
import { SessionActivityCache, cleanupOldActivityLogs } from '../../utils/session-activity';
import { getClaudeProcessesByCwd } from '../../utils/process-info';
import { RUNTIME_PID_FILE, RUNTIME_LOG_FILE } from '../../utils/paths';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

export interface StartOptions {
  daemon?: boolean;
  noFeishu?: boolean;
}

export async function start(registry: RegistryManager, opts: StartOptions = {}): Promise<void> {
  // Daemon child process — runs the bot with log file redirection
  if (process.env.CC_LINKER_DAEMON === '1') {
    await startDaemonChild(registry, opts);
    return;
  }

  if (opts.daemon) {
    // Check for existing daemon
    if (isRunning()) {
      const pid = readPid();
      console.log(chalk.yellow(`⚠️  Bot 已在后台运行 (PID: ${pid})`));
      console.log(chalk.cyan(`   停止: cc-linker stop`));
      return;
    }
    await startDaemon();
    return;
  }

  // Check owner.lock for foreground mode
  const sc = new StateCoordinator();
  if (StateCoordinator.isLocked()) {
    console.log(chalk.red('❌ Bot 进程正在运行，请先执行 cc-linker stop'));
    process.exit(1);
  }

  await startForeground(registry, opts);
}

/** Check if daemon is running */
function isRunning(): boolean {
  if (!existsSync(RUNTIME_PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(RUNTIME_PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read PID from file */
function readPid(): number {
  return parseInt(readFileSync(RUNTIME_PID_FILE, 'utf8').trim(), 10);
}

/** Stop all cc-linker daemon processes */
export async function stop(): Promise<void> {
  let stopped = false;

  // 1. Stop launchd service if exists
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.cclinker.daemon.plist');
  if (existsSync(plistPath)) {
    try {
      spawnSync('launchctl', ['unload', plistPath]);
      console.log(chalk.green('✅ launchd 服务已停止'));
      stopped = true;
    } catch {}
  }

  // 2. Stop PID file process
  if (existsSync(RUNTIME_PID_FILE)) {
    const pid = readPid();
    console.log(chalk.cyan(`正在停止 Bot (PID: ${pid})...`));

    try {
      process.kill(pid, 'SIGTERM');
      stopped = true;

      // Wait for graceful shutdown (up to 15s)
      for (let i = 0; i < 30; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          console.log(chalk.green(`✅ Bot (PID: ${pid}) 已停止`));
          if (existsSync(RUNTIME_PID_FILE)) unlinkSync(RUNTIME_PID_FILE);
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }

      // Force kill if still running
      try {
        process.kill(pid, 0);
        console.log(chalk.yellow('⚠️  进程未响应，强制终止...'));
        process.kill(pid, 'SIGKILL');
        console.log(chalk.green(`✅ Bot (PID: ${pid}) 已强制停止`));
      } catch {}

      if (existsSync(RUNTIME_PID_FILE)) unlinkSync(RUNTIME_PID_FILE);
    } catch {
      console.log(chalk.yellow('⚠️  进程不存在，清理 PID 文件'));
      if (existsSync(RUNTIME_PID_FILE)) unlinkSync(RUNTIME_PID_FILE);
    }
  }

  // 3. Kill any remaining cc-linker processes
  try {
    const { execSync } = await import('child_process');
    const pids = execSync("pgrep -f 'cc-linker.*daemon' 2>/dev/null || true", { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);

    for (const pidStr of pids) {
      const p = parseInt(pidStr, 10);
      if (p && p !== process.pid) {
        try {
          process.kill(p, 'SIGKILL');
          console.log(chalk.yellow(`⚠️  终止残留进程 (PID: ${p})`));
          stopped = true;
        } catch {}
      }
    }
  } catch {}

  if (!stopped) {
    console.log(chalk.yellow('⚠️  Bot 未在后台运行'));
  }
}

/** Show daemon status */
export async function daemonStatus(): Promise<void> {
  if (!isRunning()) {
    console.log(chalk.yellow('Bot 未在后台运行'));
    return;
  }

  const pid = readPid();
  console.log(chalk.green(`✅ Bot 正在运行 (PID: ${pid})`));
  console.log(chalk.gray(`   日志: ${RUNTIME_LOG_FILE}`));
  console.log(chalk.gray(`   停止: cc-linker stop`));

  // Show last few log lines
  if (existsSync(RUNTIME_LOG_FILE)) {
    const log = readFileSync(RUNTIME_LOG_FILE, 'utf8');
    const lines = log.trim().split('\n').slice(-5);
    if (lines.length > 0) {
      console.log(chalk.cyan('\n最近日志:'));
      for (const line of lines) {
        console.log(chalk.gray(`   ${line}`));
      }
    }
  }
}

interface BotRuntime {
  bot: FeishuBot;
  wsClient: any;
  stateCoordinator: StateCoordinator;
  shutdown: (signal: string) => Promise<void>;
}

/**
 * Probe whether CLI process detection (via lsof) is permitted on this host.
 *
 * macOS often blocks `lsof` against other users' processes unless Full Disk
 * Access is granted to the running terminal/binary. When the probe fails we
 * fall back to marker + JSONL mtime detection only.
 *
 * Linux/other platforms: always returns true (procfs-based, no extra permissions).
 */
function probeCliProcessDetection(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    const procs = getClaudeProcessesByCwd(process.cwd());
    return procs.length > 0; // 能列出说明 lsof 没权限错
  } catch {
    return false;
  }
}

async function createBotRuntime(
  registry: RegistryManager,
  log: (level: string, msg: string) => void,
  wsLogLevel?: number,
): Promise<BotRuntime> {
  const spoolQueue = new SpoolQueue();
  const stateCoordinator = new StateCoordinator();
  let replyFn: FeishuReplyFn = async () => null;
  let cardReplyFn: FeishuBotCardReplyFn = async () => null;

  const providerManager = new ProviderManager();

  try {
    await providerManager.scan();
    const count = providerManager.list().length;
    const source = providerManager.getSource();
    log('INFO', `Provider scan complete: ${count} models found (source: ${source})`);
  } catch (err) {
    log('WARN', `Provider scan failed: ${err}`);
  }

  cleanupOrphanProcesses();

  // Step 3-5 (Task 6.2): create sessionManager + activityCache, inject cache, hand the
  // same sessionManager instance to FeishuBot so it does not fall back to the
  // module-level singleton (which would be missing the cache).
  const sessionManager = new ClaudeSessionManager();
  const activityCache = new SessionActivityCache();
  sessionManager.setActivityCache(activityCache);

  if (!stateCoordinator.tryAcquire()) {
    log('ERROR', '获取 owner.lock 失败，可能有其他实例正在运行');
    process.exit(1);
  }

  try {
    const result = await startupReconcile({
      registry,
      userManager,
      listSnapshotManager,
      spoolQueue,
    });
    log('INFO', `启动协调: ${result.recoveredProcessing} 恢复, ${result.rolledBackClaims} 回滚, ${result.mergedEvents} 事件归并`);
  } catch (err) {
    log('ERROR', `启动协调失败: ${err}`);
    stateCoordinator.release();
    process.exit(1);
  }

  const appId = config.get<string>('feishu_bot.app_id', '');
  const appSecret = config.get<string>('feishu_bot.app_secret', '');
  const ownerOpenId = config.get<string>('feishu_bot.owner_open_id', '');

  if (!ownerOpenId) {
    log('WARN', '⚠️  feishu_bot.owner_open_id 未配置！任何知道 Bot 的人都可以使用，可能存在严重安全风险');
  }

  let wsClient: any = null;
  let client: any = null;

  const bot = new FeishuBot({
    userManager,
    listSnapshotManager,
    spoolQueue,
    registry,
    providerManager,
    sessionManager,
    replyFn,
    cardReplyFn,
    feishuClient: client,
  });

  if (!appId || !appSecret) {
    log('WARN', '飞书 App ID/Secret 未配置，跳过 WSClient 连接');
  } else {
    const larkSdk = await import('@larksuiteoapi/node-sdk');
    const { WSClient, Client, Domain, LoggerLevel, EventDispatcher } = larkSdk;
    client = new Client({
      appId,
      appSecret,
      domain: Domain.Feishu,
    });

    replyFn = async (
      text: string,
      options?: { openId?: string; requestUuid?: string },
    ): Promise<string | null> => {
      const openId = options?.openId;
      if (!openId) {
        log('WARN', `[replyFn] 缺少 openId，跳过发送`);
        return null;
      }

      try {
        const response = await client.im.v1.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: openId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
            uuid: options?.requestUuid,
          },
        });

        const messageId = response.data?.message_id;
        if (!messageId) {
          log('WARN', `[replyFn] API 返回成功但 message_id 为空: ${JSON.stringify(response)}`);
        } else {
          log('DEBUG', `[replyFn] 发送成功: message_id=${messageId}, uuid=${options?.requestUuid}`);
        }
        return messageId ?? null;
      } catch (err: any) {
        log('ERROR', `[replyFn] 发送消息失败: ${err?.message ?? err}, openId=${openId}, uuid=${options?.requestUuid}`);
        return null;
      }
    };
    bot.setReplyFn(replyFn);

    cardReplyFn = async (
      card: Record<string, unknown>,
      options?: { openId?: string; messageId?: string },
    ): Promise<string | null> => {
      const openId = options?.openId;
      if (!openId) {
        log('WARN', `[cardReplyFn] 缺少 openId，跳过发送卡片`);
        return null;
      }

      try {
        const response = await client.im.v1.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: openId,
            msg_type: 'interactive',
            content: JSON.stringify(card),
            uuid: options?.messageId ? `card-${options.messageId}` : undefined,
          },
        });

        const messageId = response.data?.message_id;
        if (!messageId) {
          log('WARN', `[cardReplyFn] API 返回成功但 message_id 为空: ${JSON.stringify(response)}`);
        } else {
          log('DEBUG', `[cardReplyFn] 卡片发送成功: message_id=${messageId}`);
        }
        return messageId ?? null;
      } catch (err: any) {
        log('ERROR', `[cardReplyFn] 发送卡片失败: ${err?.message ?? err}, openId=${openId}`);
        return null;
      }
    };
    bot.setCardReplyFn(cardReplyFn);

    bot.setFeishuClient(client);

    const eventDispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        try {
          const msg = data?.message;
          if (!msg) return;

          const sender = data?.sender;
          const openId = sender?.sender_id?.open_id ?? '';

          const event: FeishuMessageEvent = {
            open_id: openId,
            message_id: msg.message_id,
            content: msg.content ?? '{}',
            chat_type: msg.chat_type,
            message_type: msg.message_type,
          };

          await bot.onMessage(event);
        } catch (err) {
          log('ERROR', `处理飞书消息失败: ${err}`);
        }
      },
      'card.action.trigger': async (data: any) => {
        try {
          const openId = data?.open_id ?? data?.operator?.open_id ?? data?.event?.operator?.open_id ?? data?.callback?.open_id ?? '';
          const messageId = data?.open_message_id ?? data?.context?.open_message_id ?? data?.event?.context?.open_message_id ?? data?.callback?.message?.message_id ?? '';
          const actionValue = data?.action?.value ?? data?.event?.action?.value ?? data?.callback?.action?.value ?? {};

          // Detect permission card buttons (use 'type' field instead of 'tag')
          const isPermissionAction = actionValue?.type === 'permission_approve' || actionValue?.type === 'permission_deny';
          const tag = isPermissionAction ? actionValue.type : (actionValue?.tag ?? '');
          const sessionId = actionValue?.sessionId ?? actionValue?.value ?? '';

          // For permission buttons, pass the full actionValue object as value
          // so handleCardAction can extract index and type from it
          const actionPayload: string | Record<string, unknown> = isPermissionAction ? actionValue : sessionId;

          const action: FeishuBotCardAction = {
            open_id: openId,
            action: { tag, value: actionPayload },
            message: { message_id: messageId },
          };

          log('INFO', `[card callback] tag=${tag}, sessionId=${sessionId}, openId=${openId}, messageId=${messageId || '(empty)'}`);
          const reply = await bot.handleCardAction(action);
          const replyStr = typeof reply === 'string' ? reply : JSON.stringify(reply).slice(0, 80);
          log('INFO', `[card callback] reply=${reply ? replyStr : 'null'}`);

          // If handleCardAction returns a card object, return it directly.
          // The SDK will base64-encode it and send it back via WebSocket.
          if (reply && typeof reply === 'object') {
            return reply;
          }

          // For non-permission actions, return empty response
          return { type: 'raw' as const, data: {} };
        } catch (err) {
          log('ERROR', `处理卡片回调失败: ${err}`);
          return { type: 'raw' as const, data: { code: 0 } };
        }
      },
    });

    wsClient = new WSClient({
      appId,
      appSecret,
      domain: Domain.Feishu,
      loggerLevel: wsLogLevel ?? LoggerLevel.info,
      autoReconnect: true,
      onReady: () => {
        log('INFO', '飞书 WebSocket 连接已建立');
      },
      onError: (err: Error) => {
        log('ERROR', `WSClient 错误: ${err.message}`);
      },
      onReconnecting: () => {
        log('WARN', '飞书 WebSocket 重连中...');
      },
      onReconnected: () => {
        log('INFO', '飞书 WebSocket 重连成功');
      },
    });

    wsClient.start({ eventDispatcher });
  }

  const shutdown = async (_signal: string) => {
    if (wsClient && typeof wsClient.close === 'function') {
      try { wsClient.close(); } catch {}
    }
    bot.requestStop();
    if (bot.isRunning()) {
      const deadline = Date.now() + 10_000;
      while (bot.isRunning() && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    stateCoordinator.release();
  };

  return { bot, wsClient, stateCoordinator, shutdown };
}

async function startForeground(registry: RegistryManager, opts: StartOptions): Promise<void> {
  console.log(chalk.blue('🚀 启动 cc-linker...'));

  // Step 1: 探测 CLI 进程检测可用性
  const cliDetectionOk = probeCliProcessDetection();
  if (!cliDetectionOk) {
    logger.warn('CLI 进程检测不可用（macOS 权限），将只使用 marker + mtime 检测');
    config.setRuntimeOverride('runtime.cli_process_detection_enabled', false);
  }

  // Step 2: 清理过期 activity 日志
  const cleaned = cleanupOldActivityLogs(24);
  logger.info(`清理过期 activity 日志: ${cleaned} 个文件`);

  // Step 3-5: 创建 cache + sessionManager + bot 在 createBotRuntime / Task 6.2 中接入
  // (SessionActivityCache 由 Task 6.2 注入到 sessionManager / FeishuBot)

  // Step 6: Grace period（避免升级期间老 daemon 残留导致误判）
  logger.info('活跃检测 grace period: 30 秒');
  await new Promise<void>(resolve => setTimeout(resolve, 30_000));

  const { bot, stateCoordinator, shutdown } = await createBotRuntime(registry, (level, msg) => {
    if (level === 'ERROR') {
      console.error(chalk.red(msg));
      logger.error(msg);
    } else if (level === 'WARN') {
      console.log(chalk.yellow(msg));
      logger.warn(msg);
    } else if (level === 'DEBUG') {
      logger.debug(msg);
    } else {
      console.log(msg);
      logger.info(msg);
    }
  });

  console.log(chalk.green('✅ cc-linker 已启动'));

  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.yellow(`\n收到 ${signal}，优雅停机中...`));
    await shutdown(signal);
    logger.info('cc-linker 已停止');
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  const dispatchLoop = async () => {
    while (!shuttingDown) {
      await bot.dispatch();
      await new Promise(r => setTimeout(r, 2000));
    }
  };

  await dispatchLoop();
}

async function startDaemonChild(registry: RegistryManager, opts: StartOptions): Promise<void> {
  const pid = process.pid;

  mkdirSync(dirname(RUNTIME_PID_FILE), { recursive: true });
  writeFileSync(RUNTIME_PID_FILE, String(pid), { mode: 0o600 });

  const logStream = Bun.file(RUNTIME_LOG_FILE).writer();
  const { formatLocalTime } = await import('../../utils/logger');
  const log = (level: string, msg: string) => {
    logStream.write(`[${formatLocalTime()}] [${level}] ${msg}\n`);
  };

  console.log = (...args: any[]) => log('INFO', args.join(' '));
  console.error = (...args: any[]) => log('ERROR', args.join(' '));

  log('INFO', `Daemon child started (PID: ${pid})`);
  process.on('SIGHUP', () => {});

  let shuttingDown = false;
  const baseShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', `收到 ${signal}，优雅停机中...`);
    try { const sc = new StateCoordinator(); sc.release(); } catch {}
    try { if (existsSync(RUNTIME_PID_FILE)) unlinkSync(RUNTIME_PID_FILE); } catch {}
    log('INFO', 'cc-linker 已停止');
    process.exit(0);
  };

  process.on('SIGTERM', () => baseShutdown('SIGTERM'));
  process.on('SIGINT', () => baseShutdown('SIGINT'));

  const { bot, shutdown } = await createBotRuntime(registry, log);

  log('INFO', 'cc-linker daemon started');

  const daemonShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', `收到 ${signal}，优雅停机中...`);
    await shutdown(signal);
    try { if (existsSync(RUNTIME_PID_FILE)) unlinkSync(RUNTIME_PID_FILE); } catch {}
    log('INFO', 'cc-linker 已停止');
    process.exit(0);
  };

  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  process.on('SIGTERM', () => daemonShutdown('SIGTERM'));
  process.on('SIGINT', () => daemonShutdown('SIGINT'));

  const dispatchLoop = async () => {
    while (!shuttingDown) {
      await bot.dispatch();
      await new Promise(r => setTimeout(r, 2000));
    }
  };

  await dispatchLoop();
}

/** Resolve the cc-linker executable path */
function getExecutablePath(): string {
  const argv0 = process.argv[0];
  // If compiled binary, argv[0] IS the binary
  if (argv0.endsWith('cc-linker')) return argv0;

  const scriptPath = process.argv[1] || '';

  // When running from a globally-installed npm package (e.g. inside
  // node_modules/cc-linker/dist/cli.js), always use the command in PATH.
  // Bun resolves symlinks, so scriptPath will be the real file path.
  if (scriptPath.includes('node_modules')) {
    return 'cc-linker';
  }

  // When running via global symlink (e.g. /usr/local/bin/cc-linker),
  // before Bun resolves it.
  if (scriptPath.endsWith('/cc-linker') || scriptPath === 'cc-linker') {
    return 'cc-linker';
  }

  // Development (bun run src/index.ts): try dist/cc-linker relative to script
  const scriptDir = dirname(scriptPath);
  const distPath = join(scriptDir, '..', 'dist', 'cc-linker');
  if (existsSync(distPath)) return distPath;

  // Fallback: assume 'cc-linker' is in PATH
  return 'cc-linker';
}

/** Parent process: spawns detached child and exits */
async function startDaemon(): Promise<void> {
  const { spawn } = await import('child_process');
  const exe = getExecutablePath();
  // For compiled binaries, argv[1] is the internal script path (/$bunfs/root/cc-linker),
  // not a CLI argument. Use slice(2) to get actual CLI args.
  const args = process.argv.slice(2);
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CC_LINKER_DAEMON: '1' },
  });
  child.unref();

  // Wait briefly for PID file
  await new Promise(r => setTimeout(r, 1500));

  if (!existsSync(RUNTIME_PID_FILE)) {
    console.log(chalk.red('❌ 后台启动失败'));
    process.exit(1);
  }

  const pid = readPid();
  console.log(chalk.green(`✅ cc-linker 已在后台启动 (PID: ${pid})`));
  console.log(chalk.cyan(`   日志: ${RUNTIME_LOG_FILE}`));
  console.log(chalk.cyan(`   停止: cc-linker stop`));
  console.log(chalk.cyan(`   状态: cc-linker daemon status`));
  process.exit(0);
}

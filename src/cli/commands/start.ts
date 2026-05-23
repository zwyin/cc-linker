import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { userManager, listSnapshotManager, FeishuBot, FeishuMessageEvent, FeishuReplyFn, FeishuBotCardReplyFn, FeishuBotCardAction } from '../../feishu';
import { SpoolQueue } from '../../queue/spool';
import { StateCoordinator } from '../../runtime/state-coordinator';
import { startupReconcile } from '../../runtime/reconciler';
import { logger } from '../../utils/logger';
import { config } from '../../utils/config';
import { cleanupOrphanProcesses } from '../../proxy/session';
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
  if (process.env.CC_BRIDGE_DAEMON === '1') {
    await startDaemonChild(registry, opts);
    return;
  }

  if (opts.daemon) {
    // Check for existing daemon
    if (isRunning()) {
      const pid = readPid();
      console.log(chalk.yellow(`⚠️  Bot 已在后台运行 (PID: ${pid})`));
      console.log(chalk.cyan(`   停止: cc-bridge stop`));
      return;
    }
    await startDaemon();
    return;
  }

  // Check owner.lock for foreground mode
  const sc = new StateCoordinator();
  if (StateCoordinator.isLocked()) {
    console.log(chalk.red('❌ Bot 进程正在运行，请先执行 cc-bridge stop'));
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

/** Stop all cc-bridge daemon processes */
export async function stop(): Promise<void> {
  let stopped = false;

  // 1. Stop launchd service if exists
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.ccbridge.daemon.plist');
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

  // 3. Kill any remaining cc-bridge processes
  try {
    const { execSync } = await import('child_process');
    const pids = execSync("pgrep -f 'cc-bridge.*daemon' 2>/dev/null || true", { encoding: 'utf8' })
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
  console.log(chalk.gray(`   停止: cc-bridge stop`));

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

async function startForeground(registry: RegistryManager, opts: StartOptions): Promise<void> {
  console.log(chalk.blue('🚀 启动 cc-bridge...'));

  // 1. Initialize modules (use singletons for shared state across modules)
  const spoolQueue = new SpoolQueue();
  const stateCoordinator = new StateCoordinator();
  let replyFn: FeishuReplyFn = async () => null;
  let cardReplyFn: FeishuBotCardReplyFn = async () => null;

  // 2. Cleanup orphan processes on startup
  cleanupOrphanProcesses();

  // 3. Acquire owner lock
  if (!stateCoordinator.tryAcquire()) {
    console.log(chalk.red('❌ 获取 owner.lock 失败，可能有其他实例正在运行'));
    process.exit(1);
  }

  // 4. Startup reconciliation
  try {
    const result = await startupReconcile({
      registry,
      userManager,
      listSnapshotManager,
      spoolQueue,
    });
    console.log(chalk.green(`✅ 启动协调: ${result.recoveredProcessing} 恢复, ${result.rolledBackClaims} 回滚, ${result.mergedEvents} 事件归并`));
  } catch (err) {
    console.error(chalk.red(`启动协调失败: ${err}`));
    stateCoordinator.release();
    process.exit(1);
  }

  // 6. Wire up WSClient (C4: Feishu WebSocket long connection)
  const appId = config.get<string>('feishu_bot.app_id', '');
  const appSecret = config.get<string>('feishu_bot.app_secret', '');

  let wsClient: any = null;
  let client: any = null;

  // 5. Initialize Feishu Bot (feishuClient will be null if not yet configured)
  const bot = new FeishuBot({
    userManager,
    listSnapshotManager,
    spoolQueue,
    registry,
    replyFn,
    cardReplyFn,
    feishuClient: client,
  });

  if (!appId || !appSecret) {
    console.log(chalk.yellow('⚠️ 飞书 App ID/Secret 未配置，跳过 WSClient 连接'));
    console.log(chalk.cyan('请在 config.toml 中配置 [feishu_bot] app_id 和 app_secret'));
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

    // Set the Feishu client for streaming card updates
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
          logger.error(`处理飞书消息失败: ${err}`);
        }
      },
      'card.action.trigger': async (data: any) => {
        try {
          const openId = data?.open_id ?? data?.operator?.open_id ?? data?.callback?.open_id ?? '';
          const messageId = data?.open_message_id ?? data?.context?.open_message_id ?? data?.callback?.message?.message_id ?? '';
          const actionValue = data?.action?.value ?? data?.callback?.action?.value ?? {};
          const tag = actionValue?.tag ?? '';
          const sessionId = actionValue?.sessionId ?? actionValue?.value ?? '';

          const action: FeishuBotCardAction = {
            open_id: openId,
            action: { tag, value: sessionId },
            message: { message_id: messageId },
          };

          logger.info(`[card callback] tag=${tag}, sessionId=${sessionId}, openId=${openId}`);
          const reply = await bot.handleCardAction(action);
          logger.info(`[card callback] reply=${reply ? reply.slice(0, 80) : 'null'}`);

          // Return success response to Feishu. The feedback message is already
          // sent via replyFn inside handleCardAction.
          return { type: 'raw' as const, data: { code: 0 } };
        } catch (err) {
          logger.error(`处理卡片回调失败: ${err}`);
          return { type: 'raw' as const, data: { code: 0 } };
        }
      },
    });

    wsClient = new WSClient({
      appId,
      appSecret,
      domain: Domain.Feishu,
      loggerLevel: LoggerLevel.info,
      autoReconnect: true,
      onReady: () => {
        console.log(chalk.green('✅ 飞书 WebSocket 连接已建立'));
      },
      onError: (err: Error) => {
        logger.error(`WSClient 错误: ${err.message}`);
      },
      onReconnecting: () => {
        console.log(chalk.yellow('飞书 WebSocket 重连中...'));
      },
      onReconnected: () => {
        console.log(chalk.green('飞书 WebSocket 重连成功'));
      },
    });

    // Start WSClient with event dispatcher (official SDK API)
    wsClient.start({ eventDispatcher });
  }

  console.log(chalk.green('✅ cc-bridge 已启动'));

  // C3: Graceful shutdown sequence — signal stop, drain in-flight, release lock
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.yellow(`\n收到 ${signal}，优雅停机中...`));

    // Step 1: Stop WSClient
    if (wsClient && typeof wsClient.close === 'function') {
      try { wsClient.close(); } catch {}
    }

    // Step 2: Stop accepting new messages
    bot.requestStop();

    // Step 3: Wait for in-flight dispatch to complete (up to 10s)
    if (bot.isRunning()) {
      logger.info('等待进行中任务完成...');
      const deadline = Date.now() + 10_000;
      while (bot.isRunning() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Step 4: Release lock
    stateCoordinator.release();
    logger.info('cc-bridge 已停止');
    process.exit(0);
  };

  process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
  process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });

  // Periodic dispatch loop (every 2s) — processes spool queue
  const dispatchLoop = async () => {
    while (!shuttingDown) {
      await bot.dispatch();
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  };

  await dispatchLoop();
}

async function startDaemonChild(registry: RegistryManager, opts: StartOptions): Promise<void> {
  const pid = process.pid;

  // Write PID file
  mkdirSync(dirname(RUNTIME_PID_FILE), { recursive: true });
  writeFileSync(RUNTIME_PID_FILE, String(pid), { mode: 0o600 });

  // Create log stream and redirect console output
  const logStream = Bun.file(RUNTIME_LOG_FILE).writer();
  const { formatLocalTime } = await import('../../utils/logger');
  const log = (level: string, msg: string) => {
    logStream.write(`[${formatLocalTime()}] [${level}] ${msg}\n`);
  };

  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: any[]) => log('INFO', args.join(' '));
  console.error = (...args: any[]) => log('ERROR', args.join(' '));

  log('INFO', `Daemon child started (PID: ${pid})`);

  // Ignore SIGHUP (terminal disconnect)
  process.on('SIGHUP', () => {});

  // Graceful shutdown — release lock, clean PID file
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', `收到 ${signal}，优雅停机中...`);

    try {
      const sc = new StateCoordinator();
      sc.release();
    } catch {}

    try {
      if (existsSync(RUNTIME_PID_FILE)) unlinkSync(RUNTIME_PID_FILE);
    } catch {}

    log('INFO', 'cc-bridge 已停止');
    process.exit(0);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Now run the full foreground bot logic
  log('INFO', 'Starting bot...');

  const spoolQueue = new SpoolQueue();
  const stateCoordinator = new StateCoordinator();
  let replyFn: FeishuReplyFn = async () => null;
  let cardReplyFn: FeishuBotCardReplyFn = async () => null;

  cleanupOrphanProcesses();

  if (!stateCoordinator.tryAcquire()) {
    log('ERROR', 'Failed to acquire owner.lock');
    process.exit(1);
  }

  try {
    const result = await startupReconcile({
      registry,
      userManager,
      listSnapshotManager,
      spoolQueue,
    });
    log('INFO', `Startup reconcile: ${result.recoveredProcessing} recovered, ${result.rolledBackClaims} claims rolled back, ${result.mergedEvents} events merged`);
  } catch (err) {
    log('ERROR', `Startup reconcile failed: ${err}`);
    stateCoordinator.release();
    process.exit(1);
  }

  const appId = config.get<string>('feishu_bot.app_id', '');
  const appSecret = config.get<string>('feishu_bot.app_secret', '');

  let wsClient: any = null;
  let client: any = null;

  const bot = new FeishuBot({
    userManager,
    listSnapshotManager,
    spoolQueue,
    registry,
    replyFn,
    cardReplyFn,
    feishuClient: client,
  });

  if (!appId || !appSecret) {
    log('WARN', 'Feishu App ID/Secret not configured');
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

    // Set the Feishu client for streaming card updates
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
          logger.error(`处理飞书消息失败: ${err}`);
        }
      },
      'card.action.trigger': async (data: any) => {
        try {
          const openId = data?.open_id ?? data?.operator?.open_id ?? data?.callback?.open_id ?? '';
          const messageId = data?.open_message_id ?? data?.context?.open_message_id ?? data?.callback?.message?.message_id ?? '';
          const actionValue = data?.action?.value ?? data?.callback?.action?.value ?? {};
          const tag = actionValue?.tag ?? '';
          const sessionId = actionValue?.sessionId ?? actionValue?.value ?? '';

          const action: FeishuBotCardAction = {
            open_id: openId,
            action: { tag, value: sessionId },
            message: { message_id: messageId },
          };

          log('INFO', `[card callback] tag=${tag}, sessionId=${sessionId}, openId=${openId}`);
          const reply = await bot.handleCardAction(action);
          log('INFO', `[card callback] reply=${reply ? reply.slice(0, 80) : 'null'}`);

          return { type: 'raw' as const, data: { code: 0 } };
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
      loggerLevel: LoggerLevel.warn,
      autoReconnect: true,
      onReady: () => {
        log('INFO', 'Feishu WebSocket connected');
      },
      onError: (err: Error) => {
        log('ERROR', `WSClient error: ${err.message}`);
      },
      onReconnecting: () => {
        log('WARN', 'WSClient reconnecting...');
      },
      onReconnected: () => {
        log('INFO', 'WSClient reconnected');
      },
    });

    wsClient.start({ eventDispatcher });
  }

  log('INFO', 'cc-bridge daemon started');

  // Override gracefulShutdown to also stop WSClient and bot
  const daemonShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', `收到 ${signal}，优雅停机中...`);

    if (wsClient && typeof wsClient.close === 'function') {
      try { wsClient.close(); } catch {}
    }
    bot.requestStop();

    if (bot.isRunning()) {
      const deadline = Date.now() + 10_000;
      while (bot.isRunning() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    stateCoordinator.release();
    try {
      if (existsSync(RUNTIME_PID_FILE)) unlinkSync(RUNTIME_PID_FILE);
    } catch {}

    log('INFO', 'cc-bridge 已停止');
    process.exit(0);
  };

  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  process.on('SIGTERM', () => daemonShutdown('SIGTERM'));
  process.on('SIGINT', () => daemonShutdown('SIGINT'));

  // Periodic dispatch loop (every 2s)
  const dispatchLoop = async () => {
    while (!shuttingDown) {
      await bot.dispatch();
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  };

  await dispatchLoop();
}

/** Resolve the cc-bridge executable path */
function getExecutablePath(): string {
  const argv0 = process.argv[0];
  // If compiled binary, argv[0] IS the binary
  if (argv0.endsWith('cc-bridge')) return argv0;

  // Development (bun run): try dist/cc-bridge relative to CWD
  const distPath = join(process.cwd(), 'dist', 'cc-bridge');
  if (existsSync(distPath)) return distPath;

  // Fallback: assume 'cc-bridge' is in PATH
  return 'cc-bridge';
}

/** Parent process: spawns detached child and exits */
async function startDaemon(): Promise<void> {
  const { spawn } = await import('child_process');
  const exe = getExecutablePath();
  // For compiled binaries, argv[1] is the internal script path (/$bunfs/root/cc-bridge),
  // not a CLI argument. Use slice(2) to get actual CLI args.
  const args = process.argv.slice(2);
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CC_BRIDGE_DAEMON: '1' },
  });
  child.unref();

  // Wait briefly for PID file
  await new Promise(r => setTimeout(r, 1500));

  if (!existsSync(RUNTIME_PID_FILE)) {
    console.log(chalk.red('❌ 后台启动失败'));
    process.exit(1);
  }

  const pid = readPid();
  console.log(chalk.green(`✅ cc-bridge 已在后台启动 (PID: ${pid})`));
  console.log(chalk.cyan(`   日志: ${RUNTIME_LOG_FILE}`));
  console.log(chalk.cyan(`   停止: cc-bridge stop`));
  console.log(chalk.cyan(`   状态: cc-bridge daemon status`));
  process.exit(0);
}

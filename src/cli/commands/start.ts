import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { UserManager, ListSnapshotManager, FeishuBot, FeishuMessageEvent } from '../../feishu';
import { SpoolQueue } from '../../queue/spool';
import { StateCoordinator } from '../../runtime/state-coordinator';
import { startupReconcile } from '../../runtime/reconciler';
import { logger } from '../../utils/logger';
import { config } from '../../utils/config';
import { cleanupOrphanProcesses } from '../../proxy/session';

export async function start(registry: RegistryManager): Promise<void> {
  console.log(chalk.blue('🚀 启动 cc-bridge...'));

  // 1. Initialize modules
  const userManager = new UserManager();
  const listSnapshotManager = new ListSnapshotManager();
  const spoolQueue = new SpoolQueue();
  const stateCoordinator = new StateCoordinator();

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

  // 5. Initialize Feishu Bot
  const bot = new FeishuBot({
    userManager,
    listSnapshotManager,
    spoolQueue,
  });

  // 6. Wire up WSClient (C4: Feishu WebSocket long connection)
  const appId = config.get<string>('feishu_bot.app_id', '');
  const appSecret = config.get<string>('feishu_bot.app_secret', '');

  let wsClient: any = null;

  if (!appId || !appSecret) {
    console.log(chalk.yellow('⚠️ 飞书 App ID/Secret 未配置，跳过 WSClient 连接'));
    console.log(chalk.cyan('请在 config.toml 中配置 [feishu_bot] app_id 和 app_secret'));
  } else {
    const larkSdk = await import('@larksuiteoapi/node-sdk');
    const { WSClient, Domain, LoggerLevel, EventDispatcher, Client } = larkSdk;

    // Create event handler for im.message.receive_v1
    const eventDispatcher = new EventDispatcher({});

    eventDispatcher.register({
      event: 'im.message.receive_v1',
      handle: async (data: any) => {
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

    // Wire event dispatcher to WSClient's internal event handling
    // The SDK internally dispatches events through handleEventData
    // We intercept by patching the handler
    const originalHandleEventData = wsClient.handleEventData.bind(wsClient);
    wsClient.handleEventData = async (data: any) => {
      await eventDispatcher.invoke(data);
      return originalHandleEventData(data);
    };

    // Start WSClient
    wsClient.start();
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

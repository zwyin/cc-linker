import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { UserManager, ListSnapshotManager, FeishuBot } from '../../feishu';
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
  // Note: WSClient integration pending — in production, wire WSClient.onMessage → bot.onMessage
  const bot = new FeishuBot({
    userManager,
    listSnapshotManager,
    spoolQueue,
  });

  console.log(chalk.green('✅ cc-bridge 已启动'));
  console.log(chalk.cyan('等待飞书消息...'));

  // C3: Graceful shutdown sequence — signal stop, drain in-flight, release lock
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.yellow(`\n收到 ${signal}，优雅停机中...`));

    // Step 1: Stop accepting new messages
    bot.requestStop();

    // Step 2: Wait for in-flight dispatch to complete (up to 10s)
    if (bot.isRunning()) {
      logger.info('等待进行中任务完成...');
      const deadline = Date.now() + 10_000;
      while (bot.isRunning() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Step 3: Release lock
    stateCoordinator.release();
    logger.info('cc-bridge 已停止');
    process.exit(0);
  };

  process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
  process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });

  // Periodic dispatch loop (every 2s)
  const dispatchLoop = async () => {
    while (!shuttingDown) {
      await bot.dispatch();
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  };

  await dispatchLoop();
}

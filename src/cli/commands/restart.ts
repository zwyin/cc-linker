import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { start, stop, StartOptions } from './start';
import { isDaemonRunning } from './init-feishu';

export interface RestartDeps {
  isDaemonRunning: () => boolean;
  stop: () => Promise<void>;
  start: (registry: RegistryManager, opts: StartOptions) => Promise<void>;
}

export async function restart(
  registry: RegistryManager,
  deps: RestartDeps = { isDaemonRunning, stop, start },
): Promise<void> {
  const wasRunning = deps.isDaemonRunning();

  if (wasRunning) {
    console.log(chalk.cyan('🔄 正在重启 cc-linker...'));
    await deps.stop();
    console.log(chalk.gray('  等待进程完全停止...'));
    await new Promise(r => setTimeout(r, 1500));
  } else {
    console.log(chalk.cyan('🚀 Bot 未运行，直接启动...'));
  }

  await deps.start(registry, { daemon: true });
}

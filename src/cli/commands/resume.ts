import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { SPOOL_PROCESSING_DIR } from '../../utils/paths';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { CCLinkerError } from '../../utils/errors';
import { formatOrigin, formatTimeAgo } from '../output';
import { CLAUDE_PROJECTS_DIR } from '../../utils/paths';
import { StateCoordinator } from '../../runtime/state-coordinator';
import { config } from '../../utils/config';
import { repairJsonlLastPrompt } from '../../utils/jsonl-repair';
import { isSessionActive, SessionActivityCache } from '../../utils/session-activity';
import { logger } from '../../utils/logger';

interface ResumeOptions {
  search?: string;
  latest?: boolean;
  project?: string;
  dryRun?: boolean;
  confirm?: boolean;
  cwd?: string;
  force?: boolean;
}

// 状态错误码映射
const STATUS_ERRORS: Record<string, { code: string; message: string }> = {
  provisioning: { code: 'E011', message: '会话仍在创建中，请稍后重试' },
  degraded: { code: 'E010', message: '会话处于降级状态' },
  corrupted: { code: 'E012', message: '会话已损坏，无法恢复' },
};

export async function resume(registry: RegistryManager, target?: string, opts: ResumeOptions = {}): Promise<void> {
  let uuid: string;

  if (opts.latest) {
    uuid = findLatestSession(registry, opts.project);
  } else if (opts.search) {
    uuid = await searchAndSelect(registry, opts.search);
  } else if (target) {
    const match = registry.findByPrefix(target);
    if (!match) {
      const count = Object.keys(registry.sessions).filter(u => u.startsWith(target)).length;
      if (count > 1) {
        throw new CCLinkerError('E006', `前缀 "${target}" 匹配到 ${count} 个会话，请输入更长的前缀`);
      }
      throw new CCLinkerError('E002', `未找到匹配 "${target}" 的会话`);
    }
    uuid = match[0];
  } else {
    uuid = await interactiveSelect(registry);
  }

  let entry = registry.get(uuid);
  if (!entry) throw new CCLinkerError('E002', '会话不存在');

  entry = await attemptRepairSession(registry, uuid, entry);

  // 状态检测
  const status = entry.status ?? 'active';
  if (status === 'archived') {
    // archived 会话允许恢复
  } else if (status in STATUS_ERRORS) {
    const err = STATUS_ERRORS[status];
    let msg = err.message;
    if (status === 'degraded' && entry.last_error) {
      msg += `, 原因: ${entry.last_error}`;
    }
    throw new CCLinkerError(err.code as any, msg);
  }

  // 统一检查：bot 处理中（spool busy） + 飞书侧活跃（marker）
  // 任一为真就提示用户一次
  if (opts.force) {
    // --force: 跳过所有冲突检查，仅打印信息
    if (isSessionBusy(uuid)) {
      console.log(chalk.yellow(`⚠️ 会话 ${uuid.slice(0, 8)} 正在被 Bot 处理，--force 跳过冲突警告`));
    } else {
      console.log(chalk.yellow(`⚠️ --force 跳过飞书侧活跃检测`));
    }
  } else {
    // 综合检测：先看 bot 是否正在处理；再看飞书 marker
    const busy = isSessionBusy(uuid);
    let feishuStatus: { isProcessing: boolean; reason: string; confidence: string } | null = null;

    if (!busy) {
      try {
        const activityCache = new SessionActivityCache();
        const currentEntry = registry.get(uuid);
        if (currentEntry) {
          const result = await isSessionActive(
            { sessionUuid: uuid, cwd: currentEntry.cwd, jsonl_path: currentEntry.jsonl_path },
            activityCache,
            'cli-detects-feishu',
          );
          if (result.isProcessing) {
            feishuStatus = { isProcessing: true, reason: result.reason, confidence: result.confidence };
          }
        }
      } catch (err) {
        logger.warn(`飞书侧活跃检测失败: ${err}`);
        // 降级：视为不活跃，不阻止
      }
    }

    if (busy || feishuStatus) {
      // 风险提示：与飞书侧卡片文案对齐
      let reason: string;
      if (busy) {
        reason = '飞书 Bot 正在处理此会话的消息';
      } else {
        const ago = feishuStatus!.reason.match(/(\d+)s_ago/)?.[1] ?? '?';
        const strength = feishuStatus!.confidence === 'high' ? '正在' : '可能正在';
        reason = `${strength}被飞书 Bot 处理中（${ago} 秒前活跃）`;
      }

      console.log(chalk.yellow(`\n⚠️  风险提示：会话 ${uuid.slice(0, 8)} ${reason}。`));
      console.log(chalk.yellow('   强制 resume **不会**中断飞书任务，而是让 CLI 侧**同时** resume 同一会话。'));
      console.log(chalk.yellow('   可能后果：两端 JSONL 写入冲突、上下文历史不一致。'));
      console.log('');

      const { confirmed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: chalk.red('⚠️ 我了解风险，仍要强制 resume？'),
        default: false,
      }]);
      if (!confirmed) return;
    } else if (StateCoordinator.isLocked()) {
      // Bot 跑着但此 session 不活跃 + marker 不活跃 → 安全
      console.log(chalk.dim('Bot 正在运行，但此会话未被处理，可安全恢复'));
    }
  }

  // Verify JSONL exists
  if (entry.jsonl_path && !existsSync(entry.jsonl_path)) {
    const found = findJsonlFile(uuid);
    if (found) {
      registry.upsert(uuid, { jsonl_path: found, status: 'active' });
      await registry.flush();
      entry.jsonl_path = found;
    } else {
      registry.upsert(uuid, { status: 'corrupted' });
      await registry.flush();
      throw new CCLinkerError('E002', 'JSONL 文件不存在，会话可能已被清理（已标记 status=corrupted）');
    }
  } else if (!entry.jsonl_path) {
    // 尝试查找 JSONL 文件
    const found = findJsonlFile(uuid);
    if (found) {
      registry.upsert(uuid, { jsonl_path: found });
      await registry.flush();
      entry.jsonl_path = found;
    }
  }

  // dryRun 检查（在 JSONL 验证之后）
  const claudeBin = config.get<string>('general.claude_bin', 'claude');
  if (opts.dryRun) {
    const targetCwd = opts.cwd ?? entry.cwd;
    console.log(chalk.blue(`将执行: cd ${targetCwd} && ${claudeBin} --resume ${uuid}`));
    return;
  }

  // CWD check
  const targetCwd = opts.cwd ?? entry.cwd;
  const currentDir = process.cwd();
  if (targetCwd !== currentDir && opts.confirm !== false) {
    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: `此会话在 ${targetCwd} 中创建，将切换到该目录并恢复。继续？`,
      default: true,
    }]);
    if (!confirmed) return;
  }

  // Execute
  if (!existsSync(targetCwd)) {
    throw new CCLinkerError('E008', `工作目录不存在: ${targetCwd}，使用 --cwd 指定替代目录`);
  }

  console.log(chalk.green(`恢复会话: ${entry.title ?? uuid}`));

  // Repair JSONL last-prompt before resume to ensure Feishu messages are visible
  if (entry.jsonl_path && existsSync(entry.jsonl_path)) {
    const repaired = repairJsonlLastPrompt(entry.jsonl_path);
    if (repaired) {
      console.log(chalk.dim('已修复会话历史元数据'));
    }
  }

  process.chdir(targetCwd);
  const result = Bun.spawnSync([claudeBin, '--resume', uuid], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(result.exitCode ?? 1);
}

function findLatestSession(registry: RegistryManager, project?: string): string {
  let sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => !s.status || s.status === 'active');

  if (project) {
    sessions = sessions.filter(([_, s]) => s.project_name?.includes(project));
  }

  if (sessions.length === 0) {
    throw new CCLinkerError('E002', '没有找到活跃会话');
  }

  sessions.sort((a, b) => b[1].last_active.localeCompare(a[1].last_active));
  return sessions[0][0];
}

async function searchAndSelect(registry: RegistryManager, query: string): Promise<string> {
  let matches = Object.entries(registry.sessions)
    .filter(([_, s]) => s.title?.toLowerCase().includes(query.toLowerCase()));

  if (matches.length === 0) {
    throw new CCLinkerError('E002', `未找到包含 "${query}" 的会话`);
  }
  if (matches.length === 1) return matches[0][0];

  const { selected } = await inquirer.prompt([{
    type: 'list',
    name: 'selected',
    message: '找到多个匹配，请选择:',
    choices: matches.map(([uuid, s]) => ({
      name: `${uuid.slice(0, 8)}  ${s.title}  (${formatOrigin(s.origin)})`,
      value: uuid,
    })),
  }]);

  return selected;
}

async function interactiveSelect(registry: RegistryManager): Promise<string> {
  let sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => !s.status || s.status === 'active');

  sessions = sessions
    .sort((a, b) => b[1].last_active.localeCompare(a[1].last_active))
    .slice(0, 20);

  if (sessions.length === 0) {
    throw new CCLinkerError('E002', '没有找到会话');
  }

  const { selected } = await inquirer.prompt([{
    type: 'list',
    name: 'selected',
    message: '选择要恢复的会话:',
    choices: sessions.map(([uuid, s]) => ({
      name: `${uuid.slice(0, 8)}  ${s.title ?? 'Untitled'}  (${formatOrigin(s.origin)}, ${s.project_name ?? '?'}, ${s.message_count}条, ${formatTimeAgo(s.last_active)})`,
      value: uuid,
    })),
  }]);

  return selected;
}

function findJsonlFile(uuid: string): string | null {
  try {
    const projects = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const project of projects) {
      const jsonlPath = join(CLAUDE_PROJECTS_DIR, project, `${uuid}.jsonl`);
      if (existsSync(jsonlPath)) return jsonlPath;
    }
  } catch {}
  return null;
}

async function attemptRepairSession(
  registry: RegistryManager,
  uuid: string,
  entry: NonNullable<ReturnType<RegistryManager['get']>>,
): Promise<NonNullable<ReturnType<RegistryManager['get']>>> {
  const currentStatus = entry.status ?? 'active';
  if (!['provisioning', 'degraded'].includes(currentStatus)) {
    return entry;
  }

  if (entry.jsonl_path && existsSync(entry.jsonl_path)) {
    registry.upsert(uuid, {
      status: 'active',
      pending_jsonl_resolve: false,
      last_error: null,
    });
    await registry.flush();
    return registry.get(uuid) ?? entry;
  }

  const found = findJsonlFile(uuid);
  if (!found) {
    return entry;
  }

  registry.upsert(uuid, {
    jsonl_path: found,
    status: 'active',
    pending_jsonl_resolve: false,
    last_error: null,
  });
  await registry.flush();
  return registry.get(uuid) ?? entry;
}

/** Check if the bot is currently processing a message for this session */
function isSessionBusy(sessionUuid: string): boolean {
  if (!existsSync(SPOOL_PROCESSING_DIR)) return false;
  const prefix = `${sessionUuid}:`;
  return readdirSync(SPOOL_PROCESSING_DIR).some(f => f.startsWith(prefix));
}

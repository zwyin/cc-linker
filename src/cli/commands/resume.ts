import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { CCBridgeError } from '../../utils/errors';
import { formatOrigin, formatTimeAgo } from '../output';
import { CLAUDE_PROJECTS_DIR, RUNTIME_OWNER_LOCK_PATH } from '../../utils/paths';
import { config } from '../../utils/config';

interface ResumeOptions {
  search?: string;
  latest?: boolean;
  project?: string;
  dryRun?: boolean;
  confirm?: boolean;
  cwd?: string;
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
    if (!match) throw new CCBridgeError('E002', `未找到匹配 "${target}" 的会话`);
    uuid = match[0];
  } else {
    uuid = await interactiveSelect(registry);
  }

  let entry = registry.get(uuid);
  if (!entry) throw new CCBridgeError('E002', '会话不存在');

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
    throw new CCBridgeError(err.code as any, msg);
  }

  // 检测 owner.lock：如果存在 lock 且 repair 会写状态，则拒绝离线直写
  if (existsSync(RUNTIME_OWNER_LOCK_PATH)) {
    throw new CCBridgeError('E013', 'Bot 进程正在运行，请使用飞书命令恢复会话，而非直接 CLI 操作');
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
      throw new CCBridgeError('E002', 'JSONL 文件不存在，会话可能已被清理（已标记 status=corrupted）');
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
    throw new CCBridgeError('E008', `工作目录不存在: ${targetCwd}，使用 --cwd 指定替代目录`);
  }

  console.log(chalk.green(`恢复会话: ${entry.title ?? uuid}`));
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
    throw new CCBridgeError('E002', '没有找到活跃会话');
  }

  sessions.sort((a, b) => b[1].last_active.localeCompare(a[1].last_active));
  return sessions[0][0];
}

async function searchAndSelect(registry: RegistryManager, query: string): Promise<string> {
  let matches = Object.entries(registry.sessions)
    .filter(([_, s]) => s.title?.toLowerCase().includes(query.toLowerCase()));

  if (matches.length === 0) {
    throw new CCBridgeError('E002', `未找到包含 "${query}" 的会话`);
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
    throw new CCBridgeError('E002', '没有找到会话');
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

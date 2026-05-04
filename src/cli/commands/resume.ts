import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { chdir } from 'process';
import { RegistryManager } from '../../registry';
import { CCBridgeError } from '../../utils/errors';
import { formatOrigin, formatTimeAgo } from '../output';
import { CLAUDE_PROJECTS_DIR } from '../../utils/paths';

interface ResumeOptions {
  search?: string;
  latest?: boolean;
  project?: string;
  platform?: string;
  dryRun?: boolean;
  noConfirm?: boolean;
}

export async function resume(registry: RegistryManager, target?: string, opts: ResumeOptions = {}): Promise<void> {
  let uuid: string;

  if (opts.latest) {
    uuid = findLatestSession(registry, opts.project, opts.platform);
  } else if (opts.search) {
    uuid = await searchAndSelect(registry, opts.search);
  } else if (target) {
    const match = registry.findByPrefix(target);
    if (!match) throw new CCBridgeError('E002', `未找到匹配 "${target}" 的会话`);
    uuid = match[0];
  } else {
    uuid = await interactiveSelect(registry);
  }

  const entry = registry.get(uuid);
  if (!entry) throw new CCBridgeError('E002', '会话不存在');

  // Verify JSONL exists
  if (!existsSync(entry.jsonl_path)) {
    const found = findJsonlFile(uuid);
    if (found) {
      await registry.upsert(uuid, { jsonl_path: found });
      entry.jsonl_path = found;
    } else {
      throw new CCBridgeError('E002', 'JSONL 文件不存在，会话可能已被清理');
    }
  }

  // CWD check
  const currentDir = process.cwd();
  if (entry.cwd !== currentDir && !opts.noConfirm && !opts.dryRun) {
    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: `此会话在 ${entry.cwd} 中创建，将切换到该目录并恢复。继续？`,
      default: true,
    }]);
    if (!confirmed) return;
  }

  // Execute
  if (opts.dryRun) {
    console.log(chalk.blue(`将执行: cd ${entry.cwd} && claude --resume ${uuid}`));
    return;
  }

  console.log(chalk.green(`恢复会话: ${entry.title ?? uuid}`));
  chdir(entry.cwd);
  execFileSync('claude', ['--resume', uuid], { stdio: 'inherit' });
}

function findLatestSession(registry: RegistryManager, project?: string, platform?: string): string {
  let sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => s.status === 'active');

  if (project) {
    sessions = sessions.filter(([_, s]) => s.project_name?.includes(project));
  }
  if (platform) {
    sessions = sessions.filter(([_, s]) => s.platform === platform);
  }

  if (sessions.length === 0) {
    throw new CCBridgeError('E002', '没有找到活跃会话');
  }

  sessions.sort((a, b) => b[1].last_active.localeCompare(a[1].last_active));
  return sessions[0][0];
}

async function searchAndSelect(registry: RegistryManager, query: string): Promise<string> {
  const matches = Object.entries(registry.sessions)
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
  const sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => s.status === 'active')
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

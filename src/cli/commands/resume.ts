import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { CCBridgeError } from '../../utils/errors';
import { formatOrigin, formatTimeAgo } from '../output';
import { CLAUDE_PROJECTS_DIR, CC_CONNECT_SESSIONS_DIR } from '../../utils/paths';
import { config } from '../../utils/config';

interface ResumeOptions {
  search?: string;
  latest?: boolean;
  project?: string;
  platform?: string;
  user?: string;
  dryRun?: boolean;
  confirm?: boolean;
  cwd?: string;
}

export async function resume(registry: RegistryManager, target?: string, opts: ResumeOptions = {}): Promise<void> {
  let uuid: string;

  if (opts.latest) {
    uuid = findLatestSession(registry, opts.project, opts.platform, opts.user);
  } else if (opts.search) {
    uuid = await searchAndSelect(registry, opts.search, opts.user);
  } else if (target) {
    const match = registry.findByPrefix(target);
    if (!match) throw new CCBridgeError('E002', `未找到匹配 "${target}" 的会话`);
    uuid = match[0];
  } else {
    uuid = await interactiveSelect(registry, opts.user);
  }

  let entry = registry.get(uuid);
  if (!entry) throw new CCBridgeError('E002', '会话不存在');

  // reset_on_idle 检测：cc-connect 会话可能已被新会话替代
  // （在 JSONL 验证之前做，因为用户可能选择新会话，需要验证新会话的 JSONL）
  if (entry.origin === 'cc-connect' && entry.cc_connect_session_id) {
    const superseded = checkResetOnIdle(entry.cc_connect_session_id, entry.cc_connect_session_file, registry);
    if (superseded && superseded.uuid !== uuid) {
      const { choice } = await inquirer.prompt([{
        type: 'list',
        name: 'choice',
        message: `此会话已被新会话替代（${superseded.title ?? superseded.uuid.slice(0, 8)}）。恢复哪个？`,
        choices: [
          { name: '1) 旧会话（完整历史保留在 JSONL 中）', value: 'old' },
          { name: `2) 最新会话（${superseded.title ?? superseded.uuid.slice(0, 8)}）`, value: 'new' },
        ],
      }]);
      if (choice === 'new') {
        uuid = superseded.uuid;
        const newEntry = registry.get(uuid);
        if (newEntry) entry = newEntry;
      }
    }
  }

  // Verify JSONL exists
  if (!existsSync(entry.jsonl_path)) {
    const found = findJsonlFile(uuid);
    if (found) {
      registry.upsert(uuid, { jsonl_path: found, status: 'active' });
      await registry.flush();
      entry.jsonl_path = found;
    } else {
      // 标记为 corrupted（spec §4.3 步骤3 + §9.4），后续 list 默认不再显示
      registry.upsert(uuid, { status: 'corrupted' });
      await registry.flush();
      throw new CCBridgeError('E002', 'JSONL 文件不存在，会话可能已被清理（已标记 status=corrupted）');
    }
  }

  // CWD check
  const targetCwd = opts.cwd ?? entry.cwd;
  const currentDir = process.cwd();
  if (targetCwd !== currentDir && opts.confirm !== false && !opts.dryRun) {
    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: `此会话在 ${targetCwd} 中创建，将切换到该目录并恢复。继续？`,
      default: true,
    }]);
    if (!confirmed) return;
  }

  // Execute
  const claudeBin = config.get<string>('general.claude_bin', 'claude');
  if (opts.dryRun) {
    console.log(chalk.blue(`将执行: cd ${targetCwd} && ${claudeBin} --resume ${uuid}`));
    return;
  }

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

function findLatestSession(registry: RegistryManager, project?: string, platform?: string, user?: string): string {
  let sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => !s.status || s.status === 'active');

  if (project) {
    sessions = sessions.filter(([_, s]) => s.project_name?.includes(project));
  }
  if (platform) {
    sessions = sessions.filter(([_, s]) => s.platform === platform);
  }
  if (user) {
    sessions = sessions.filter(([_, s]) =>
      s.owner === user ||
      s.owner_user_key === user ||
      s.owner === normalizeFeishuUser(user) ||
      s.owner_user_key === normalizeFeishuUser(user)
    );
  }

  if (sessions.length === 0) {
    throw new CCBridgeError('E002', '没有找到活跃会话');
  }

  sessions.sort((a, b) => b[1].last_active.localeCompare(a[1].last_active));
  return sessions[0][0];
}

async function searchAndSelect(registry: RegistryManager, query: string, user?: string): Promise<string> {
  let matches = Object.entries(registry.sessions)
    .filter(([_, s]) => s.title?.toLowerCase().includes(query.toLowerCase()));

  if (user) {
    matches = matches.filter(([_, s]) =>
      s.owner === user ||
      s.owner_user_key === user ||
      s.owner === normalizeFeishuUser(user) ||
      s.owner_user_key === normalizeFeishuUser(user)
    );
  }

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

function normalizeFeishuUser(user: string): string {
  // 支持多种用户格式: feishu:ou_xxx → 直接匹配
  if (user.startsWith('feishu:')) return user;
  return `feishu:${user}`;
}

async function interactiveSelect(registry: RegistryManager, user?: string): Promise<string> {
  let sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => !s.status || s.status === 'active');

  if (user) {
    sessions = sessions.filter(([_, s]) =>
      s.owner === user ||
      s.owner_user_key === user ||
      s.owner === normalizeFeishuUser(user) ||
      s.owner_user_key === normalizeFeishuUser(user)
    );
  }

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

interface SupersededInfo {
  uuid: string;
  title: string | null;
}

function checkResetOnIdle(ccSid: string, ccFile: string | null, registry: RegistryManager): SupersededInfo | null {
  if (!ccFile || !existsSync(ccFile)) return null;

  try {
    const data = JSON.parse(readFileSync(ccFile, 'utf8'));

    // 找到 sid 对应的 user_key
    let userKey: string | null = null;
    for (const [uk, sids] of Object.entries(data.user_sessions ?? {})) {
      if ((sids as string[]).includes(ccSid)) {
        userKey = uk;
        break;
      }
    }
    if (!userKey) {
      for (const [uk, sid] of Object.entries(data.active_session ?? {})) {
        if (sid === ccSid) { userKey = uk; break; }
      }
    }
    if (!userKey) return null;

    // 查 user_key 当前的 active_session
    const activeSid = data.active_session?.[userKey];
    if (!activeSid || activeSid === ccSid) return null;

    const activeSession = data.sessions?.[activeSid];
    if (!activeSession?.agent_session_id) return null;

    // 从 registry 获取新会话的标题（比 session.name 更有意义）
    const newUuid = activeSession.agent_session_id;
    const registryEntry = registry.get(newUuid);
    const title = registryEntry?.title ?? newUuid.slice(0, 8);

    return {
      uuid: newUuid,
      title,
    };
  } catch {
    return null;
  }
}

import { readFileSync, writeFileSync, readdirSync, renameSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { RegistryManager, type SessionEntry } from '../../registry';
import { CCBridgeError } from '../../utils/errors';
import { formatTimeAgo, formatOrigin } from '../output';
import { CC_CONNECT_SESSIONS_DIR } from '../../utils/paths';
import { switchSession } from '../../bridge/client';
import { withLock } from '../../utils/lock';
import { logger } from '../../utils/logger';
import { normalizeOwner } from '../../utils/owner';

interface FeishuCmdOptions {
  caller?: string;
  confirm?: boolean;
}

/**
 * 从 cc-connect session 文件中自动检测调用者身份
 * 扫描所有 session 文件，找到最近活跃的用户
 */
function detectCallerFromSessionFiles(): string | null {
  if (!existsSync(CC_CONNECT_SESSIONS_DIR)) return null;

  try {
    const files = readdirSync(CC_CONNECT_SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: join(CC_CONNECT_SESSIONS_DIR, f),
        mtime: statSync(join(CC_CONNECT_SESSIONS_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime); // 按修改时间倒序

    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(file.path, 'utf8'));
        // 找到 active_session 中的用户
        const activeSession = data.active_session || {};
        const userKeys = Object.keys(activeSession);
        if (userKeys.length > 0) {
          // 返回第一个活跃用户
          return userKeys[0];
        }
      } catch {
        continue;
      }
    }
  } catch {}

  return null;
}

export async function feishuCmd(
  registry: RegistryManager,
  subcommand: string,
  args: string[],
  opts: FeishuCmdOptions
): Promise<void> {
  // 如果没有 --caller 参数，尝试自动检测
  let caller = opts.caller;
  if (!caller) {
    caller = detectCallerFromSessionFiles() ?? undefined;
  }

  switch (subcommand) {
    case 'list':
      feishuList(registry, caller);
      break;
    case 'switch':
      await feishuSwitch(registry, caller, args[0], { confirm: opts.confirm });
      break;
    case 'resume':
      feishuResume(registry, caller, args[0]);
      break;
    case 'status':
      feishuStatus(registry);
      break;
    default:
      throw new CCBridgeError('E005', `未知子命令: ${subcommand}`);
  }
}

function feishuList(registry: RegistryManager, caller?: string): void {
  if (!caller) {
    throw new CCBridgeError('E019', '缺少调用者身份，请检查 cc-connect [[commands]] 配置或确保 cc-connect 正在运行');
  }

  let sessions = Object.entries(registry.sessions)
    .filter(([_, s]) => !s.status || s.status === 'active');

  if (!caller.startsWith('terminal:')) {
    sessions = sessions.filter(([_, s]) =>
      s.origin === 'cli' ||
      s.owner_user_key === caller ||
      s.owner === normalizeOwner(caller) ||
      s.visibility === 'public' ||
      (s.shared_with ?? []).includes(caller)
    );
  }

  sessions.sort((a, b) => b[1].last_active.localeCompare(a[1].last_active));

  const lines: string[] = [];
  lines.push(`📋 我的会话（共 ${sessions.length} 个）  `);
  lines.push('');

  const displaySessions = sessions.slice(0, 20);
  for (let i = 0; i < displaySessions.length; i++) {
    const [uuid, s] = displaySessions[i];
    const ref = uuid.slice(0, 8);
    const originIcon = s.origin === 'cc-connect' ? '飞书' : '终端';
    const timeAgo = formatTimeAgo(s.last_active);
    const title = s.title ?? 'Untitled';

    lines.push(`${i + 1}. ${title}  `);
    lines.push(`   ID: ${ref}  `);
    lines.push(`   ${originIcon} | ${s.message_count}条 | ${timeAgo} | ${s.project_name ?? '?'}  `);
    lines.push('');
  }

  lines.push('━━━━━━━━━━━━━━━━  ');
  lines.push('💡 直接回复数字即可操作：  ');
  lines.push('   /bridge switch 1  ');
  lines.push('   /bridge resume 1  ');

  console.log(lines.join('\n'));
}

/**
 * 解析目标参数：支持数字索引（1-based）或 UUID 前缀
 */
function resolveTarget(registry: RegistryManager, target: string, caller?: string): [string, SessionEntry] | null {
  // 尝试数字索引
  const num = parseInt(target, 10);
  if (!isNaN(num) && num >= 1 && num <= 20) {
    let sessions = Object.entries(registry.sessions)
      .filter(([_, s]) => !s.status || s.status === 'active');

    // 飞书调用者过滤
    if (caller && !caller.startsWith('terminal:')) {
      sessions = sessions.filter(([_, s]) =>
        s.origin === 'cli' ||
        s.owner_user_key === caller ||
        s.owner === normalizeOwner(caller) ||
        s.visibility === 'public' ||
        (s.shared_with ?? []).includes(caller)
      );
    }

    sessions.sort((a, b) => b[1].last_active.localeCompare(a[1].last_active));

    if (num <= sessions.length) {
      return sessions[num - 1];
    }
  }

  // 尝试 UUID 前缀
  return registry.findByPrefix(target);
}

interface SwitchOptions {
  confirm?: boolean;
}

async function feishuSwitch(
  registry: RegistryManager,
  caller: string | undefined,
  target: string,
  opts: SwitchOptions
): Promise<void> {
  if (!target) {
    throw new CCBridgeError('E005', '用法: /bridge switch <数字或UUID前缀>');
  }

  const match = resolveTarget(registry, target, caller);
  if (!match) {
    throw new CCBridgeError('E002', `未找到匹配 "${target}" 的会话`);
  }

  const [uuid, entry] = match;

  // 终端用户应使用 `cc-bridge resume`，不应通过 feishu-cmd switch 操作
  if (caller?.startsWith('terminal:')) {
    throw new CCBridgeError('E019', '终端用户请使用 cc-bridge resume 恢复会话');
  }

  // 权限检查：飞书调用者只能操作自己有权限的会话
  if (caller && !caller.startsWith('terminal:') && !canCallerAccessSession(entry, caller)) {
    throw new CCBridgeError('E019', `无权访问该会话（调用者: ${caller}）`);
  }

  // 场景 A：已有 cc-connect 映射，调用 Bridge API 即时切换
  if (entry.cc_connect_session_id) {
    const sessionKey = caller ?? '';
    if (!sessionKey) {
      throw new CCBridgeError('E019', '缺少调用者身份，无法调用 Bridge API');
    }

    try {
      await switchSession({
        sessionKey,
        target: entry.cc_connect_session_id!,
      });

      console.log(`✅ 已切换到「${entry.title ?? uuid.slice(0, 8)}」(${entry.message_count} 条消息)`);
      if (entry.origin === 'cli') {
        console.log(`💻 此会话来自终端，包含完整的开发历史`);
      }
      console.log(`⚡ 无需重启，已即时生效`);
      return;
    } catch (err: any) {
      const errMsg = err.message || '';
      // 如果 cc-connect 返回 404 (session not found)，说明映射已失效
      // 降级为场景 B：重新创建映射
      if (errMsg.includes('404') && errMsg.includes('not found')) {
        console.log(`⚠️ Bridge API 返回 404 (映射已失效)，正在重新创建映射...`);
        // 清除 registry 中失效的 ID，让后续逻辑重新创建
        (entry as any).cc_connect_session_id = null;
        // 清除 session 文件中的旧映射，避免 withLock 误判为 existing-mapping
        const staleFilePath = entry.cc_connect_session_file;
        if (staleFilePath && existsSync(staleFilePath)) {
          try {
            const staleData = JSON.parse(readFileSync(staleFilePath, 'utf8'));
            let changed = false;
            if (staleData.sessions) {
              for (const [sid, session] of Object.entries(staleData.sessions)) {
                if ((session as any)?.agent_session_id === uuid) {
                  delete staleData.sessions[sid];
                  changed = true;
                  // 同时清理 user_sessions 和 active_session 中的引用
                  if (staleData.user_sessions) {
                    for (const [uk, sids] of Object.entries(staleData.user_sessions)) {
                      if (Array.isArray(sids)) {
                        staleData.user_sessions[uk] = (sids as string[]).filter(s => s !== sid);
                      }
                    }
                  }
                  if (staleData.active_session) {
                    for (const [uk, s] of Object.entries(staleData.active_session)) {
                      if (s === sid) delete staleData.active_session[uk];
                    }
                  }
                  break;
                }
              }
            }
            if (changed) {
              const tmpPath = staleFilePath + '.tmp';
              writeFileSync(tmpPath, JSON.stringify(staleData, null, 2), { mode: 0o600 });
              renameSync(tmpPath, staleFilePath);
            }
          } catch {
            // 忽略清理失败，继续后续逻辑
          }
        }
        // 继续执行后续的场景 B 逻辑
      } else {
        // 其他错误（如 cc-connect 未运行）：提示用户
        console.log(`⚠️ Bridge API 调用失败: ${err.message}`);
        console.log(`会话信息:「${entry.title ?? uuid.slice(0, 8)}」(${entry.message_count} 条消息)`);
        console.log(`请确保 cc-connect 正在运行，或在终端执行: cc-bridge resume ${uuid.slice(0, 8)}`);
        return;
      }
    }
  }

  // 场景 B：CLI 会话首次映射
  if (!existsSync(entry.jsonl_path)) {
    throw new CCBridgeError('E002', 'JSONL 文件不存在，会话可能已被清理');
  }

  const sessionFilePath = findSessionFileForMapping(caller);
  if (!sessionFilePath) {
    throw new CCBridgeError('E004', '未找到匹配当前调用者的 cc-connect session 文件，请检查 ~/.cc-connect/sessions/ 目录');
  }

  if (!caller) {
    throw new CCBridgeError(
      'E019',
      '缺少调用者身份，无法创建 cc-connect 映射。请检查 cc-connect [[commands]] 是否注入 --caller {{user}}'
    );
  }

  // 用文件锁包住 read-check-write 全流程，防止跨进程并发污染 counter
  // 同时解决 spec §5.2 步骤 5 中乐观锁 read 与 write 之间的 TOCTOU
  const writeOutcome = await withLock(sessionFilePath, async (): Promise<
    | { kind: 'existing-mapping'; sid: string }
    | { kind: 'needs-confirm'; otherUsers: Array<{ userKey: string; sid: string }> }
    | { kind: 'wrote-mapping'; newSid: string }
  > => {
    let sessionData: any;
    try {
      sessionData = JSON.parse(readFileSync(sessionFilePath, 'utf8'));
    } catch (err) {
      throw new CCBridgeError('E012', `cc-connect session 文件解析失败: ${sessionFilePath}`);
    }

    // 已有映射 → 直接返回 existing
    for (const sid of Object.keys(sessionData.sessions ?? {})) {
      if (sessionData.sessions[sid]?.agent_session_id === uuid) {
        return { kind: 'existing-mapping', sid };
      }
    }

    // spec §5.2 步骤 3：枚举其他活跃用户、要求显式 --confirm
    const otherUsers: Array<{ userKey: string; sid: string }> = [];
    for (const [userKey, sid] of Object.entries(sessionData.active_session ?? {})) {
      if (userKey !== caller) otherUsers.push({ userKey, sid: sid as string });
    }

    if (!opts.confirm) {
      return { kind: 'needs-confirm', otherUsers };
    }

    // spec §5.2 步骤 4-5：创建新映射 + 原子写入（counter 由文件锁保证一致）
    const newCounter = (sessionData.counter ?? 0) + 1;
    const newSid = `s${newCounter}`;

    sessionData.sessions = sessionData.sessions ?? {};
    sessionData.sessions[newSid] = {
      id: newSid,
      name: 'default',
      agent_session_id: uuid,
      agent_type: 'claudecode',
      history: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    sessionData.user_sessions = sessionData.user_sessions ?? {};
    const existingSids = sessionData.user_sessions[caller] ?? [];
    sessionData.user_sessions[caller] = [...existingSids, newSid];
    sessionData.active_session = sessionData.active_session ?? {};
    sessionData.active_session[caller] = newSid;
    sessionData.counter = newCounter;

    const tmpPath = sessionFilePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(sessionData, null, 2), { mode: 0o600 });
    renameSync(tmpPath, sessionFilePath);

    return { kind: 'wrote-mapping', newSid };
  });

  if (writeOutcome.kind === 'existing-mapping') {
    registry.upsert(uuid, {
      cc_connect_session_id: writeOutcome.sid,
      cc_connect_session_file: sessionFilePath,
    });
    await registry.flush();

    try {
      await switchSession({ sessionKey: caller, target: writeOutcome.sid });
    } catch {
      // API 失败不阻塞，cc-connect 重启后会自动加载
    }

    console.log(`✅ 已切换到「${entry.title ?? uuid.slice(0, 8)}」(${entry.message_count} 条消息)`);
    console.log(`⚡ 无需重启，已即时生效`);
    return;
  }

  if (writeOutcome.kind === 'needs-confirm') {
    // spec §5.2 步骤 3 飞书回复：要求用户重发命令并加 --confirm
    if (writeOutcome.otherUsers.length > 0) {
      console.log('⚠️ 此操作需要重启/重载 cc-connect，将中断以下用户的当前会话:');
      for (const u of writeOutcome.otherUsers) {
        console.log(`   - ${publicUserName(u.userKey)} (${u.sid})`);
      }
    } else {
      console.log('⚠️ 首次切换此 CLI 会话需要创建 cc-connect 映射，并重启/重载 cc-connect。');
      console.log('   当前对话会短暂中断，但会话历史会保留。');
    }
    console.log(`如确认继续，请重发: /bridge switch ${target} --confirm`);
    return;
  }

  // wrote-mapping：写入完成，更新 registry → 重启 cc-connect
  registry.upsert(uuid, {
    cc_connect_session_id: writeOutcome.newSid,
    cc_connect_session_file: sessionFilePath,
    owner_user_key: caller,
    owner: normalizeOwner(caller),
  });
  await registry.flush();

  console.log(`✅ 已切换到「${entry.title ?? uuid.slice(0, 8)}」(${entry.message_count} 条消息)`);
  console.log(`💻 此会话来自终端，已创建 cc-connect 映射`);

  const restarted = await restartCCConnect();
  if (restarted.ok) {
    console.log(`⚠️ cc-connect ${restarted.method}，正在进行的对话可能短暂中断，但历史已保留`);
  } else {
    console.log(`⚠️ 自动重启 cc-connect 失败：${restarted.error}`);
    console.log('   请手动执行: cc-connect daemon restart');
  }
}

/** 重启 cc-connect 使新的映射生效。spec §5.2 步骤 6。
 *  CC_BRIDGE_NO_RESTART=1 可禁用自动重启（测试环境或用户希望自己管理 cc-connect 进程时）。
 */
async function restartCCConnect(): Promise<
  | { ok: true; method: string }
  | { ok: false; error: string }
> {
  if (process.env.CC_BRIDGE_NO_RESTART === '1') {
    return { ok: false, error: 'CC_BRIDGE_NO_RESTART=1 已禁用自动重启' };
  }

  // 优先尝试 cc-connect daemon restart
  try {
    const result = spawnSync('cc-connect', ['daemon', 'restart'], {
      timeout: 10_000,
      stdio: 'pipe',
    });
    if (result.status === 0) {
      return { ok: true, method: '已重启' };
    }
    logger.debug(`cc-connect daemon restart 失败: status=${result.status}, stderr=${result.stderr?.toString() ?? ''}`);
  } catch (err: any) {
    logger.debug(`cc-connect daemon restart 调用异常: ${err.message}`);
  }

  // 兜底：SIGHUP cc-connect 进程（优雅重载）
  const pid = findCCConnectPid();
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGHUP');
      return { ok: true, method: '已发送 SIGHUP 重载' };
    } catch (err: any) {
      logger.debug(`SIGHUP ${pid} 失败: ${err.message}`);
    }
  }

  return { ok: false, error: '未找到 cc-connect 进程或 daemon 命令不可用' };
}

function findCCConnectPid(): number | null {
  // 1. 尝试 ~/.cc-connect/cc-connect.pid
  const pidFile = join(process.env.HOME ?? homedir(), '.cc-connect', 'cc-connect.pid');
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (!isNaN(pid) && pid > 0) return pid;
    } catch {}
  }

  // 2. pgrep 兜底
  try {
    const result = spawnSync('pgrep', ['-f', 'cc-connect'], {
      timeout: 3_000,
      stdio: 'pipe',
    });
    if (result.status === 0) {
      const out = result.stdout?.toString() ?? '';
      const firstLine = out.split('\n').filter(Boolean)[0];
      if (firstLine) {
        const pid = parseInt(firstLine, 10);
        if (!isNaN(pid) && pid > 0) return pid;
      }
    }
  } catch {}

  return null;
}

function findSessionFileForMapping(caller?: string): string | null {
  if (!existsSync(CC_CONNECT_SESSIONS_DIR)) return null;
  const files = readdirSync(CC_CONNECT_SESSIONS_DIR).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) return null;

  if (caller) {
    const byUserMatch: string[] = [];
    for (const file of files) {
      try {
        const filePath = join(CC_CONNECT_SESSIONS_DIR, file);
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        if (
          data.active_session?.[caller] ||
          (Array.isArray(data.user_sessions?.[caller]) && data.user_sessions[caller].length > 0)
        ) {
          byUserMatch.push(filePath);
        }
      } catch {
        // ignore malformed files here; scanner already logs parse failures elsewhere
      }
    }

    if (byUserMatch.length === 1) return byUserMatch[0];
    if (byUserMatch.length > 1) {
      console.warn(`⚠️ 发现多个匹配当前调用者的 cc-connect session 文件，使用第一个: ${byUserMatch[0]}`);
      return byUserMatch[0];
    }
  }

  if (files.length === 1) {
    return join(CC_CONNECT_SESSIONS_DIR, files[0]);
  }

  return null;
}

function feishuResume(registry: RegistryManager, caller: string | undefined, target: string): void {
  if (!caller) {
    throw new CCBridgeError('E019', '缺少调用者身份，请检查 cc-connect [[commands]] 配置');
  }

  const match = resolveTarget(registry, target, caller);
  if (!match) {
    throw new CCBridgeError('E002', `未找到匹配 "${target}" 的会话`);
  }

  const [uuid, entry] = match;

  // 权限检查
  if (caller && !caller.startsWith('terminal:') && !canCallerAccessSession(entry, caller)) {
    throw new CCBridgeError('E019', `无权访问该会话（调用者: ${caller}）`);
  }

  console.log(`📱 请在终端执行以下命令恢复此会话：\n`);
  console.log(`  cc-bridge resume ${uuid.slice(0, 8)}\n`);
  console.log(`或直接运行：`);
  console.log(`  claude --resume ${uuid}`);
}

function feishuStatus(registry: RegistryManager): void {
  const sessions = Object.values(registry.sessions);
  const active = sessions.filter(s => !s.status || s.status === 'active').length;
  const fromCli = sessions.filter(s => s.origin === 'cli').length;
  const fromCcConnect = sessions.filter(s => s.origin === 'cc-connect').length;

  console.log(`🔗 cc-bridge 状态`);
  console.log(`注册会话: ${sessions.length}`);
  console.log(`来源: ${fromCli} 个来自终端，${fromCcConnect} 个来自飞书`);
  console.log(`活跃: ${active}`);
}

/** 判断调用者是否有权访问指定会话（与 feishuList 过滤逻辑一致） */
function canCallerAccessSession(entry: SessionEntry, caller: string): boolean {
  return (
    entry.origin === 'cli' ||
    entry.owner_user_key === caller ||
    entry.owner === normalizeOwner(caller) ||
    entry.visibility === 'public' ||
    (entry.shared_with ?? []).includes(caller)
  );
}

/** 仅用于 needs-confirm 提示中展示，剥离 tenant_key。 */
function publicUserName(userKey: string): string {
  return normalizeOwner(userKey);
}

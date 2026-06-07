// src/agent-view/snapshot-fetcher.ts
import { execFile } from 'node:child_process';
import { VersionGuard } from './version-guard';
import { DaemonProbe } from './daemon-probe';
import { parseAgentsJson, attachRosterSources, filterUserDispatched } from './snapshot';
import { readRoster, buildRosterSourceMap } from './roster-source';
import { readCompletedSessions } from './daemon-log-reader';
import type { AgentSession, AgentSessionSource } from './types';

export type FetchResult =
  | { ok: true; sessions: AgentSession[] }
  | { ok: false; reason: string };

/**
 * v2.2.4 新增:为已 settled (status='done') 的 session 拼装 AgentSession。
 * - 跳过仍然在 active(--json)列表中的,避免和 active session 重复
 * - 跳过 'killed'(TUI 也不展示,只展示 'done')
 * - 通过 `claude logs <short>` 拿用户 prompt 的首行当 name(超时 3s)
 * - 拿不到时用 short hash 当 name(graceful)
 * - source 从 roster 取(roster 里有这个 short 的话),否则 'unknown'
 */
async function enrichCompletedSessions(
  completed: Map<string, { short: string; settledAt: number; status: 'done' | 'killed' }>,
  activeShorts: Set<string>,
  sourceMap: Map<string, 'slash' | 'spare' | 'fleet'>,
): Promise<AgentSession[]> {
  const result: AgentSession[] = [];
  for (const { short, settledAt, status } of completed.values()) {
    if (activeShorts.has(short)) continue; // already in --json
    if (status === 'killed') continue; // only show done
    let name = short;
    try {
      const cp = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileP = promisify(cp.execFile);
      const r = await execFileP('claude', ['logs', short], { timeout: 3000 });
      // First non-empty, non-XML-tag line is usually the user prompt
      const firstLine = r.stdout
        .split('\n')
        .map(l => l.trim())
        .find(l => l && !l.startsWith('<'));
      if (firstLine) name = firstLine.slice(0, 60);
    } catch {
      // ignore — fall back to short as name
    }
    const source: AgentSessionSource = sourceMap.get(short) ?? 'unknown';
    result.push({
      pid: 0,
      cwd: '',
      kind: 'background',
      startedAt: settledAt,
      sessionId: short, // 不是真实 UUID,用 short hash 当 fallback
      name: `✅ ${name}`,
      status: 'idle',
      source,
      completed: true,
    });
  }
  return result;
}

export const AgentSnapshotFetcher = {
  /**
   * Fetch live background session snapshot.
   * v2.2: 每次调用都重新 fetch,无 5s 缓存(避免死代码)。
   * v2.2.4: 在 `claude agents --json` 之外,叠加 daemon.log 中的 completed (done) sessions
   * ——这样 Agent View 与 TUI "Completed" 区段对齐,不会漏行。
   *
   * Note: 不用 `promisify(execFile)`(无论放在模块顶层还是函数体内)是因为
   * Node 的 execFile 自带 `util.promisify.custom` 返回 `{stdout, stderr}` 形状,
   * 测试里的 mock.module 替身没有这个 symbol,会让 promisify 退化成单参 Promise,
   * 导致 `result.stdout` 为 undefined。直接 new Promise 包一层最干净。
   */
  async fetch(): Promise<FetchResult> {
    const ver = await VersionGuard.check();
    if (!ver.ok) {
      return { ok: false, reason: ver.reason ?? 'version check failed' };
    }
    if (!DaemonProbe.check()) {
      return { ok: false, reason: 'Claude daemon not running' };
    }

    let stdout: string;
    try {
      stdout = await new Promise<string>((resolve, reject) => {
        execFile('claude', ['agents', '--json'], (err, out, _stderr) => {
          if (err) reject(err);
          else resolve(out);
        });
      });
    } catch (err: any) {
      return { ok: false, reason: `claude agents --json failed: ${err.message}` };
    }

    try {
      // v2.2.1: 先 parse → 打 source 标签 → 过滤 sub-agent
      // (roster 读不到时退化为 source='unknown',filterUserDispatched 会保留这些,
      //  避免 daemon 短暂不在时把整张列表清空。)
      const roster = readRoster();
      const sourceMap = buildRosterSourceMap(roster);
      let sessions = filterUserDispatched(
        attachRosterSources(parseAgentsJson(stdout), sourceMap),
      );

      // v2.2.4: 叠加 daemon.log 中的 completed (done) sessions。
      // 跳过仍在 --json 中的 short(race condition:daemon 刚把同一 session 又派出来)。
      const completed = readCompletedSessions(24);
      const activeShorts = new Set(sessions.map(s => s.sessionId.slice(0, 8)));
      const completedSessions = await enrichCompletedSessions(
        completed,
        activeShorts,
        sourceMap as Map<string, 'slash' | 'spare' | 'fleet'>,
      );
      sessions = [...sessions, ...completedSessions];

      return { ok: true, sessions };
    } catch (err: any) {
      return { ok: false, reason: `parse failed: ${err.message}` };
    }
  },
};

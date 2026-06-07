// src/agent-view/snapshot-fetcher.ts
import { execFile } from 'node:child_process';
import { VersionGuard } from './version-guard';
import { DaemonProbe } from './daemon-probe';
import { parseAgentsJson, attachRosterSources, filterUserDispatched } from './snapshot';
import { readRoster, buildRosterSourceMap } from './roster-source';
import { readCompletedSessions, readClaimedSources } from './daemon-log-reader';
import type { AgentSession, AgentSessionSource } from './types';

export type FetchResult =
  | { ok: true; sessions: AgentSession[] }
  | { ok: false; reason: string };

/**
 * v2.2.4 新增 / v2.2.5 修正:为已 settled (status='done') 的 session 拼装 AgentSession。
 *
 * - 跳过仍然在 active(--json)列表中的,避免和 active session 重复
 * - 跳过 'killed'(TUI 也不展示,只展示 'done')
 * - source 优先级:roster(仍在飞)> daemon.log claimed 事件 > 'unknown'
 *   这样能在 settled 之后还原最初的 dispatch.source,用于在 filterUserDispatched
 *   把 'spare' 完成项正确过滤掉(v2.2.4 的遗留:完成的 spare 因为 source='unknown'
 *   而被错误保留)。
 * - name 用 `claude logs <short>` 拿用户 prompt 首行(3s 超时)。
 *   settled session 通常 daemon 已清理 worker,`claude logs` 会报
 *   "No job matching '<short>'",此时退化为 `<short> (logs unavailable)`,
 *   保留 short hash 提供 debug 可见性,同时给出"为什么没有 name"的信号。
 */
async function enrichCompletedSessions(
  completed: Map<string, { short: string; settledAt: number; status: 'done' | 'killed' }>,
  activeShorts: Set<string>,
  rosterSourceMap: Map<string, AgentSessionSource>,
  daemonLogSourceMap: Map<string, AgentSessionSource>,
): Promise<AgentSession[]> {
  const result: AgentSession[] = [];
  for (const { short, settledAt, status } of completed.values()) {
    if (activeShorts.has(short)) continue; // already in --json
    if (status === 'killed') continue; // only show done

    // Source priority: roster (still in flight) > daemon log (claimed event) > 'unknown'
    const source: AgentSessionSource =
      rosterSourceMap.get(short) ?? daemonLogSourceMap.get(short) ?? 'unknown';

    // Name: claude logs often fails for settled sessions (daemon already cleaned the worker).
    // Fall back to "<short> (logs unavailable)" so users still see something debug-able
    // and know why the human-readable name is missing.
    let name: string;
    try {
      const cp = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileP = promisify(cp.execFile);
      const r = await execFileP('claude', ['logs', short], { timeout: 3000 });
      const firstLine = r.stdout
        .split('\n')
        .map(l => l.trim())
        .find(l => l && !l.startsWith('<'));
      name = firstLine ? firstLine.slice(0, 60) : short;
    } catch {
      // claude logs failed (typical for settled sessions) — show short hash with a hint
      name = `${short} (logs unavailable)`;
    }

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
   * v2.2.5: completed session 的 source 改成 roster + daemon.log claimed 事件双兜底,
   * 并把 filterUserDispatched 推迟到 merge 之后执行,正确过滤掉 completed spare。
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
      // v2.2.1: 先 parse → 打 source 标签
      // (roster 读不到时退化为 source='unknown')
      const roster = readRoster();
      const sourceMap = buildRosterSourceMap(roster);
      // 注意:v2.2.5 起,filterUserDispatched 推迟到 merge completed 之后执行,
      // 这样从 daemon.log 推断出 source='spare' 的 completed session 也会被正确过滤。
      let sessions = attachRosterSources(parseAgentsJson(stdout), sourceMap);

      // v2.2.4 / v2.2.5: 叠加 daemon.log 中的 completed (done) sessions。
      // 跳过仍在 --json 中的 short(race condition:daemon 刚把同一 session 又派出来)。
      // claimedSources 用 daemon.log 'claimed-spare' 事件兜底 source(roster 已清掉时)。
      const completed = readCompletedSessions(24);
      const claimedSources = readClaimedSources(24);
      const activeShorts = new Set(sessions.map(s => s.sessionId.slice(0, 8)));
      const completedSessions = await enrichCompletedSessions(
        completed,
        activeShorts,
        sourceMap as Map<string, AgentSessionSource>,
        claimedSources,
      );
      sessions = [...sessions, ...completedSessions];

      // v2.2.5: 过滤推迟到 merge 之后,确保 completed spare 也被过滤掉。
      sessions = filterUserDispatched(sessions);

      return { ok: true, sessions };
    } catch (err: any) {
      return { ok: false, reason: `parse failed: ${err.message}` };
    }
  },
};

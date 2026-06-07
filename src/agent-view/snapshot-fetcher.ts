// src/agent-view/snapshot-fetcher.ts
import { execFile } from 'node:child_process';
import { VersionGuard } from './version-guard';
import { DaemonProbe } from './daemon-probe';
import { parseAgentsJson, attachRosterSources } from './snapshot';
import { readRoster, buildRosterSourceMap } from './roster-source';
import type { AgentSession } from './types';

export type FetchResult =
  | { ok: true; sessions: AgentSession[] }
  | { ok: false; reason: string };

export const AgentSnapshotFetcher = {
  /**
   * Fetch live background session snapshot.
   * v2.2: 每次调用都重新 fetch,无 5s 缓存(避免死代码)。
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
      // v2.2.1: 先 parse,再用 roster.json 给每个 session 打 source 标签
      // (roster 读不到时退化为 source='unknown',不影响主流程)
      const roster = readRoster();
      const sourceMap = buildRosterSourceMap(roster);
      const sessions = attachRosterSources(parseAgentsJson(stdout), sourceMap);
      return { ok: true, sessions };
    } catch (err: any) {
      return { ok: false, reason: `parse failed: ${err.message}` };
    }
  },
};

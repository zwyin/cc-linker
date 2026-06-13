// src/agent-view/snapshot-fetcher.ts
//
// v2.3 重构:数据源从 `claude agents --json`(v2.1.163 字段坏掉,所有 background
// 都返回 status="idle")切换到 ~/.claude/jobs/<short>/state.json(CLI 维护的权威
// 状态机)。
//
// 流水线:
//   VersionGuard → DaemonProbe
//   → smoke-test(`claude agents --json`,返回值丢弃,仅用于确认 CLI/daemon 健康)
//   → readAllJobStates → jobStateToSession[] → 过滤 status='unknown'
//   → 给 stopped 名字加 🛑 前缀 / done 加 ✅ 前缀
//   → attachRosterSources(roster.json 补 dispatch.source)
//   → 给 settled session source 兜底(roster 清空后走 daemon.log claimedSources)
//   → cold-path name fallback(state.json.name 为空时走 JSONL first-prompt 推断)
//   → filterUserDispatched
//
// `claude agents --json` 调用保留作 smoke test(确认 CLI 健康 / 给 daemon 心跳),
// 返回值不再做真理源。下个 release 可彻底去掉这一步。
//
// 测试 hook 见 _jobStateHooks。v2.2 时代的 _nameCacheHooks / _jsonlIndexHooks /
// enrichCompletedSessions 全部退役 — state.json 直接提供 name / cwd / status /
// linkScanPath,无需绕道还原。

import { execFile } from 'node:child_process';
import { VersionGuard } from './version-guard';
import { DaemonProbe } from './daemon-probe';
import { attachRosterSources, filterUserDispatched } from './snapshot';
import { readRoster, buildRosterSourceMap } from './roster-source';
import { readClaimedSources } from './daemon-log-reader';
import { deriveNameFromJsonl } from './jsonl-name';
import { readAllJobStates, jobStateToSession } from './job-state';
import { logger } from '../utils/logger';
import type { AgentSession, AgentSessionSource } from './types';

export type FetchResult =
  | { ok: true; sessions: AgentSession[] }
  | { ok: false; reason: string };

// 测试 hook:让 tests 替换数据源 + 冷路径 + 副信号源(daemon.log claimed tail)
// 全部走 mutable object 而非 mock.module — 后者在 Bun 跨文件不可撤销,会污染
// daemon-log-reader.test.ts / daemon-probe.test.ts 等单元测试。
export const _jobStateHooks = {
  readAllJobStates,
  deriveNameFromJsonl,
  readClaimedSources,
};

export const AgentSnapshotFetcher = {
  async fetch(): Promise<FetchResult> {
    const ver = await VersionGuard.check();
    if (!ver.ok) return { ok: false, reason: ver.reason ?? 'version check failed' };
    if (!DaemonProbe.check()) return { ok: false, reason: 'Claude daemon not running' };

    // Smoke test:确认 CLI 可用(给 daemon 心跳),返回值丢弃
    try {
      await new Promise<string>((resolve, reject) => {
        execFile('claude', ['agents', '--json'], (err, out) => {
          if (err) reject(err);
          else resolve(out);
        });
      });
    } catch (err: any) {
      return { ok: false, reason: `claude agents --json smoke test failed: ${err.message}` };
    }

    // 主数据:state.json。
    // 合并 map + filter unknown + 加 emoji prefix 在一个循环里,确保 env ↔ session
    // 配对始终用同一份 env(不依赖 sessionId.slice(0,8) 与 env.short 的隐含一致性,
    // 防 fork-from-active session 的 resumeSessionId 是 parent UUID 导致 prefix 漏加)。
    const envs = await _jobStateHooks.readAllJobStates();
    let sessions: AgentSession[] = [];
    let droppedUnknown = 0;
    const droppedStates: Set<string> = new Set();
    for (const env of envs) {
      const s = jobStateToSession(env);
      if (!s) continue;
      if (s.status === 'unknown') {
        // 未来 Claude CLI 可能加新 state 值(如 'paused')。我们仍 graceful 丢弃,
        // 但聚合一次警告让运维知道有 sessions 被吞了 — 避免"我的 session 消失了"无诊断。
        droppedUnknown++;
        droppedStates.add(String(env.state.state));
        continue;
      }
      let name = s.name;
      if (env.state.state === 'stopped' && !name.startsWith('🛑')) name = `🛑 ${name}`;
      else if (env.state.state === 'done' && !name.startsWith('✅')) name = `✅ ${name}`;
      else if (env.state.state === 'failed' && !name.startsWith('❌')) name = `❌ ${name}`;
      sessions.push(name === s.name ? s : { ...s, name });
    }
    if (droppedUnknown > 0) {
      logger.warn(
        `[agent-view] dropped ${droppedUnknown} session(s) with unknown state values ` +
        `[${[...droppedStates].join(', ')}] — Claude CLI may have added new state(s); ` +
        `consider updating jobStateToSession mapping.`,
      );
    }

    // roster.json 给 source 标签(spare/slash/fleet);settled 后 roster 已清,
    // daemon.log claimedSources 兜底
    const roster = readRoster();
    const rosterMap = buildRosterSourceMap(roster);
    const claimedSources = _jobStateHooks.readClaimedSources(24);
    sessions = sessions.map(s => {
      const short = s.sessionId.slice(0, 8);
      const src: AgentSessionSource =
        rosterMap.get(short) ?? claimedSources.get(short) ?? 'unknown';
      return { ...s, source: src };
    });

    // 冷路径 name fallback:state.json.name 为空(罕见)时走 JSONL first-prompt
    sessions = sessions.map(s => {
      // 跳过前缀 emoji 检查 (✅ 🛑 ❌ 等占位时)
      const stripped = s.name.replace(/^[✅🛑❌]\s*/, '');
      if (stripped && !/^[0-9a-f]{8}$/.test(stripped)) return s;  // 已有真名
      const short = s.sessionId.slice(0, 8);
      const derived = _jobStateHooks.deriveNameFromJsonl(short);
      if (derived) {
        // 保留 prefix(如果原 name 有 emoji)
        const prefix = s.name.startsWith('✅') ? '✅ '
          : s.name.startsWith('🛑') ? '🛑 '
          : s.name.startsWith('❌') ? '❌ '
          : '';
        return { ...s, name: `${prefix}${derived.name}`, sessionId: derived.sessionId };
      }
      return s;
    });

    sessions = filterUserDispatched(sessions);
    return { ok: true, sessions };
  },
};

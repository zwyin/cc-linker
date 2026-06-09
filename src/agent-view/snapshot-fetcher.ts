// src/agent-view/snapshot-fetcher.ts
import { execFile } from 'node:child_process';
import { VersionGuard } from './version-guard';
import { DaemonProbe } from './daemon-probe';
import { parseAgentsJson, attachRosterSources, filterUserDispatched } from './snapshot';
import { readRoster, buildRosterSourceMap } from './roster-source';
import { readCompletedSessions, readClaimedSources } from './daemon-log-reader';
import { captureNames, lookupName } from './name-cache';
import { deriveNameFromJsonl, JsonlIndex } from './jsonl-name';
import type { AgentSession, AgentSessionSource } from './types';

export type FetchResult =
  | { ok: true; sessions: AgentSession[] }
  | { ok: false; reason: string };

// v2.2.6 + v2.2.7: 内部测试 hook —— 不直接 import 调用,走 mutable 对象,
// 测试 swap 字段就能拦截。绕开 bun 的 mock.module 跨文件不可撤销限制,
// 避免污染 name-cache.test.ts / jsonl-name.test.ts。
export const _nameCacheHooks = {
  captureNames,
  lookupName,
  deriveNameFromJsonl,
};

// v2.2.x: 内部测试 hook —— 让 tests 能 swap JSONL 路径查询,避免触发真实磁盘 IO。
// enrichCompletedSessions 用它在构造 cwd 时找到 JSONL 文件位置。
export const _jsonlIndexHooks = {
  lookupPath: (short: string): string | null => {
    const idx = new JsonlIndex();
    return idx.lookup(short);
  },
};

/**
 * v2.2.x: 从 Claude Code CLI 的 JSONL 路径反推原 cwd。
 *
 * 编码规则(CLI 行为验证:`ls ~/.claude/projects/`):
 *   cwd 的每个 `/` 全部替成 `-`,leading `/` 也替(避免 `--xxx` 双横杠)。
 *   /Users/wuyujun         → -Users-wuyujun
 *   /Users/wuyujun/a b     → -Users-wuyujun-a-b   (空格保留)
 *   /Users/wuyujun/Git/cc-linker → -Users-wuyujun-Git-cc-linker
 *
 * 解码:把 projSeg(`<encoded>`)里所有 `-` 替回 `/`,前置 `/`。
 *   -Users-wuyujun                 → /Users/wuyujun
 *   -Users-wuyujun-Git-cc-linker   → /Users/wuyujun/Git/cc/linker   (有损:'-' 不可逆)
 *
 * 有损部分说明:CLI 编码不可逆(无法区分 '/Git/' 和 '-Git-')。但 cwd 在本仓库
 * 只用于:
 *   1) 卡片显示 (`card.ts:truncateCwd`)—— 显示近似即可
 *   2) buildPeekCard 透传 —— 仅显示
 *   3) `handleAttach` 等下游 —— 真值走 roster/registry 反查,不依赖这里的 cwd
 * JSONL 实际定位走 `JsonlIndex.lookup(shortId)`(`resolvePeekContent:205`),
 * 完全不依赖 cwd。所以有损 decode 不影响功能。
 */
function decodeCwdFromJsonlPath(jsonlPath: string): string {
  const segments = jsonlPath.split('/');
  // 路径形如 /Users/.../.claude/projects/<encoded>/<uuid>.jsonl
  // segments: ['', 'Users', ..., 'projects', '<encoded>', '<uuid>.jsonl']
  const projSeg = segments[segments.length - 2];
  if (!projSeg) return '';
  // CLI 编码把每个 '/' 替成 '-',所以 encoded 形如 -Users-wuyujun-Git-cc-linker。
  // naive 全替回 '/' 会把原始的 '-' 也吞掉(信息丢失,见上),但能恢复最常见
  // 形态且生成的路径在 Feishu 卡上"看着像"路径。比空串好用。
  return projSeg.replace(/-/g, '/');
}

/**
 * v2.2.4 新增 / v2.2.5 修正 / v2.2.6 接入 name-cache / v2.2.7 加 JSONL 兜底:
 * 为已 settled (status='done') 的 session 拼装 AgentSession。
 *
 * - 跳过仍然在 active(--json)列表中的,避免和 active session 重复
 * - 跳过 'killed'(TUI 也不展示,只展示 'done')
 * - source 优先级:roster(仍在飞)> daemon.log claimed 事件 > 'unknown'
 *   这样能在 settled 之后还原最初的 dispatch.source,用于在 filterUserDispatched
 *   把 'spare' 完成项正确过滤掉。
 * - name 优先级(v2.2.7):
 *     1) name-cache(v2.2.6 hot path,active 期被 observe 过的 session)
 *     2) JSONL 直读 + 写回 cache(v2.2.7 新增,bot 启动之前就 settled 的 session)
 *     3) short hash 兜底
 *   v2.2.4 的 `claude logs <short>` 这一层 v2.2.7 整段删掉 —— 它对 settled session
 *   100% 失败(daemon 已清 worker),只贡献 3s timeout 没有任何成功案例。
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

    // Name: cache hit → JSONL direct read → short hash
    let name: string | undefined;
    let resolvedSessionId: string | undefined;
    // v2.2.17: JSONL 派生优先于 cache,自我修复缓存污染。之前 v2.2.16 优先
    // 走 cache(可能含错误的 name —— 比如 d78c8339 缓存着 "sleep 30 && echo done",
    // 实际它是 "Print date every five seconds"),新数据进来也覆盖不掉。
    // 现在逻辑:有 JSONL 对话就用 JSONL 的 first user prompt,没 JSONL 才用缓存
    // 兜底,缓存再没就 short。
    const cached = _nameCacheHooks.lookupName(short);
    const fromJsonl = _nameCacheHooks.deriveNameFromJsonl(short);
    if (fromJsonl) {
      // JSONL 权威 —— 直接覆盖缓存(下一次 captureNames 把 fresh name 写回)
      name = fromJsonl.name;
      resolvedSessionId = fromJsonl.sessionId;
      _nameCacheHooks.captureNames([{ sessionId: fromJsonl.sessionId, name: fromJsonl.name }]);
    } else if (cached) {
      // JSONL 没内容(典型:bg 派发后没用户输入,JSONL 只有 metadata),用缓存
      // 兜底。缓存里可能也是错的,但我们没更好来源。
      name = cached;
    }
    if (!name) name = short;

    // v2.2.x: 从 JSONL 路径反推 cwd,让 Peek 按钮 value.cwd 非空。
    // 之前 cwd='' 导致 `card.ts` 渲染的 Peek 按钮 value.cwd='',
    // `action.ts:isAgentViewValue` 要求 str('cwd') 非空 → guard 失败 →
    // dispatcher 落 legacy switch default → bot.ts:639 报"未知操作: agent_view_peek"。
    // 修法:completed session 的 JSONL 路径(~/.claude/projects/<encoded>/<uuid>.jsonl)
    // 仍可定位,反推 cwd 让 Peek value 完整;Attach/Reply/Stop 等"需要 live process"
    // 的按钮仍由 UI 层在 completed 上禁用(completed 没有活 worker)。
    let cwd = '';
    const jsonlPath = _jsonlIndexHooks.lookupPath(short);
    if (jsonlPath) {
      cwd = decodeCwdFromJsonlPath(jsonlPath);
    }

    result.push({
      pid: 0,
      cwd,
      kind: 'background',
      startedAt: settledAt,
      // 拿到 full UUID 时用 full UUID,否则继续退化到 short hash
      sessionId: resolvedSessionId ?? short,
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

      // v2.2.6: 把当前 active session 的 {short → name} 写进 name-cache。
      // 之后这些 session settled 时,enrichCompletedSessions 能从 cache 拿回真名,
      // 不必再让 Feishu 显示一排 `273a5566` 这样的 short hash。
      // 走 _nameCacheHooks 间接调用是为了让 tests 能 swap 这俩函数 ——
      // bun 的 mock.module 在跨文件场景下不可撤销,会污染 name-cache.test.ts。
      _nameCacheHooks.captureNames(sessions);

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

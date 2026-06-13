import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { readJobState } from './job-state';
import { CLAUDE_JOBS_DIR } from '../utils/paths';

export type IneligibleReason =
  | 'bg_busy'            // tempo=active OR running/working 无 needs
  | 'no_rendezvous_sock' // roster 缺该字段
  | 'daemon_down'        // state.json 缺失 / sock 物理不存在
  ;

export interface RendezvousEligibility {
  canUse: boolean;
  reason: 'bg_waiting' | 'bg_resumable' | IneligibleReason;
  rendezvousSock?: string;
  jsonlPath?: string;
  /**
   * v2.4.x: jobs dir 路径 (~/.claude/jobs/)。传给 RendezvousClient.injectReply
   * 的 stateJsonPath 选项, 启用"提交 + state.json 轮询"新协议。
   * 不传 → RendezvousClient 走旧 long-lived-connection 实现(老 mock 路径)。
   */
  stateJsonPath?: string;
}

export interface EligibilityContext {
  /** Override jobs dir for tests; default CLAUDE_JOBS_DIR (~/.claude/jobs) */
  jobsDir?: string;
  /** Override roster path for tests; default ~/.claude/daemon/roster.json */
  rosterPath?: string;
}

/**
 * Read roster.json from a given path. Returns null if missing or malformed.
 * This is a minimal wrapper; production uses readRoster() from roster-source.ts
 * but that doesn't accept a custom path (needed for tests).
 */
function readRosterFromPath(rosterPath: string): any | null {
  if (!existsSync(rosterPath)) return null;
  try {
    return JSON.parse(readFileSync(rosterPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Decide whether the rendezvous socket path is usable for a given session.
 *
 * Decision tree:
 *   1. state.json exists & parseable? (via readJobState with retry for torn writes)
 *      - No → daemon_down
 *   2. bg is in waiting state? (tempo=blocked + needs, OR running/working with needs)
 *      - No → bg_busy
 *   3. roster.json has this short with rendezvousSock?
 *      - No → no_rendezvous_sock or daemon_down
 *   4. rendezvousSock file exists on disk and is a socket?
 *      - No → daemon_down
 *   5. → canUse=true, reason=bg_waiting
 *
 * Note: CLI version check removed — rendezvousSock field is only populated
 * by CLI >= 2.1.139, so its presence implies the version is new enough.
 */
export async function checkRendezvousEligibility(
  short: string,
  ctx: EligibilityContext = {},
): Promise<RendezvousEligibility> {
  const jobsDir = ctx.jobsDir ?? CLAUDE_JOBS_DIR;

  // 1. state.json (with tear-write retry via readJobState)
  const jobState = await readJobState(short, jobsDir);
  if (!jobState) {
    return { canUse: false, reason: 'daemon_down' };
  }
  const state = jobState.state;

  // 2. bg state check (refined for Attach path, v2.4.x)
  // Eligible states (probe 2026-06-13 + probe 3 2026-06-11):
  //   - blocked (waiting for user input)
  //   - done / stopped / tempo=idle (daemon respawns worker on reply inject)
  // Ineligible:
  //   - running / working without needs (bg processing, concurrent turn risk)
  //   - unknown future states (forward-compat: fail safe)
  const isEligible = (() => {
    if (state.state === 'blocked') return true;
    if (state.state === 'done') return true;
    if (state.state === 'stopped') return true;
    // 'done' already caught above (line 85); this branch handles forward-compat
    // unknown states with tempo=idle (probe 2026-06-13 forward-compat test).
    if (state.tempo === 'idle') return true;
    if ((state.state === 'running' || state.state === 'working') && state.needs) return true;
    return false;
  })();
  if (!isEligible) {
    return { canUse: false, reason: 'bg_busy' };
  }

  // 3. roster
  const rosterPath = ctx.rosterPath ?? join(process.env.HOME ?? '', '.claude', 'daemon', 'roster.json');
  const roster = readRosterFromPath(rosterPath);
  if (!roster) {
    return { canUse: false, reason: 'daemon_down' };
  }
  const worker = roster.workers?.[short] as any;
  if (!worker?.rendezvousSock) {
    return { canUse: false, reason: 'no_rendezvous_sock' };
  }
  const sock: string = worker.rendezvousSock;

  // 4. sock file exists and is a socket
  if (!existsSync(sock)) {
    return { canUse: false, reason: 'daemon_down' };
  }
  try {
    if (!statSync(sock).isSocket()) {
      return { canUse: false, reason: 'daemon_down' };
    }
  } catch {
    return { canUse: false, reason: 'daemon_down' };
  }

  return {
    canUse: true,
    reason: (state.state === 'blocked' || state.needs) ? 'bg_waiting' : 'bg_resumable',
    rendezvousSock: sock,
    jsonlPath: state.linkScanPath ?? undefined,
    stateJsonPath: jobsDir,
  };
}

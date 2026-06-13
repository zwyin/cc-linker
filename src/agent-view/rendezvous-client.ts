import * as net from 'net';
import { readJobState } from './job-state';

export type RendezvousCompletionReason =
  | 'done'           // state=done
  | 'user_stopped'   // state=stopped + detail=killed
  | 'new_needs'      // tempo=blocked + needs non-empty
  | 'idle'           // tempo=idle + no needs
  | 'stopped'        // state=stopped (other)
  ;

export type RendezvousFailureReason =
  | 'timeout'
  | 'socket_closed'
  | 'daemon_error'
  | 'state_error'
  | 'aborted'
  ;

export interface StatePatch {
  tempo?: 'active' | 'blocked' | 'idle';
  needs?: string;
  state?: 'running' | 'working' | 'blocked' | 'done' | 'stopped' | 'error';
  detail?: string;
  inFlight?: { tasks: number; queued: number; kinds: string[] };
}

interface PatchEnvelope {
  type: string;
  patch?: StatePatch;
}

export interface RendezvousReplyOptions {
  short: string;
  text: string;
  rendezvousSock: string;
  timeoutMs?: number;
  onStatePatch?: (patch: StatePatch) => void;
  /**
   * v2.4.x: jobs dir 路径 (~/.claude/jobs/ 或测试 fixture dir)。
   * 提供时启用"提交 + state.json 轮询"新协议路径(真 daemon 行为)。
   * 不提供时走旧 long-lived-connection 实现(老 mock 测试用)。
   *
   * 提供该选项 = 承认 bg 完成信号走 state.json 而非 socket, 这样:
   *   - 0 patches + close 不再误判为"daemon 死"
   *   - bg 完成(done/stopped/blocked+needs)能可靠识别
   */
  stateJsonPath?: string;
}

/**
 * v2.4.x 流式 reply 选项。
 * 配合 pollStateJsonStreaming 使用, 让 caller 在 bg 处理期间实时
 * 更新 UI(例如流式 patch 飞书卡片)。
 */
export interface PollStreamingOptions {
  short: string;
  stateJsonPath: string;
  timeoutMs?: number;
  /** 轮询间隔 (ms). 默认 500。 */
  pollIntervalMs?: number;
  /**
   * 可选 AbortSignal。signal.aborted 时 poll 循环立即退出, 返回
   * { ok: false, reason: 'aborted', durationMs, patches }。Loop 头部检查覆盖
   * pre-aborted (循环还没跑) + sleep-then-abort (上轮 sleep 期间 abort) 两种情形。
   */
  signal?: AbortSignal;
  /**
   * 每次 poll 调一次。state.kind 描述当前 bg 状态:
   *   - 'active': bg 在处理中(running/working + tempo=active 且无 needs)
   *   - 'blocked-needs': bg 等用户回答(state=blocked + needs, 或
   *     state in {running, working} + needs — CLI 2.1.163 行为)
   *   - 'done': bg 完成(state=done)
   *   - 'stopped': bg 被停(state=stopped)
   *   - 'error': bg 报失败(state=error)
   * 返回 'stop' 提前结束轮询(不会改最终 result 的 reason)。
   */
  onPoll: (state: {
    kind: 'active' | 'blocked-needs' | 'done' | 'stopped' | 'error';
    raw: any;
  }) => Promise<'stop' | void> | 'stop' | void;
}

export interface RendezvousReplyResult {
  ok: boolean;
  reason: RendezvousCompletionReason | RendezvousFailureReason;
  text?: string;
  tokens?: { input: number; output: number; cacheCreation?: number; cacheRead?: number };
  durationMs?: number;
  patches?: StatePatch[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
const SUBMIT_TIMEOUT_MS = 200;  // Phase 1 提交超时: 200ms 内能 write 完无 error 即视为 submitted
const POLL_INTERVAL_MS = 500;    // Phase 2 轮询间隔

export class RendezvousClient {
  /**
   * Send a reply to a running bg worker via the rendezvous socket.
   *
   * v2.4.x 协议修正(基于 docs/qa/2026-06-11-rendezvous-probe-notes.md 实测):
   *   真 daemon 行为是 fire-and-forget —— 收 reply 行后发 1 个 ack patch, 立即 close;
   *   bg 异步 respawn+处理, 进度走 state.json, 不走 socket。
   *   旧假设"长连接 + 流式 patch"是错误的, 导致用户场景下 socket_closed 误报。
   *
   * 两条路径:
   *   1. opts.stateJsonPath 提供 → 新协议: 提交 + state.json 轮询
   *      Phase 1: 200ms fire-and-forget 提交, 收/不收 ack 都算 submitted
   *               (daemon 收完即关是正常路径)
   *      Phase 2: 轮询 state.json 直到 done / stopped / blocked+needs / timeout
   *   2. opts.stateJsonPath 不提供 → 旧实现: 长连接等 patch
   *      保留是为了不破坏老 mock 测试(它们的 mock 实现了错误的长连接协议)
   */
  static async injectReply(opts: RendezvousReplyOptions): Promise<RendezvousReplyResult> {
    if (opts.stateJsonPath) {
      return RendezvousClient.injectReplyWithStateJson(opts);
    }
    return RendezvousClient.injectReplyLegacy(opts);
  }

  /**
   * v2.4.x 新协议: 提交 + state.json 轮询。
   *
   * 行为:
   *   - Phase 1 (≤200ms): 写 reply, 等 connect/close 之一。ECONNREFUSED 等真错 → 真失败
   *   - Phase 2 (剩余 timeoutMs): 轮询 state.json, 终结即返
   *     - state=done → ok=true, reason=done
   *     - state=stopped → ok=true, reason=stopped
   *     - state=blocked && needs → ok=true, reason=new_needs
   *     - state=error → ok=false, reason=state_error
   *     - 超时 → ok=false, reason=timeout
   *     - state.json 缺失 → ok=false, reason=daemon_error
   */
  private static async injectReplyWithStateJson(
    opts: RendezvousReplyOptions,
  ): Promise<RendezvousReplyResult> {
    const start = Date.now();

    // Phase 1: fire-and-forget 提交
    const submit = await RendezvousClient.submitReplyInternal(opts.rendezvousSock!, opts.text);
    if (submit === 'rejected') {
      // 真连接失败 (ECONNREFUSED / EPIPE / EACCES 等)。bg 大概率死了。
      return {
        ok: false,
        reason: 'socket_closed',
        durationMs: Date.now() - start,
      };
    }

    // Phase 2: 轮询 state.json
    return RendezvousClient.pollStateJson(opts, start);
  }

  /**
   * v2.4.x 公开 Phase 1 提交 (fire-and-forget)。给流式 reply 路径用,
   * 让 caller 自己接 pollStateJsonStreaming 控流(不通过 injectReply 的黑盒)。
   *
   * @param sock rendezvous socket 路径
   * @param text reply 文本
   * @returns 'submitted' (daemon 接受) 或 'rejected' (ECONNREFUSED 等真连接失败)
   */
  static async submitReplyOnly(
    sock: string,
    text: string,
  ): Promise<'submitted' | 'rejected'> {
    return RendezvousClient.submitReplyInternal(sock, text);
  }

  /**
   * Fire-and-forget 提交。在 SUBMIT_TIMEOUT_MS (200ms) 内:
   *   - socket 发生 error (ECONNREFUSED 等) → 'rejected' (真连接失败)
   *   - 否则 (正常 write + close / write 后等 200ms) → 'submitted' (daemon 接受了)
   */
  private static submitReplyInternal(
    sock: string,
    text: string,
  ): Promise<'submitted' | 'rejected'> {
    return new Promise(resolve => {
      const socket = net.createConnection(sock);
      let resolved = false;
      const finish = (result: 'submitted' | 'rejected') => {
        if (resolved) return;
        resolved = true;
        try { socket.destroy(); } catch { /* ignore */ }
        resolve(result);
      };
      const submitTimer = setTimeout(() => finish('submitted'), SUBMIT_TIMEOUT_MS);
      socket.on('connect', () => {
        socket.write(JSON.stringify({ type: 'reply', text }) + '\n');
      });
      socket.on('error', () => {
        clearTimeout(submitTimer);
        finish('rejected');
      });
      // close 不算 rejected: daemon 收完行主动关是正常路径。
      // 如果 error 在 close 之前到, error 路径先 fire, finish 走 rejected;
      // 如果只有 close 没 error, 200ms 定时器 fire 'submitted'。
      socket.on('close', () => { /* no-op: 走定时器 */ });
    });
  }

  /**
   * 轮询 state.json 直到终结或超时。
   */
  private static async pollStateJson(
    opts: RendezvousReplyOptions,
    start: number,
  ): Promise<RendezvousReplyResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const patches: StatePatch[] = [];
    const onPatch = opts.onStatePatch;

    while (Date.now() - start < timeoutMs) {
      const outcome = await pollStateJsonOnce(opts.short, opts.stateJsonPath!);
      if (outcome.kind === 'missing') {
        return {
          ok: false,
          reason: 'daemon_error',
          durationMs: Date.now() - start,
          patches,
        };
      }
      const { stateObj, patch } = outcome;
      patches.push(patch);
      if (onPatch) onPatch(patch);

      const result = classifyPatchFromState(stateObj);
      if (result.kind !== 'pending') {
        return {
          ok: result.kind === 'completed',
          reason: result.reason,
          durationMs: Date.now() - start,
          patches,
        };
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    return {
      ok: false,
      reason: 'timeout',
      durationMs: Date.now() - start,
      patches,
    };
  }

  /**
   * v2.4.x 流式版本: 每次 poll 调 onPoll 回调, 让 caller 在 bg 处理期间
   * 实时更新 UI(流式 patch 卡片)。
   *
   * 与 injectReply 的区别:
   *   - injectReply 一次返回所有结果(适合"等全跑完一次性发消息")
   *   - pollStateJsonStreaming 持续回调(适合"边等边更新卡片")
   *
   * 行为:
   *   - 每 pollIntervalMs 读一次 state.json
   *   - onPoll 拿到的 kind 描述当前 bg 状态
   *   - 终结(done/stopped/blocked-needs/error) → 返对应 reason
   *   - 超时 → reason='timeout'
   *   - state.json 缺失 → 立即 reason='daemon_error'(不调 onPoll)
   *   - onPoll 返 'stop' → 提前结束(用最后一次 poll 状态判定 reason)
   */
  static async pollStateJsonStreaming(
    opts: PollStreamingOptions,
  ): Promise<RendezvousReplyResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    const start = Date.now();
    const patches: StatePatch[] = [];
    let lastState: any = null;
    let stoppedByUser = false;
    // v2.4.1: 抑制 supervisor 未反应的"假 terminal"
    // 注入 reply 后第一次 poll 仍可能是 supervisor 还没反应的旧 state。
    // 替换 sawActive 为 sawStateChange (任何 state/tempo 变化):
    //   - done bg: supervisor 直接 done → blocked (不经 running), sawStateChange 触发
    //   - stopped bg: supervisor stopped → running → blocked, sawStateChange 在 running 触发
    //   - waiting bg: supervisor blocked+needs → running → blocked+needs, sawStateChange 在 running 触发
    // 看到 state/tempo 任何变化后,后续 terminal 才信任。
    let sawStateChange = false;
    let firstState: any = null;

    while (Date.now() - start < timeoutMs) {
      // Abort 优先于其他终结条件。Loop 头部检查覆盖 pre-aborted (循环还没跑) +
      // sleep-then-abort (上轮 sleep 期间 abort) 两种情形。
      if (opts.signal?.aborted) {
        return { ok: false, reason: 'aborted', durationMs: Date.now() - start, patches };
      }
      const outcome = await pollStateJsonOnce(opts.short, opts.stateJsonPath);
      if (outcome.kind === 'missing') {
        return {
          ok: false,
          reason: 'daemon_error',
          durationMs: Date.now() - start,
          patches,
        };
      }
      const { stateObj, patch } = outcome;
      lastState = stateObj;
      patches.push(patch);

      // v2.4.1: 第一次 poll 捕获 firstState;后续 poll 对比 state/tempo 字段
      // 任一变化就标记 sawStateChange=true (永不复位)
      if (firstState === null) {
        firstState = stateObj;
      } else if (
        stateObj.state !== firstState.state ||
        stateObj.tempo !== firstState.tempo
      ) {
        sawStateChange = true;
      }

      const kind = streamStateKind(stateObj);

      // v2.4.1: 未见 state 变化之前的 terminal state 可能是 supervisor 未反应的旧 state。
      // 跳过本次分类,但仍调 onPoll 让 caller 更新 elapsed time (避免 card 卡在"0s")。
      if (kind !== 'active' && !sawStateChange) {
        await opts.onPoll({ kind, raw: stateObj });
        await new Promise(r => setTimeout(r, pollIntervalMs));
        continue;
      }

      const userDecision = await opts.onPoll({ kind, raw: stateObj });
      if (userDecision === 'stop') {
        stoppedByUser = true;
        break;
      }

      if (kind !== 'active') {
        // 终结: done / stopped / blocked-needs / error
        const result = classifyPatchFromState(stateObj);
        if (result.kind === 'pending') {
          return {
            ok: false,
            reason: 'timeout',
            durationMs: Date.now() - start,
            patches,
          };
        }
        return {
          ok: result.kind === 'completed',
          reason: result.reason,
          durationMs: Date.now() - start,
          patches,
        };
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    if (stoppedByUser && lastState) {
      const result = classifyPatchFromState(lastState);
      if (result.kind !== 'pending') {
        return {
          ok: result.kind === 'completed',
          reason: result.reason,
          durationMs: Date.now() - start,
          patches,
        };
      }
    }

    // v2.4.1: timeout 但从未见过 active → supervisor 可能根本没反应
    // (daemon down / 注入失败),返回 timeout 让上层提示用户
    return {
      ok: false,
      reason: 'timeout',
      durationMs: Date.now() - start,
      patches,
    };
  }

  /**
   * 旧 long-lived-connection 实现。保留给老 mock 测试用(它们的 mock 模拟了
   * 错误的长连接协议)。生产代码应走 injectReplyWithStateJson 路径。
   */
  private static async injectReplyLegacy(
    opts: RendezvousReplyOptions,
  ): Promise<RendezvousReplyResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    return new Promise<RendezvousReplyResult>(resolve => {
      const socket = net.createConnection(opts.rendezvousSock);
      const patches: StatePatch[] = [];
      let resolved = false;
      let buffer = '';

      const cleanup = () => {
        socket.destroy();
      };

      const finish = (result: RendezvousReplyResult) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      };

      const timeoutTimer = setTimeout(() => {
        finish({ ok: false, reason: 'timeout', durationMs: Date.now() - start, patches });
      }, timeoutMs);

      socket.on('connect', () => {
        // Send the reply
        const line = JSON.stringify({ type: 'reply', text: opts.text }) + '\n';
        socket.write(line);
      });

      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          let env: PatchEnvelope;
          try {
            env = JSON.parse(line);
          } catch {
            continue; // skip torn lines
          }
          if (env.type === 'error') {
            clearTimeout(timeoutTimer);
            finish({ ok: false, reason: 'daemon_error', durationMs: Date.now() - start, patches });
            return;
          }
          if (env.type === 'state' && env.patch) {
            patches.push(env.patch);
            if (opts.onStatePatch) opts.onStatePatch(env.patch);
            const result = classifyPatch(env.patch);
            if (result.kind !== 'pending') {
              clearTimeout(timeoutTimer);
              finish({
                ok: result.kind === 'completed',
                reason: result.reason,
                durationMs: Date.now() - start,
                patches,
              });
              return;
            }
          }
        }
      });

      socket.on('close', () => {
        if (!resolved) {
          clearTimeout(timeoutTimer);
          finish({ ok: false, reason: 'socket_closed', durationMs: Date.now() - start, patches });
        }
      });

      socket.on('error', () => {
        if (!resolved) {
          clearTimeout(timeoutTimer);
          finish({ ok: false, reason: 'socket_closed', durationMs: Date.now() - start, patches });
        }
      });
    });
  }
}

/**
 * Classify a state patch as completed, failed, or still pending.
 *
 *   {kind:'completed', reason}  →  ok=true
 *   {kind:'failed',    reason}  →  ok=false (no fallback possible)
 *   {kind:'pending'}            →  no terminal event yet
 */
type Classification =
  | { kind: 'completed'; reason: RendezvousCompletionReason }
  | { kind: 'failed'; reason: RendezvousFailureReason }
  | { kind: 'pending' }
  ;

function classifyPatch(patch: StatePatch): Classification {
  if (patch.state === 'done') return { kind: 'completed', reason: 'done' };
  if (patch.state === 'stopped') {
    return { kind: 'completed', reason: patch.detail === 'killed' ? 'user_stopped' : 'stopped' };
  }
  // state=error: bg 自己报失败. 不等 timeout, 立即 finish 为 ok=false.
  if (patch.state === 'error') return { kind: 'failed', reason: 'state_error' };
  if (patch.tempo === 'blocked' && patch.needs && patch.needs.length > 0) {
    return { kind: 'completed', reason: 'new_needs' };
  }
  if (patch.tempo === 'idle' && !patch.needs) {
    return { kind: 'completed', reason: 'idle' };
  }
  return { kind: 'pending' };
}

/**
 * v2.4.x: 从 state.json 内容分类终结状态。比 classifyPatch 多了
 * "state in {running, working} && needs" 的情况 —— Claude CLI 2.1.163
 * 把 needs 与 state 解耦, 这种情况 bg 实际在等用户回答, 视为 new_needs。
 */
function classifyPatchFromState(state: any): Classification {
  if (state.state === 'done') return { kind: 'completed', reason: 'done' };
  if (state.state === 'stopped') {
    return { kind: 'completed', reason: state.detail === 'killed' ? 'user_stopped' : 'stopped' };
  }
  if (state.state === 'error') return { kind: 'failed', reason: 'state_error' };
  // blocked + needs → 用户被问问题
  if (state.state === 'blocked' && state.needs) {
    return { kind: 'completed', reason: 'new_needs' };
  }
  // running/working + needs → CLI 2.1.163 行为: worker 进程在跑但已经在问用户
  // (job-state.ts:209 的 "伪 busy 实 waiting" 情况)
  if ((state.state === 'running' || state.state === 'working') && state.needs) {
    return { kind: 'completed', reason: 'new_needs' };
  }
  // tempo=idle + no needs → bg 完成但没 state=done 的过渡瞬间
  if (state.tempo === 'idle' && !state.needs && state.state !== 'done') {
    return { kind: 'completed', reason: 'idle' };
  }
  return { kind: 'pending' };
}

/**
 * v2.4.x: 给 pollStateJsonStreaming 用。把 state.json 状态映射到
 * 流式回调用的 kind(active 表示"还在跑, 继续 poll")。
 */
function streamStateKind(state: any):
  | 'active'
  | 'blocked-needs'
  | 'done'
  | 'stopped'
  | 'error'
{
  if (state.state === 'done') return 'done';
  if (state.state === 'stopped') return 'stopped';
  if (state.state === 'error') return 'error';
  if (state.state === 'blocked' && state.needs) return 'blocked-needs';
  if ((state.state === 'running' || state.state === 'working') && state.needs) {
    return 'blocked-needs';
  }
  return 'active';
}

/**
 * 读 state.json 一次, 返 state 对象 + patch。missing → {kind: 'missing'}。
 * 给 pollStateJson 和 pollStateJsonStreaming 共享, 避免读盘逻辑重复。
 *
 * stateObj 是 JobStateFile (state.json 的实际内容, 不是 envelope)。
 */
type PollOnce =
  | { kind: 'ok'; stateObj: any; patch: StatePatch }
  | { kind: 'missing' };

async function pollStateJsonOnce(short: string, jobsDir: string): Promise<PollOnce> {
  const env = await readJobState(short, jobsDir);
  if (!env) return { kind: 'missing' };
  const patch: StatePatch = {
    state: env.state.state as any,
    tempo: env.state.tempo as any,
    needs: env.state.needs ?? undefined,
    detail: env.state.detail ?? undefined,
  };
  return { kind: 'ok', stateObj: env.state, patch };
}

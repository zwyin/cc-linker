import * as net from 'net';

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

export class RendezvousClient {
  /**
   * Send a reply to a running bg worker via the rendezvous socket.
   *
   * Protocol (single line NDJSON):
   *   - Client sends: {"type":"reply","text":"<user text>"}\n
   *   - Daemon responds with one or more:
   *       {"type":"state","patch":{...}}
   *   - Connection stays open until bg completes, errors, or times out.
   *
   * Returns on first completion trigger:
   *   - state='done'                       → reason='done'
   *   - state='stopped' + detail='killed'  → reason='user_stopped'  (S4)
   *   - state='stopped' (other)            → reason='stopped'
   *   - tempo='blocked' + needs non-empty  → reason='new_needs'
   *   - tempo='idle' + no needs            → reason='idle'
   *
   * Returns failure:
   *   - 60s timeout, no completion         → reason='timeout'
   *   - socket closed mid-wait             → reason='socket_closed'
   *   - daemon error JSON                  → reason='daemon_error'
   *   - patch with state='error'           → reason='state_error'
   */
  static async injectReply(opts: RendezvousReplyOptions): Promise<RendezvousReplyResult> {
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

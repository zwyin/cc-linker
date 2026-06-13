// src/agent-view/job-state.ts
//
// 从 ~/.claude/jobs/<short>/state.json 读取 Claude CLI 维护的权威 job 状态。
//
// 背景:Claude CLI v2.1.163 的 `claude agents --json` 把所有 background session
// 都返回 status="idle",丢失了真实状态。CLI 自己用 ~/.claude/jobs/<short>/state.json
// 维护权威状态机(running / working / blocked / done / stopped),TUI 也走这个来源。
// 这个模块就是去读它。
//
// 读取语义:每个 fetch 都重新读盘,不做模块级缓存(snapshot-fetcher.fetch 自己有
// 2s debounce)。malformed / missing / 类型错误一律静默 → null,调用方按"无此 session"
// 处理。未识别的 state 值(如未来新增的 'paused')透传 — 映射函数会把它转成 'unknown'
// AgentSessionStatus。

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { CLAUDE_JOBS_DIR } from '../utils/paths';
import { logger } from '../utils/logger';
import type { AgentSession, AgentSessionStatus } from './types';

/** CLI 在 state.json 里写出的所有已知 state 值(forward-compat:未知值透传)。 */
export type JobStateValue = 'running' | 'working' | 'blocked' | 'done' | 'stopped' | 'failed';
export type JobStateTempo = 'idle' | 'active' | 'blocked';

export interface JobStateFile {
  state: JobStateValue | string;  // string = forward-compat
  tempo?: JobStateTempo | string;
  detail: string | null;
  needs: string | null;
  inFlight: { tasks: number; queued: number; kinds: string[] } | null;
  linkScanPath: string | null;
  linkScanOffset: number;
  name: string | null;
  nameSource?: 'auto' | 'user' | string;
  intent?: string;
  resumeSessionId?: string;
  daemonShort?: string;
  template?: 'bg' | 'interactive' | string;
  respawnFlags?: string[];
  cliVersion?: string;
  cwd?: string;
}

export interface JobStateEnvelope {
  short: string;       // 目录名 = 8 字符 hash
  path: string;        // state.json 绝对路径(诊断用)
  state: JobStateFile;
  mtimeMs: number;     // 文件 mtime(快照新鲜度参考)
  readAt: number;      // wall-clock,parse 时刻
}

/** 内部:已经为这个 short 报过 read 错误,避免每次 fetch 都刷屏 */
const reportedErrors = new Set<string>();

function reportOnce(short: string, msg: string): void {
  if (reportedErrors.has(short)) return;
  reportedErrors.add(short);
  logger.warn(`[job-state] ${short}: ${msg}`);
}

/**
 * 校验解析出的对象是合法的 JobStateFile(必填字段存在 + 类型大致 OK)。
 * 不要求 state 是已知 enum 值(未来加 'paused' 我们也不应该报错)。
 */
export function validateJobStateShape(raw: unknown): raw is JobStateFile {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as any;
  if (typeof r.state !== 'string' || r.state.length === 0) return false;
  // detail / needs 可以是 null 或 string;其他字段缺省时容忍 — 上面 interface 已经把
  // 大部分字段标 optional,这里只 enforce 最关键的 state。
  return true;
}

/**
 * 读取单个 job 的 state.json。**Async** — 第一次 parse 失败时 await 20ms 重试一次
 * 治 Claude CLI 撕裂写。
 *
 * @param short 8 字符 hash(也是子目录名);测试可传 fixture 文件名(无 .json 后缀)
 *              如 'neg-bad-json',此时函数会查 jobsDir/<short>.json
 * @param jobsDir 默认 CLAUDE_JOBS_DIR,测试用 fixture 路径覆盖
 *
 * 并发写竞争(v2.3.1):Claude CLI 在 state transition 时写 state.json,
 * 我们若同时读到撕裂字节 → JSON.parse 失败。第一次失败 await 20ms 重读一次,
 * 治 race 让 session 不再"从飞书卡上消失 2-10 秒后才回来"。两次都失败才
 * reportOnce 警告 + 返回 null。
 */
export async function readJobState(
  short: string,
  jobsDir: string = CLAUDE_JOBS_DIR,
): Promise<JobStateEnvelope | null> {
  // production:jobsDir/<short>/state.json
  // fixture:  jobsDir/<short>.json(测试模式)
  const candidate1 = join(jobsDir, short, 'state.json');
  const candidate2 = join(jobsDir, `${short}.json`);
  const path = existsSync(candidate1) ? candidate1
    : existsSync(candidate2) ? candidate2
    : null;
  if (!path) return null;

  // 读 + parse,失败时 async 等 20ms 重试一次治撕裂写
  const env = tryReadOnce(short, path);
  if (env) return env;
  // race retry — async sleep 20ms 让 CLI 写完
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  const env2 = tryReadOnce(short, path);
  if (env2) return env2;
  // 两次都挂 → 真坏文件,reportOnce 记日志(默认行为)
  reportOnce(short, `state.json read/parse failed after one retry`);
  return null;
}

/** Internal: single read + parse + shape validate. Returns envelope or null silently. */
function tryReadOnce(short: string, path: string): JobStateEnvelope | null {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(path, 'utf8');
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;  // race-induced parse error — caller will retry
  }
  if (!validateJobStateShape(parsed)) return null;
  return { short, path, state: parsed, mtimeMs, readAt: Date.now() };
}

/**
 * 列出 ~/.claude/jobs/ 下所有 short 子目录名(不含 state.json 加载)。
 * 测试模式下也能列 fixtures 目录里所有 .json 文件名(去掉 .json)。
 *
 * 跳过规则:
 *   - 隐藏文件(. 开头)
 *   - README.md / pins.json 这类已知非-short 文件
 *   - 生产模式:只取 directory entry;fixture 模式:只取 .json file entry
 */
export function listJobShorts(jobsDir: string = CLAUDE_JOBS_DIR): string[] {
  if (!existsSync(jobsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(jobsDir);
  } catch {
    return [];
  }
  const shorts: string[] = [];
  for (const name of entries) {
    if (name === 'README.md' || name === 'pins.json' || name.startsWith('.')) continue;
    if (name.endsWith('.json')) {
      // fixture 模式
      shorts.push(name.replace(/\.json$/, ''));
      continue;
    }
    // production 模式:子目录
    try {
      const st = statSync(join(jobsDir, name));
      if (st.isDirectory()) shorts.push(name);
    } catch { /* skip */ }
  }
  return shorts;
}

/**
 * 并行读取 jobsDir 下所有 short 的 state.json。
 * malformed / 缺失的 silently 丢弃(reportOnce 会在 readJobState 内打 warning)。
 *
 * 并行用 Promise.all —— readJobState 在 race retry 路径会 await 20ms,
 * 串行会让 worst-case N×20ms 累加,并行让 worst-case 仍是 20ms。
 */
export async function readAllJobStates(
  jobsDir: string = CLAUDE_JOBS_DIR,
): Promise<JobStateEnvelope[]> {
  const shorts = listJobShorts(jobsDir);
  const results = await Promise.all(shorts.map(short => readJobState(short, jobsDir)));
  return results.filter((e): e is JobStateEnvelope => e !== null);
}

/**
 * 把 JobStateEnvelope 映射成 AgentSession。
 *
 * State machine:
 *   running / working  → busy
 *   blocked            → waiting (waitingFor = needs)
 *   done               → idle + completed=true
 *   stopped            → idle + completed=true  (UI 层在 name 前加 🛑 区分)
 *   failed             → idle + completed=true  (UI 层在 name 前加 ❌ 区分 — settled-with-error,
 *                                              跟 done/stopped 并列的终态,TUI 同样显示 Completed)
 *   unknown / 其他      → 'unknown' status (UI 渲染为"未知"组,snapshot-fetcher 静默 drop)
 *
 * source 字段:state.json 没有 dispatch.source,统一标 'unknown';
 *   后续 attachRosterSources 会从 roster.json / daemon.log 补上。
 */
export function jobStateToSession(env: JobStateEnvelope): AgentSession | null {
  const f = env.state;
  const stateVal = f.state;

  let status: AgentSessionStatus;
  let completed: true | undefined;
  let waitingFor: string | undefined;

  switch (stateVal) {
    case 'running':
    case 'working':
      // v2.3.7 修正:Claude CLI 行为 —— worker 进程仍在跑(state=running/working),
      // 但已经在向用户提问题(needs 字段被填),等用户回复。这种"伪 busy 实 waiting"
      // 在老 CLI 是被简化成 state=blocked 表达,但 v2.1.163 新版 cli 把 needs 与 state
      // 解耦:state 描述 worker 进程,needs 描述交互状态。我们把"worker 跑 + 问问题"
      // 也归为 waiting(让飞书卡显示 Reply 按钮)。
      if (f.needs) {
        status = 'waiting';
        waitingFor = f.needs ?? undefined;
      } else {
        status = 'busy';
      }
      break;
    case 'blocked':
      status = 'waiting';
      waitingFor = f.needs ?? undefined;
      break;
    case 'done':
      status = 'idle';
      completed = true;
      break;
    case 'stopped':
      status = 'idle';
      completed = true;
      break;
    // 2026-06-13 回归修复:Claude CLI 把 settled-with-error 标为 'failed'(实测
    // ~/.claude/jobs/*/state.json),v2.3 重构时漏了这个 case → 落 default →
    // status='unknown' → snapshot-fetcher 静默 drop,用户 Agent View 看不到
    // completed session(TUI 知道 'failed' 是 settled 状态,会显示)。
    // 修法:跟 done/stopped 并列映射到 idle+completed=true,UI 层加 ❌ prefix
    // 区分 ✅ (done) / 🛑 (stopped) / ❌ (failed)。
    case 'failed':
      status = 'idle';
      completed = true;
      break;
    default:
      status = 'unknown';
  }

  return {
    pid: 0,  // state.json 不带 pid,需要时从 roster.json 补
    cwd: f.cwd ?? '',
    kind: 'background',
    startedAt: env.mtimeMs,  // 没有真启动时间;mtime 作 elapsed 近似
    sessionId: f.resumeSessionId ?? env.short,
    name: f.name ?? env.short,
    status,
    source: 'unknown',
    ...(waitingFor !== undefined ? { waitingFor } : {}),
    ...(completed ? { completed } : {}),
    ...(f.linkScanPath ? { linkScanPath: f.linkScanPath } : {}),
    ...(f.detail ? { detail: f.detail } : {}),
    ...(f.intent ? { intent: f.intent } : {}),
  };
}

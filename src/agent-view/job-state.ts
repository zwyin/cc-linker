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

/** CLI 在 state.json 里写出的所有已知 state 值(forward-compat:未知值透传)。 */
export type JobStateValue = 'running' | 'working' | 'blocked' | 'done' | 'stopped';
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
 * 读取单个 job 的 state.json。
 * @param short 8 字符 hash(也是子目录名);测试可传 fixture 文件名(无 .json 后缀)
 *              如 'neg-bad-json',此时函数会查 jobsDir/<short>.json
 * @param jobsDir 默认 CLAUDE_JOBS_DIR,测试用 fixture 路径覆盖
 */
export function readJobState(
  short: string,
  jobsDir: string = CLAUDE_JOBS_DIR,
): JobStateEnvelope | null {
  // production:jobsDir/<short>/state.json
  // fixture:  jobsDir/<short>.json(测试模式)
  const candidate1 = join(jobsDir, short, 'state.json');
  const candidate2 = join(jobsDir, `${short}.json`);
  const path = existsSync(candidate1) ? candidate1
    : existsSync(candidate2) ? candidate2
    : null;
  if (!path) return null;

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
    reportOnce(short, `state.json parse failed (malformed JSON)`);
    return null;
  }

  if (!validateJobStateShape(parsed)) {
    reportOnce(short, `state.json shape invalid (no .state field)`);
    return null;
  }

  return {
    short,
    path,
    state: parsed,
    mtimeMs,
    readAt: Date.now(),
  };
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
 */
export function readAllJobStates(
  jobsDir: string = CLAUDE_JOBS_DIR,
): JobStateEnvelope[] {
  const shorts = listJobShorts(jobsDir);
  const envs: JobStateEnvelope[] = [];
  for (const short of shorts) {
    const env = readJobState(short, jobsDir);
    if (env) envs.push(env);
  }
  return envs;
}

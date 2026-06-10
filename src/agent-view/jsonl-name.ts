// src/agent-view/jsonl-name.ts
//
// 从 ~/.claude/projects/<proj>/<UUID>.jsonl 直读第一条用户 prompt 作为 session
// 显示名的"冷路径 fallback" + 提供 JsonlIndex 类(short → full path/UUID 查询)。
//
// v2.3 重构后:state.json.name 是权威 name 源,本模块只在 state.json.name 为空时
// 兜底(罕见,通常发生在用户直接构造 jobs 目录的场景)。JsonlIndex 仍被 bot.ts
// 用于 short → full UUID 展开(独立 concern,跟 Agent View 解耦)。
//
// 用法:`deriveNameFromJsonl(short)` 返回 `{ name, sessionId }` 或 null;
// snapshot-fetcher 在 cold path 调用。

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { basename, join } from 'path';
import { CLAUDE_PROJECTS_DIR } from '../utils/paths';
import { isCommandOutput } from '../utils/jsonl-repair';

const MAX_NAME_CHARS = 60;
const FULL_READ_THRESHOLD_BYTES = 1_000_000;
const HEAD_READ_BYTES = 64 * 1024;

// 短回复 / 续接词黑名单:这些不能当 session 名
const SHORT_REPLY_BLACKLIST = new Set([
  '继续', 'continue', 'yes', 'no', 'ok', 'okay', 'y', 'n', 'go',
  '好', '嗯', '是', '不是', '是的',
]);

interface JsonlEntry {
  type?: string;
  isMeta?: boolean;
  attachment?: unknown; // 出现该字段 = hook / skill_listing 注入,跳过
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  [k: string]: unknown;
}

/**
 * Lazy index `Map<short8, fullPath[]>` over ~/.claude/projects/*\/*.jsonl。
 *
 * 用所有 .jsonl 文件的 max mtime 做 invalidation —— 启动一次性扫,后续只在文件
 * 修改/新增时重建。多个 short 命中(撞 hash)时取 mtime 最大的(最近一条)。
 *
 * 单例 `defaultIndex` 在模块顶层;测试可以传 projectsDir override 构造独立实例。
 */
export class JsonlIndex {
  private map = new Map<string, Array<{ path: string; mtime: number }>>();
  private maxMtime = 0;

  constructor(private projectsDir: string = CLAUDE_PROJECTS_DIR) {}

  /** 确保 index 与磁盘一致,变化才重建。 */
  refresh(): void {
    if (!existsSync(this.projectsDir)) {
      this.map.clear();
      this.maxMtime = 0;
      return;
    }
    let currentMax = 0;
    const seen: Array<{ short: string; path: string; mtime: number }> = [];
    try {
      for (const proj of readdirSync(this.projectsDir)) {
        const projDir = join(this.projectsDir, proj);
        let projStat;
        try {
          projStat = statSync(projDir);
        } catch {
          continue;
        }
        if (!projStat.isDirectory()) continue;
        // 子目录 mtime 是该目录下 .jsonl 文件增删的代理信号 ——
        // 单文件 append 不改 dir mtime,但新建/删除会;粗粒度但够用
        if (projStat.mtimeMs > currentMax) currentMax = projStat.mtimeMs;
        let files: string[];
        try {
          files = readdirSync(projDir);
        } catch {
          continue;
        }
        for (const fname of files) {
          if (!fname.endsWith('.jsonl')) continue;
          const short = fname.slice(0, 8);
          const path = join(projDir, fname);
          let fStat;
          try {
            fStat = statSync(path);
          } catch {
            continue;
          }
          if (fStat.mtimeMs > currentMax) currentMax = fStat.mtimeMs;
          seen.push({ short, path, mtime: fStat.mtimeMs });
        }
      }
    } catch {
      // graceful:权限 / IO 异常时保留旧 map,不清空
      return;
    }
    if (currentMax === this.maxMtime && this.map.size > 0) return; // 没变化
    this.map.clear();
    for (const { short, path, mtime } of seen) {
      const list = this.map.get(short);
      if (list) list.push({ path, mtime });
      else this.map.set(short, [{ path, mtime }]);
    }
    this.maxMtime = currentMax;
  }

  /** 查 short → fullPath;多个命中取 mtime 最大的(最近一条)。 */
  lookup(short: string): string | null {
    this.refresh();
    const list = this.map.get(short);
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0].path;
    let best = list[0];
    for (const item of list) {
      if (item.mtime > best.mtime) best = item;
    }
    return best.path;
  }
}

const defaultIndex = new JsonlIndex();

/** 把 raw text 收成单行、截断到 60 字符,做最终展示。 */
function normalizeName(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_CHARS);
}

/** 一条 entry 的 message.content 提成 string;array 形式取第一个 text block。 */
function extractText(content: JsonlEntry['message']): string {
  if (!content) return '';
  const c = content.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const textBlock = c.find(b => b && b.type === 'text' && typeof b.text === 'string');
    return textBlock?.text ?? '';
  }
  return '';
}

/** entry 是否可以当 session name 来源。过滤规则见模块顶部注释。 */
function isCandidateUserEntry(entry: JsonlEntry, text: string): boolean {
  if (entry.type !== 'user') return false;
  if (entry.isMeta) return false;          // "Continue from where you left off" 等 Claude 续接
  if (entry.attachment) return false;       // hook_additional_context / skill_listing 等
  if (entry.message?.role !== 'user') return false;
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;     // "好" "ok" "y" 等短回复
  if (SHORT_REPLY_BLACKLIST.has(trimmed.toLowerCase())) return false;
  if (isCommandOutput(trimmed)) return false;
  return true;
}

/**
 * 逐行扫一个 JSONL,返回第一条 candidate user prompt 的原始 text(未截断)。
 * 找不到 / 读不到返回 null。
 *
 * 性能:文件 < 1MB 全读;> 1MB 只读前 64KB(第一条 user message 几乎永远在文件头)。
 */
export function extractFirstUserPrompt(jsonlPath: string): string | null {
  let raw: string;
  try {
    const st = statSync(jsonlPath);
    if (st.size > FULL_READ_THRESHOLD_BYTES) {
      // 大文件:只取前 64KB
      const fd = require('fs').openSync(jsonlPath, 'r');
      try {
        const buf = Buffer.alloc(HEAD_READ_BYTES);
        require('fs').readSync(fd, buf, 0, HEAD_READ_BYTES, 0);
        raw = buf.toString('utf8');
      } finally {
        require('fs').closeSync(fd);
      }
    } else {
      raw = readFileSync(jsonlPath, 'utf8');
    }
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = extractText(entry.message);
    if (isCandidateUserEntry(entry, text)) {
      return text;
    }
  }
  return null;
}

/**
 * 给定 8 字符 short hash,从 JSONL 文件里挖出原始 user prompt 当 name。
 * 返回 `{ name, sessionId }`(sessionId 是 full UUID)
 * 或 null(找不到 / JSONL 无 candidate user message)。
 *
 * @param short 8 字符 short hash
 * @param index 可注入的 index(测试用),默认走模块单例
 */
export function deriveNameFromJsonl(
  short: string,
  index: JsonlIndex = defaultIndex,
): { name: string; sessionId: string } | null {
  const path = index.lookup(short);
  if (!path) return null;
  const raw = extractFirstUserPrompt(path);
  if (!raw) return null;
  // basename 形如 "3a41fe73-0951-470a-bd2f-fb5a9f0fbe6b.jsonl"
  const sessionId = basename(path).replace(/\.jsonl$/, '');
  return { name: normalizeName(raw), sessionId };
}

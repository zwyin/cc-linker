// src/agent-view/jsonl-peek.ts
//
// v2.2.8 新增:为 Peek 卡片提取"最后一条 assistant 文本"作为 Recent output,
// 取代原先把 `claude logs <short>` 的 raw 终端 buffer 塞进 code-block 的做法
// —— 终端 buffer 含 ANSI 光标定位 / box-drawing(│ ┌ └ 等),飞书 monospace
// 字体渲染成一排 □ tofu,完全无意义。
//
// JSONL 里 assistant 消息的 message.content 是 markdown 原文,飞书 markdown
// widget 直接渲染就跟 TUI 视觉对齐。

import { readFileSync, statSync } from 'fs';

const DEFAULT_MAX_CHARS = 1500;
const FULL_READ_THRESHOLD_BYTES = 2_000_000;
const TAIL_READ_BYTES = 256 * 1024;

interface JsonlEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  [k: string]: unknown;
}

/** 从一条 assistant entry 里把所有 text block 拼成一段文本(忽略 tool_use 等)。 */
function extractAssistantText(entry: JsonlEntry): string {
  if (entry.type !== 'assistant') return '';
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

/**
 * 读 JSONL,返回最后一条带 text 内容的 assistant 消息(截到 maxChars)。
 *
 * 文件 > 2MB 时只读尾部 256KB —— assistant 历史最新的一条几乎必然在文件末尾,
 * 即便 256KB 内不完整也能 graceful 跳过损坏行。
 * 找不到返回 null,调用方退化下一级。
 */
export function extractRecentAssistantText(
  jsonlPath: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): string | null {
  let raw: string;
  try {
    const st = statSync(jsonlPath);
    if (st.size > FULL_READ_THRESHOLD_BYTES) {
      const fs = require('fs');
      const fd = fs.openSync(jsonlPath, 'r');
      try {
        const offset = Math.max(0, st.size - TAIL_READ_BYTES);
        const len = st.size - offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
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

  // 从后往前扫,first hit 就是 "最后一条 assistant"
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 损坏行 / tail-cut 不完整行 graceful skip
    }
    const text = extractAssistantText(entry);
    if (!text) continue;
    return truncate(text, maxChars);
  }
  return null;
}

/**
 * 从 JSONL 头几行里找 "resume from" 提示,返回 parent sessionId(UUID)。
 * 用于 bg session 自己的 JSONL 没有 assistant 消息时,沿着 fork 链回 parent。
 *
 * 主要 marker:第一条非 mode/permission 类 entry 的 `parentUuid` 若存在,
 * 通常对应 parent session 的最后一条 entry;但更可靠的是直接读 roster.json
 * 的 dispatch.launch.sessionId —— 这里只兜底,主路径走 roster。
 */
export function findParentSessionPath(jsonlPath: string): string | null {
  // intentionally minimal — roster lookup is the canonical path for resume chains;
  // 留这个 API 槽位以备 roster 不可用时的本地兜底(暂未实现 path 追溯,
  // 因为 JSONL 头部不直接含 parent 文件路径,只有 parentUuid 没法解出文件名)
  void jsonlPath;
  return null;
}

function truncate(text: string, maxChars: number): string {
  // 不打断 word/markdown 块,优先按段落边界(\n\n)回退
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastPara = cut.lastIndexOf('\n\n');
  if (lastPara > maxChars * 0.6) {
    return cut.slice(0, lastPara) + '\n\n…(已截断)';
  }
  const lastNewline = cut.lastIndexOf('\n');
  if (lastNewline > maxChars * 0.7) {
    return cut.slice(0, lastNewline) + '\n…(已截断)';
  }
  return cut + '…(已截断)';
}

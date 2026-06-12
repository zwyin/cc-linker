import { readFileSync, existsSync } from 'fs';

export interface ToolUseRef {
  name: string;
  /**
   * v2.4.x: 工具调用的 input 摘要 (截断到 80 字符),
   * 展示在卡片 "🔧 当前操作" 区域, 让用户看到 bg 在做什么。
   * 不包含完整 input (太大), 只挑一两个最 informative 的字段。
   */
  inputSummary: string;
}

export interface LastAssistantTurn {
  text: string;
  /**
   * v2.4.x: 所有 thinking 块拼接 (用 \n 分隔)。空字符串表示没 thinking。
   * 用于卡片 "💭 思考过程" 区域。
   */
  thinking: string;
  /**
   * v2.4.x: 工具调用列表 (顺序跟 JSONL 一致)。
   * 用于卡片 "🔧 当前操作" 区域, 每个工具一行。
   */
  toolUses: ToolUseRef[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
  };
  stopReason: string;
  timestamp: string;
  uuid: string;
}

interface AssistantContent {
  type: string;
  text?: string;
  /** tool_use 块的工具名 (Claude SDK 协议) */
  name?: string;
  /** tool_use 块的 input (Claude SDK 协议) */
  input?: Record<string, any>;
}

interface AssistantMessage {
  role: string;
  content: AssistantContent[] | string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  stop_reason?: string;
}

interface JsonlLine {
  type?: string;
  message?: AssistantMessage;
  timestamp?: string;
  uuid?: string;
}

/** input 摘要最大长度, 防飞书卡 30KB 限制 */
const INPUT_SUMMARY_MAX = 80;

/**
 * v2.4.x: 工具 input 摘要 — 挑一两个最 informative 字段拼成短字符串。
 * 优先级: file_path > path > command > pattern > query > url > 整个 JSON 截断
 */
function summarizeToolInput(name: string, input: Record<string, any> | undefined): string {
  if (!input) return '';
  // 优先字段 (按工具常用 path 取)
  const preferred = [
    'file_path', 'path', 'filepath',
    'command', 'cmd',
    'pattern', 'glob',
    'query', 'q',
    'url', 'uri',
    'content', 'message',
  ];
  for (const key of preferred) {
    if (typeof input[key] === 'string' && input[key].length > 0) {
      const v = input[key] as string;
      return v.length > INPUT_SUMMARY_MAX ? v.slice(0, INPUT_SUMMARY_MAX) + '…' : v;
    }
  }
  // fallback: JSON 序列化截断
  const json = JSON.stringify(input);
  return json.length > INPUT_SUMMARY_MAX ? json.slice(0, INPUT_SUMMARY_MAX) + '…' : json;
}

/**
 * Read the last assistant turn from a JSONL conversation log.
 *
 * Reads the entire file via readFileSync, splits into lines, and
 * iterates in reverse to find the last line with `type: "assistant"`.
 * Parses it and extracts the first text content block + usage stats.
 * Torn lines (mid-write by CLI) are skipped via JSON.parse try/catch.
 *
 * Returns null if file is missing, empty, or has no assistant turn.
 *
 * Performance note: reads entire file into memory. Fine for typical
 * session JSONL (< 10MB). If sessions grow larger, switch to a
 * seek-from-end approach.
 *
 * @param jsonlPath Absolute path to the JSONL file. Caller is responsible
 *                 for falling back from `state.json.linkScanPath` to
 *                 `roster.json:workers[short].dispatch.launch.sessionId`
 *                 when linkScanPath is null (running/working state).
 */
export async function readLastAssistantTurn(jsonlPath: string): Promise<LastAssistantTurn | null> {
  if (!existsSync(jsonlPath)) return null;
  const raw = readFileSync(jsonlPath, 'utf8');
  const lines = raw.split('\n').filter(l => l.length > 0);
  // Iterate in reverse to find last assistant turn
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue; // skip torn lines (CLI mid-write)
    }
    if (parsed.type === 'assistant' && parsed.message?.role === 'assistant') {
      return extractTurn(parsed);
    }
  }
  return null;
}

function extractTurn(line: JsonlLine): LastAssistantTurn | null {
  const msg = line.message!;
  const content = msg.content;
  let text = '';
  const thinkingParts: string[] = [];
  const toolUses: ToolUseRef[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      // v2.4.x: 提取 thinking 块
      if (block.type === 'thinking' && block.text) {
        thinkingParts.push(block.text);
        continue;
      }
      // v2.4.x: 提取 text 块 (concat, 不 break, 让后续 tool_use 也被收集)
      if (block.type === 'text' && block.text) {
        text = text ? text + '\n' + block.text : block.text;
        continue;
      }
      // v2.4.x: 提取 tool_use 块
      if (block.type === 'tool_use' && block.name) {
        toolUses.push({
          name: block.name,
          inputSummary: summarizeToolInput(block.name, block.input),
        });
        continue;
      }
    }
  } else if (typeof content === 'string') {
    text = content;
  }

  return {
    text,
    thinking: thinkingParts.join('\n'),
    toolUses,
    usage: {
      input_tokens: msg.usage?.input_tokens ?? 0,
      output_tokens: msg.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: msg.usage?.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: msg.usage?.cache_read_input_tokens ?? null,
    },
    stopReason: msg.stop_reason ?? 'unknown',
    timestamp: line.timestamp ?? '',
    uuid: line.uuid ?? '',
  };
}

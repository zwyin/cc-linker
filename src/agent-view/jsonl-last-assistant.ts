import { readFileSync, existsSync } from 'fs';

export interface LastAssistantTurn {
  text: string;
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
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        text = block.text;
        break;
      }
    }
  } else if (typeof content === 'string') {
    text = content;
  }
  return {
    text,
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

import { logger } from '../utils/logger';

export type StreamChunkType = 'thinking' | 'text' | 'result';

export interface ThinkingChunk {
  type: 'thinking';
  content: string;
}

export interface TextChunk {
  type: 'text';
  content: string;
}

export interface ResultChunk {
  type: 'result';
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  stop_reason: string | null;
  subtype?: string;
  is_error?: boolean;
  errors?: string[];
}

export type StreamChunk = ThinkingChunk | TextChunk | ResultChunk;

export class StreamParser {
  parseLine(line: string): StreamChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      logger.debug(`StreamParser: invalid JSON: ${trimmed.slice(0, 100)}`);
      return null;
    }

    const type = obj.type as string | undefined;
    if (type === 'system') return null;
    if (type === 'assistant') return this.parseAssistant(obj);
    if (type === 'result') return this.parseResult(obj);

    logger.debug(`StreamParser: unknown type: ${type}`);
    return null;
  }

  private parseAssistant(obj: Record<string, unknown>): StreamChunk | null {
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) return null;
    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!content?.length) return null;

    for (const block of content) {
      const blockType = block.type as string | undefined;
      if (blockType === 'thinking' && typeof block.text === 'string') {
        return { type: 'thinking', content: block.text };
      }
      if (blockType === 'text' && typeof block.text === 'string') {
        return { type: 'text', content: block.text };
      }
    }
    return null;
  }

  private parseResult(obj: Record<string, unknown>): ResultChunk {
    return {
      type: 'result',
      result: (obj.result as string) ?? '',
      session_id: (obj.session_id as string) ?? '',
      total_cost_usd: (obj.total_cost_usd as number) ?? 0,
      duration_ms: (obj.duration_ms as number) ?? 0,
      stop_reason: (obj.stop_reason as string | null) ?? null,
      subtype: obj.subtype as string | undefined,
      is_error: obj.is_error as boolean | undefined,
      errors: obj.errors as string[] | undefined,
    };
  }
}

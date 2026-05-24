import { logger } from '../utils/logger';
import type { StreamChunk } from './stream-parser';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface PermissionRequestChunk {
  type: 'permission_request';
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions: Array<{ destination: string; rule: string }>;
}

export type SDKStreamChunk = StreamChunk | PermissionRequestChunk;

export class StreamAdapter {
  adapt(
    message: SDKMessage,
    onChunk: (chunk: SDKStreamChunk) => void,
  ): void {
    if (message.type === 'system') {
      // Handle permission_denied as a permission request
      if ((message as any).subtype === 'permission_denied') {
        const msg = message as any;
        onChunk({
          type: 'permission_request',
          toolName: msg.tool_name ?? '',
          toolInput: {},
          suggestions: [],
        });
        return;
      }
      return;
    }
    if (message.type === 'assistant') return;

    if (message.type === 'stream_event') {
      const event = message.event;
      if (!event) return;

      if (event.type === 'content_block_delta') {
        const delta = event.delta as any;
        if (!delta) return;

        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          onChunk({ type: 'text', content: delta.text });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          onChunk({ type: 'thinking', content: delta.thinking });
        }
      }
      return;
    }

    if (message.type === 'result') {
      const msg = message as any;
      onChunk({
        type: 'result',
        result: msg.result ?? '',
        session_id: message.session_id ?? '',
        total_cost_usd: message.total_cost_usd ?? 0,
        duration_ms: message.duration_ms ?? 0,
        stop_reason: message.stop_reason ?? null,
        subtype: message.subtype,
        is_error: message.is_error,
        errors: msg.errors,
        usage: message.usage as any,
      });
      return;
    }

    logger.debug(`StreamAdapter: unknown message type: ${(message as any).type}`);
  }
}

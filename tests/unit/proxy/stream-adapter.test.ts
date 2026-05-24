import { describe, test, expect } from 'bun:test';
import { StreamAdapter } from '../../../src/proxy/stream-adapter';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

describe('StreamAdapter', () => {
  test('adapts text_delta to text chunk', () => {
    const adapter = new StreamAdapter();
    const chunks: any[] = [];
    const msg: SDKMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      },
      uuid: 'test',
      session_id: 'test',
      parent_tool_use_id: null,
    };
    adapter.adapt(msg, (c) => chunks.push(c));
    expect(chunks).toEqual([{ type: 'text', content: 'hello' }]);
  });

  test('adapts thinking_delta to thinking chunk', () => {
    const adapter = new StreamAdapter();
    const chunks: any[] = [];
    const msg: SDKMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'let me think' },
      },
      uuid: 'test',
      session_id: 'test',
      parent_tool_use_id: null,
    };
    adapter.adapt(msg, (c) => chunks.push(c));
    expect(chunks).toEqual([{ type: 'thinking', content: 'let me think' }]);
  });

  test('adapts result message', () => {
    const adapter = new StreamAdapter();
    const chunks: any[] = [];
    const msg: SDKMessage = {
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 'sid-1',
      total_cost_usd: 0.5,
      duration_ms: 1000,
      stop_reason: 'end_turn',
    };
    adapter.adapt(msg, (c) => chunks.push(c));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('result');
    expect(chunks[0].session_id).toBe('sid-1');
  });

  test('adapts permission_denied system message to permission_request chunk', () => {
    const adapter = new StreamAdapter();
    const chunks: any[] = [];
    const msg: SDKMessage = {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'test-id',
    } as any;
    adapter.adapt(msg, (c) => chunks.push(c));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('permission_request');
    expect(chunks[0].toolName).toBe('Bash');
  });

  test('ignores system messages', () => {
    const adapter = new StreamAdapter();
    const chunks: any[] = [];
    const msg: SDKMessage = {
      type: 'system',
      subtype: 'init',
    } as any;
    adapter.adapt(msg, (c) => chunks.push(c));
    expect(chunks).toEqual([]);
  });

  test('ignores assistant messages (handled by stream_event)', () => {
    const adapter = new StreamAdapter();
    const chunks: any[] = [];
    const msg: SDKMessage = {
      type: 'assistant',
      message: { role: 'assistant', content: [] },
    } as any;
    adapter.adapt(msg, (c) => chunks.push(c));
    expect(chunks).toEqual([]);
  });
});

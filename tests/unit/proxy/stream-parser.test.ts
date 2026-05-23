import { test, expect } from 'bun:test';
import { StreamParser } from '../../../src/proxy/stream-parser';

test('filters system lines', () => {
  const parser = new StreamParser();
  expect(parser.parseLine('{"type":"system","subtype":"hook_started"}')).toBeNull();
});

test('extracts thinking content from assistant', () => {
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'Let me think...' }] }
  });
  const result = parser.parseLine(line);
  expect(result).not.toBeNull();
  expect(result!.type).toBe('thinking');
  expect(result!.content).toBe('Let me think...');
});

test('extracts text content from assistant', () => {
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello world' }] }
  });
  const result = parser.parseLine(line);
  expect(result).not.toBeNull();
  expect(result!.type).toBe('text');
  expect(result!.content).toBe('Hello world');
});

test('returns null for assistant with no content', () => {
  const parser = new StreamParser();
  expect(parser.parseLine(JSON.stringify({ type: 'assistant', message: {} }))).toBeNull();
});

test('returns null for unknown type', () => {
  const parser = new StreamParser();
  expect(parser.parseLine(JSON.stringify({ type: 'unknown' }))).toBeNull();
});

test('returns result chunk when type=result', () => {
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'result', subtype: 'success', result: 'Final answer',
    session_id: 'abc-123', total_cost_usd: 0.05, duration_ms: 2000,
    stop_reason: 'end_turn',
  });
  const result = parser.parseLine(line);
  expect(result).not.toBeNull();
  expect(result!.type).toBe('result');
  expect((result as any).result).toBe('Final answer');
  expect((result as any).session_id).toBe('abc-123');
  expect((result as any).total_cost_usd).toBe(0.05);
});

test('handles multiple content blocks — returns first non-null', () => {
  const parser = new StreamParser();
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [
      { type: 'thinking', thinking: 'thinking...' },
      { type: 'text', text: 'response...' }
    ]}
  });
  const result = parser.parseLine(line);
  expect(result!.type).toBe('thinking');
});

test('handles invalid JSON gracefully', () => {
  const parser = new StreamParser();
  expect(parser.parseLine('not json')).toBeNull();
});

test('handles empty lines', () => {
  const parser = new StreamParser();
  expect(parser.parseLine('')).toBeNull();
  expect(parser.parseLine('   ')).toBeNull();
});

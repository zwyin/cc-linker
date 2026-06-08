import { describe, test, expect } from 'bun:test';
import { isAgentViewValue, type AgentViewValue } from '../../../src/agent-view/action';

describe('isAgentViewValue', () => {
  test('accepts all tags with required fields', () => {
    const validCases: Array<{ tag: string; [k: string]: unknown }> = [
      { tag: 'agent_view_refresh_list' },
      { tag: 'agent_view_refresh_peek', shortId: 'abcd1234', sessionId: 'abcd1234-full-uuid' },
      { tag: 'agent_view_peek', shortId: 'abcd1234', sessionId: 'uuid', cwd: '/tmp/proj' },
      { tag: 'agent_view_attach', shortId: 'abcd1234', sessionId: 'uuid', name: 'test', cwd: '/tmp/proj' },
      { tag: 'agent_view_reply_request', shortId: 'abcd1234', sessionId: 'uuid', cwd: '/tmp/proj' },
      { tag: 'agent_view_cancel_reply' },
      { tag: 'agent_view_stop', shortId: 'abcd1234', sessionId: 'uuid', name: 'test' },
      { tag: 'agent_view_stop_confirm', shortId: 'abcd1234', sessionId: 'uuid' },
      { tag: 'agent_view_back_to_chat' },
      { tag: 'agent_view_stop_and_send', shortId: 'abcd1234', sessionId: 'uuid', cwd: '/tmp/proj', text: 'hello' },
      { tag: 'agent_view_new_and_send', cwd: '/tmp/proj', text: 'hello' },
      { tag: 'agent_view_bg_conflict_cancel' },
    ];
    for (const v of validCases) {
      expect(isAgentViewValue(v)).toBe(true);
    }
  });

  test('rejects when required fields are missing', () => {
    // Tags that need shortId + sessionId
    expect(isAgentViewValue({ tag: 'agent_view_refresh_peek' })).toBe(false);
    expect(isAgentViewValue({ tag: 'agent_view_refresh_peek', shortId: 'abcd1234' })).toBe(false);
    expect(isAgentViewValue({ tag: 'agent_view_stop_confirm', sessionId: 'uuid' })).toBe(false);

    // Tags that need shortId + sessionId + cwd
    expect(isAgentViewValue({ tag: 'agent_view_peek', shortId: 'a', sessionId: 'b' })).toBe(false);
    expect(isAgentViewValue({ tag: 'agent_view_reply_request' })).toBe(false);

    // Tags that need shortId + sessionId + name
    expect(isAgentViewValue({ tag: 'agent_view_stop', shortId: 'a', sessionId: 'b' })).toBe(false);

    // Tag that needs sessionId + shortId + name + cwd
    expect(isAgentViewValue({ tag: 'agent_view_attach', shortId: 'a', sessionId: 'b' })).toBe(false);

    // Tags that need cwd + text
    expect(isAgentViewValue({ tag: 'agent_view_new_and_send' })).toBe(false);
    expect(isAgentViewValue({ tag: 'agent_view_new_and_send', cwd: '/tmp' })).toBe(false);

    // stop_and_send needs text (optional via optStr, so empty string is ok, but missing is not)
    expect(isAgentViewValue({ tag: 'agent_view_stop_and_send', shortId: 'a', sessionId: 'b', cwd: '/tmp' })).toBe(false);
  });

  test('rejects empty string fields', () => {
    expect(isAgentViewValue({ tag: 'agent_view_peek', shortId: '', sessionId: 'b', cwd: '/tmp' })).toBe(false);
    expect(isAgentViewValue({ tag: 'agent_view_stop_confirm', shortId: 'a', sessionId: '' })).toBe(false);
  });

  test('rejects non-agent_view tags', () => {
    expect(isAgentViewValue({ tag: 'help' })).toBe(false);
    expect(isAgentViewValue(null)).toBe(false);
    expect(isAgentViewValue(undefined)).toBe(false);
    expect(isAgentViewValue('string')).toBe(false);
    expect(isAgentViewValue(42)).toBe(false);
    expect(isAgentViewValue({})).toBe(false);
  });

  test('accepts unknown agent_view_ tags (forward-compatible)', () => {
    expect(isAgentViewValue({ tag: 'agent_view_future_feature' })).toBe(true);
  });
});

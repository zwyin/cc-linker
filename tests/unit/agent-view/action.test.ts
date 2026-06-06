import { describe, test, expect } from 'bun:test';
import { isAgentViewValue, type AgentViewValue } from '../../../src/agent-view/action';

describe('isAgentViewValue', () => {
  test('accepts all 9 tags', () => {
    for (const tag of [
      'agent_view_refresh_list',
      'agent_view_refresh_peek',
      'agent_view_peek',
      'agent_view_attach',
      'agent_view_reply_request',
      'agent_view_cancel_reply',
      'agent_view_stop',
      'agent_view_stop_confirm',
      'agent_view_back_to_chat',
    ]) {
      expect(isAgentViewValue({ tag })).toBe(true);
    }
  });

  test('rejects non-agent_view tags', () => {
    expect(isAgentViewValue({ tag: 'help' })).toBe(false);
    expect(isAgentViewValue(null)).toBe(false);
    expect(isAgentViewValue(undefined)).toBe(false);
    expect(isAgentViewValue('string')).toBe(false);
    expect(isAgentViewValue(42)).toBe(false);
    expect(isAgentViewValue({})).toBe(false);
  });
});

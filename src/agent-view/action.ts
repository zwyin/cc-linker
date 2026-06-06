/**
 * Agent View card action value type definitions and guard.
 *
 * These tag values are sent from Feishu interactive cards when a user clicks
 * a button. The bot's `handleCardAction` dispatches them to the appropriate
 * `AgentViewManager.handle*` method.
 *
 * Real implementations of the 9 handlers live in T14-T22. This file only
 * defines the type and a type guard used by the dispatch site.
 */

export type AgentViewValue =
  | { tag: 'agent_view_refresh_list' }
  | { tag: 'agent_view_refresh_peek'; shortId: string; sessionId: string }
  | { tag: 'agent_view_peek'; shortId: string; sessionId: string; cwd: string }
  | {
      tag: 'agent_view_attach';
      sessionId: string;
      shortId: string;
      name: string;
      cwd: string;
    }
  | { tag: 'agent_view_reply_request'; shortId: string; sessionId: string; cwd: string }
  | { tag: 'agent_view_cancel_reply' }
  | { tag: 'agent_view_stop'; shortId: string; sessionId: string; name: string }
  | { tag: 'agent_view_stop_confirm'; shortId: string; sessionId: string }
  | { tag: 'agent_view_back_to_chat' };

export function isAgentViewValue(v: any): v is AgentViewValue {
  return Boolean(
    v && typeof v === 'object' && typeof v.tag === 'string' && v.tag.startsWith('agent_view_'),
  );
}

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
  | { tag: 'agent_view_back_to_chat' }
  // v2.2.11: bg-conflict 拒绝卡上的三个按钮(stashed text 跟着 value 走)
  // v2.2.13 新增 parentUuid / hasParent —— runChatSDK 拒绝分支读 roster 后
  // 把 parent 路径 pre-compute 好 stashed 到 button value,这样后续 handleStopAndSend
  // 在 claude stop 把 worker 从 roster 移除后,不需要再二次查(避免 race)。
  | {
      tag: 'agent_view_stop_and_send';
      shortId: string;
      sessionId: string;
      cwd: string;
      text: string;
      parentUuid: string;
      hasParent: boolean;
    }
  | { tag: 'agent_view_new_and_send'; cwd: string; text: string }
  | { tag: 'agent_view_bg_conflict_cancel' }
  | { tag: 'agent_view_stop_watching' }
  // v2.4 rendezvous: abort-wait / stop-bg 卡按钮
  // - abort_wait: 卡上的"不等了"按钮,handler abort poll 循环
  // - stop_bg_request: 卡上的"停止 bg"按钮,弹确认卡
  // - stop_bg_confirm: 确认卡上的"确认停止 bg"按钮,handler 跑 claude stop
  | { tag: 'agent_view_rendezvous_abort_wait' }
  | { tag: 'agent_view_rendezvous_stop_bg_request'; shortId: string }
  | { tag: 'agent_view_rendezvous_stop_bg_confirm'; shortId: string };

export function isAgentViewValue(v: any): v is AgentViewValue {
  if (!v || typeof v !== 'object' || typeof v.tag !== 'string') return false;
  if (!v.tag.startsWith('agent_view_')) return false;

  const str = (k: string) => typeof v[k] === 'string' && v[k].length > 0;
  const optStr = (k: string) => typeof v[k] === 'string';

  switch (v.tag) {
    // No extra fields required
    case 'agent_view_refresh_list':
    case 'agent_view_cancel_reply':
    case 'agent_view_back_to_chat':
    case 'agent_view_bg_conflict_cancel':
    case 'agent_view_rendezvous_abort_wait':
      return true;

    // shortId + sessionId
    case 'agent_view_refresh_peek':
    case 'agent_view_stop_confirm':
      return str('shortId') && str('sessionId');

    // shortId only (rendezvous 确认卡:只 stop bg,不需要 sessionId)
    case 'agent_view_rendezvous_stop_bg_request':
    case 'agent_view_rendezvous_stop_bg_confirm':
      return str('shortId');

    // shortId + sessionId + cwd
    case 'agent_view_peek':
    case 'agent_view_reply_request':
      return str('shortId') && str('sessionId') && str('cwd');

    // shortId + sessionId + name
    case 'agent_view_stop':
      return str('shortId') && str('sessionId') && str('name');

    // sessionId + shortId + name + cwd
    case 'agent_view_attach':
      return str('sessionId') && str('shortId') && str('name') && str('cwd');

    // shortId + sessionId + cwd + text (+ optional parentUuid/hasParent)
    case 'agent_view_stop_and_send':
      return str('shortId') && str('sessionId') && str('cwd') && optStr('text');

    // cwd + text
    case 'agent_view_new_and_send':
      return str('cwd') && optStr('text');

    default:
      // Unknown agent_view_ tag — accept but don't validate further
      return true;
  }
}

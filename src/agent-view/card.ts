// src/agent-view/card.ts
import type { AgentSessionGroup, AgentSession, AgentSessionStatus } from './types';

const TEMPLATE_HEADER = { config: { wide_screen_mode: true } };

/** 列表卡:按 busy / waiting / idle 三组渲染
 * v2.2 修正:hasMore > 0 时,追加 "… N more(用 `claude agents --cwd <path>` 缩小范围)" 提示
 * (spec §6.1 "列表上限 10 个会话,>10 时折行 `… N more`")
 */
export function buildListCard(
  groups: AgentSessionGroup,
  refreshedAt: string,
  hasMore: number = 0,
): string {
  const elements: any[] = [];
  for (const [status, list] of [
    ['busy', groups.busy],
    ['waiting', groups.waiting],
    ['idle', groups.idle],
  ] as Array<[AgentSessionStatus, AgentSession[]]>) {
    if (list.length === 0) continue;
    const title = status === 'busy' ? '处理中' : status === 'waiting' ? '等待输入' : '已完成/空闲';
    elements.push({ tag: 'markdown', content: `**${title} (${list.length})**` });
    for (const s of list) {
      const emoji = status === 'busy' ? '✽' : status === 'waiting' ? '✋' : '⏹';
      const elapsed = humanizeElapsed(Date.now() - s.startedAt);
      elements.push({
        tag: 'markdown',
        content: `${emoji} \`${s.name}\`  ·  ${elapsed}\n📁 ${truncateCwd(s.cwd)}`,
      });
      // 按钮
      const actions: any[] = [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Peek' },
          value: {
            tag: 'agent_view_peek',
            shortId: s.sessionId.slice(0, 8),
            sessionId: s.sessionId,
            cwd: s.cwd,
          },
          type: 'default',
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Attach' },
          value: {
            tag: 'agent_view_attach',
            sessionId: s.sessionId,
            shortId: s.sessionId.slice(0, 8),
            name: s.name,
            cwd: s.cwd,
          },
          type: 'default',
        },
      ];
      if (status === 'waiting') {
        actions.push({
          tag: 'button',
          text: { tag: 'plain_text', content: 'Reply' },
          value: {
            tag: 'agent_view_reply_request',
            shortId: s.sessionId.slice(0, 8),
            sessionId: s.sessionId,
            cwd: s.cwd,
          },
          type: 'primary',
        });
      }
      if (status === 'busy') {
        actions.push({
          tag: 'button',
          text: { tag: 'plain_text', content: 'Stop' },
          value: {
            tag: 'agent_view_stop',
            shortId: s.sessionId.slice(0, 8),
            sessionId: s.sessionId,
            name: s.name,
          },
          type: 'danger',
        });
      }
      elements.push({ tag: 'action', actions });
    }
  }
  elements.push({ tag: 'hr' });
  // v2.2 修正:>10 时折行 "… N more" 提示用户用 `claude agents --cwd <path>` 缩小范围
  if (hasMore > 0) {
    elements.push({
      tag: 'markdown',
      content: `… ${hasMore} more(用 \`claude agents --cwd <path>\` 缩小范围)`,
    });
  }
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '🔄 Refresh' },
        value: { tag: 'agent_view_refresh_list' },
        type: 'default',
      },
    ],
  });
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: {
      title: {
        tag: 'plain_text',
        content: `🤖 Agent View · ${countTotal(groups)} sessions`,
      },
      template: 'blue',
    },
    elements: [{ tag: 'markdown', content: `Last refreshed ${refreshedAt}` }, ...elements],
  });
}

function countTotal(groups: AgentSessionGroup): number {
  return groups.busy.length + groups.waiting.length + groups.idle.length;
}

function humanizeElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function truncateCwd(cwd: string): string {
  const home = process.env.HOME || '/';
  return cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
}

/** Peek 卡:显示 status / waitingFor / recentOutput */
export function buildPeekCard(opts: {
  name: string;
  status: AgentSessionStatus;
  waitingFor?: string;
  shortId: string; // v2.2 修正:按钮 value 需要
  sessionId: string; // v2.2 修正:按钮 value 需要
  cwd: string;
  pid: number;
  startedAt: number;
  recentOutput: string;
  buttons: { peek: boolean; attach: boolean; reply: boolean; stop: boolean; refresh: boolean };
}): string {
  const statusLabel =
    opts.status === 'busy' ? '处理中' : opts.status === 'waiting' ? '等待输入' : '已完成';
  const elements: any[] = [
    {
      tag: 'markdown',
      content: `Status: ${statusLabel} (${opts.status})${opts.waitingFor ? `\n等待原因: ${opts.waitingFor}` : ''}\nCWD: ${truncateCwd(opts.cwd)}\nPID: ${opts.pid}  ·  Started ${new Date(opts.startedAt).toLocaleString()}`,
    },
    {
      tag: 'markdown',
      content: `**Recent output**\n\`\`\`\n${opts.recentOutput}\n\`\`\``,
    },
  ];
  // 按钮(根据 status 决定可见性)
  const actions: any[] = [];
  if (opts.buttons.refresh)
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🔄 Refresh' },
      value: {
        tag: 'agent_view_refresh_peek',
        shortId: opts.shortId,
        sessionId: opts.sessionId,
      },
      type: 'default',
    });
  if (opts.buttons.attach)
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: 'Attach' },
      value: {
        tag: 'agent_view_attach',
        sessionId: opts.sessionId,
        shortId: opts.shortId,
        name: opts.name,
        cwd: opts.cwd,
      },
      type: 'default',
    });
  if (opts.buttons.reply)
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: 'Reply' },
      value: {
        tag: 'agent_view_reply_request',
        shortId: opts.shortId,
        sessionId: opts.sessionId,
        cwd: opts.cwd,
      },
      type: 'primary',
    });
  if (opts.buttons.stop)
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: 'Stop' },
      value: {
        tag: 'agent_view_stop',
        shortId: opts.shortId,
        sessionId: opts.sessionId,
        name: opts.name,
      },
      type: 'danger',
    });
  if (actions.length > 0) elements.push({ tag: 'action', actions });
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: {
      title: { tag: 'plain_text', content: `🔍 Peek · \`${opts.name}\`` },
      template: 'blue',
    },
    elements,
  });
}

/** 错误卡 */
export function buildErrorCard(opts: {
  title: string;
  body: string;
  refreshButton?: boolean;
}): string {
  const elements: any[] = [{ tag: 'markdown', content: opts.body }];
  if (opts.refreshButton) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🔄 重新检测' },
          value: { tag: 'agent_view_refresh_list' },
          type: 'default',
        },
      ],
    });
  }
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: { title: { tag: 'plain_text', content: `❌ ${opts.title}` }, template: 'red' },
    elements,
  });
}

/** 空状态卡:无 background session */
export function buildEmptyCard(): string {
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: { title: { tag: 'plain_text', content: '🤖 Agent View' }, template: 'grey' },
    elements: [
      {
        tag: 'markdown',
        content:
          '暂无后台会话\n\nAgent View 用于管理用 `claude --bg` 派发的后台任务。在终端执行:\n\n  claude --bg "你的任务描述"\n\n派发后会出现在这里。',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 Refresh' },
            value: { tag: 'agent_view_refresh_list' },
            type: 'default',
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '💬 回到普通聊天' },
            value: { tag: 'agent_view_back_to_chat' },
            type: 'default',
          },
        ],
      },
    ],
  });
}

/** 等待输入卡:用户点 [Reply] 后 patch 原 list/peek 卡为此卡 */
export function buildWaitingCard(opts: {
  name: string;
  status: AgentSessionStatus;
  waitingFor?: string;
  cwd: string;
}): string {
  const statusLabel = '等待输入';
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: {
      title: { tag: 'plain_text', content: `✍️ 等待输入回复 · \`${opts.name}\`` },
      template: 'yellow',
    },
    elements: [
      {
        tag: 'markdown',
        content: `状态:${statusLabel} (${opts.status})${opts.waitingFor ? `\n等待原因: ${opts.waitingFor}` : ''}\nCWD: ${truncateCwd(opts.cwd)}`,
      },
      {
        tag: 'markdown',
        content:
          '请直接发送文字消息作为回复(5 分钟内有效)\n\n⏱ 等待输入中(5 分钟后超时)',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '取消等待' },
            value: { tag: 'agent_view_cancel_reply' },
            type: 'danger',
          },
        ],
      },
    ],
  });
}

/** 停止确认卡:busy 状态点 [Stop] 后 */
export function buildStopConfirmCard(name: string, shortId: string, sessionId: string): string {
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: {
      title: { tag: 'plain_text', content: `🔴 确认停止? · \`${name}\`` },
      template: 'red',
    },
    elements: [
      {
        tag: 'markdown',
        content:
          '该 session 正在处理任务,停止后无法撤销。\n\n提示:Claude 可能正处于工具调用中,长任务中断需要重新派发。',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 确认停止' },
            value: { tag: 'agent_view_stop_confirm', shortId, sessionId },
            type: 'danger',
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '← 取消' },
            value: { tag: 'agent_view_refresh_list' },
            type: 'default',
          },
        ],
      },
    ],
  });
}

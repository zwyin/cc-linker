// src/agent-view/card.ts
import type { AgentSessionGroup, AgentSession, AgentSessionStatus } from './types';

// v2.2.20 fix: Agent View 卡(Peek/List/Error/Empty/Waiting/StopConfirm/BgConflict)
// 全部需要 `update_multi: true`,否则飞书侧会把对它们的 patch 当成 "merge" 而
// 非 "replace" 处理,出现"内容先刷新后被旧内容覆盖"的 revert 现象。
// 参见 CardUpdater(card-updater.ts:204, 235, 287 等) 的 streaming/permission/
// CLI busy 卡也都设了这个字段。
const TEMPLATE_HEADER = { config: { wide_screen_mode: true, update_multi: true } };

/** 列表卡:按 busy / waiting / idle / completed 四组渲染
 * v2.2 修正:hasMore > 0 时,追加 "… N more(用 `claude agents --cwd <path>` 缩小范围)" 提示
 * (spec §6.1 "列表上限 10 个会话,>10 时折行 `… N more`")
 * v2.2.4 新增:completed 组(daemon.log 兜底拿的已 settled sessions),
 * 只渲染 Peek/Attach(不渲染 Stop/Reply,因为没有真实进程可控制)。
 */
export function buildListCard(
  groups: AgentSessionGroup,
  refreshedAt: string,
  hasMore: number = 0,
): string {
  const elements: any[] = [];
  for (const [status, list] of [
    ['waiting', groups.waiting],
    ['busy', groups.busy],
    ['idle', groups.idle],
    ['completed', groups.completed],
  ] as Array<[AgentSessionStatus | 'completed', AgentSession[]]>) {
    if (list.length === 0) continue;
    const title =
      status === 'busy'
        ? '处理中'
        : status === 'waiting'
          ? '等待输入'
          : status === 'completed'
            ? '已完成'
            : '空闲';
    elements.push({ tag: 'markdown', content: `**${title} (${list.length})**` });
    for (const s of list) {
      const emoji = status === 'busy' ? '✽'
        : status === 'waiting' ? '✋'
        : '⏹';
      const elapsed = humanizeElapsed(Date.now() - s.startedAt);
      const subtitle = chooseSubtitle(s);
      const subtitleLine = subtitle
        ? `\n   ${status === 'waiting' ? '❓ ' : ''}${subtitle}`
        : '';
      elements.push({
        tag: 'markdown',
        content: `${emoji} \`${s.name}\`  ·  ${elapsed}${subtitleLine}\n📁 ${truncateCwd(s.cwd)}`,
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
    elements: [
      // v2.3: 状态来源(state.json 任务状态机,代替之前的 claude agents --json)
      {
        tag: 'markdown',
        content: 'ℹ️ 状态由 `~/.claude/jobs/<short>/state.json` 提供(Claude CLI 任务状态机)',
      },
      { tag: 'markdown', content: `Last refreshed ${refreshedAt}` },
      ...elements,
    ],
  });
}

function countTotal(groups: AgentSessionGroup): number {
  return (
    groups.busy.length +
    groups.waiting.length +
    groups.idle.length +
    groups.completed.length
  );
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

/** 列表卡每行的副标题:waiting → needs(或 detail / intent 兜底),busy/done → detail,fallback → intent。
 *  全部 collapse whitespace + 截到 60 字符 + 加省略号。 */
function chooseSubtitle(s: AgentSession): string {
  const raw =
    s.status === 'waiting' ? (s.waitingFor ?? s.detail ?? s.intent ?? '')
    : (s.detail ?? s.intent ?? '');
  if (!raw) return '';
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  const MAX = 60;
  return flat.length <= MAX ? flat : flat.slice(0, MAX) + '…';
}

/** Peek 卡:显示 status / waitingFor / recentOutput
 * v2.2.8: 新增 outputFormat 字段
 *   - 'markdown'(默认):recentOutput 直接 markdown 渲染(JSONL 来源,样式干净)
 *   - 'terminal':退化模式,recentOutput 是 raw 终端片段,走 code-block 包起来 +
 *     "原始终端片段(可能含格式残留)" 警示标签
 */
export function buildPeekCard(opts: {
  name: string;
  status: AgentSessionStatus;
  completed?: boolean;
  waitingFor?: string;
  shortId: string; // v2.2 修正:按钮 value 需要
  sessionId: string; // v2.2 修正:按钮 value 需要
  cwd: string;
  pid: number;
  startedAt: number;
  recentOutput: string;
  outputFormat?: 'markdown' | 'terminal';
  buttons: { peek: boolean; attach: boolean; reply: boolean; stop: boolean; refresh: boolean };
}): string {
  const statusLabel =
    opts.status === 'busy' ? '处理中'
    : opts.status === 'waiting' ? '等待输入'
    : opts.status === 'idle' ? (opts.completed ? '已完成' : '空闲')
    : '未知';
  const fmt = opts.outputFormat ?? 'markdown';
  const recentBlock =
    fmt === 'terminal'
      ? `**Recent output** _(原始终端片段,可能含格式残留)_\n\`\`\`\n${opts.recentOutput}\n\`\`\``
      : `**Recent output**\n\n${opts.recentOutput}`;
  const elements: any[] = [
    {
      tag: 'markdown',
      content: `Status: ${statusLabel} (${opts.status})${opts.waitingFor ? `\n等待原因: ${opts.waitingFor}` : ''}\nCWD: ${truncateCwd(opts.cwd)}\nPID: ${opts.pid}  ·  Started ${new Date(opts.startedAt).toLocaleString()}`,
    },
    {
      tag: 'markdown',
      content: recentBlock,
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

/**
 * v2.2.20: Peek 卡 loading 占位符。
 *
 * 为什么需要:handleRefreshPeek 必须**同步**返回一个非 null 的 card 对象,
 * 不能返回 null。如果返回 null,start.ts:508 会回 `return { type: 'raw', data: {} }`
 * 给飞书,实测(2026-06-08 23:09)这种空响应会让飞书把卡片 revert 到最初
 * 创建时的内容 → 用户报告"新内容先看到,然后被旧内容覆盖"。
 *
 * 修复模式(同 handlePermissionCardAction bot.ts:692-700):
 *   1) sync 立即返回 loading 卡,飞书立即渲染
 *   2) 1.2s 后 async patch 替换为真数据
 */
export function buildLoadingPeekCard(opts: {
  name: string;
  shortId: string;
  sessionId: string;
}): string {
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: {
      title: { tag: 'plain_text', content: `⏳ 刷新中 · \`${opts.name}\`` },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content: '⏳ 正在加载最新日志...\n\n(异步 fetch JSONL 尾部 assistant 内容,约 1.2s)',
      },
    ],
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

/** Reply prompt 卡:用户点 [Reply] 后发独立卡 — header + 等待原因 + AI 最近输出 + [取消等待]
 *
 * v2.3.13:之前是纯文本提示(replyFn),用户看不到 AI 最后一句问什么,无从下手。
 * 改成交互卡 + Peek 同款 markdown 渲染,用户一眼就能看到上下文再回复。
 *
 * recentOutput / outputFormat 为可选:无 peek 内容时仍按老布局 fallback。
 * 函数名沿用 buildWaitingCard 历史叫法(也保留对 v2.2 dead code 测试的兼容)。
 */
export function buildWaitingCard(opts: {
  name: string;
  status: AgentSessionStatus;
  waitingFor?: string;
  cwd: string;
  recentOutput?: string;
  outputFormat?: 'markdown' | 'terminal';
}): string {
  const statusLabel = '等待输入';
  const fmt = opts.outputFormat ?? 'markdown';
  const elements: any[] = [
    {
      tag: 'markdown',
      content: `状态:${statusLabel} (${opts.status})${opts.waitingFor ? `\n❓ 等待原因: ${opts.waitingFor}` : ''}\nCWD: ${truncateCwd(opts.cwd)}`,
    },
  ];
  if (opts.recentOutput && opts.recentOutput.trim()) {
    const recentBlock =
      fmt === 'terminal'
        ? `📝 **最近输出** _(原始终端片段,可能含格式残留)_\n\`\`\`\n${opts.recentOutput}\n\`\`\``
        : `📝 **最近输出**\n\n${opts.recentOutput}`;
    elements.push({ tag: 'markdown', content: recentBlock });
  }
  elements.push({
    tag: 'markdown',
    content:
      '请直接发送一条文字消息作为回复(5 分钟内有效)。\n' +
      '若想中断等待,发 /cancel 或点下方按钮。\n' +
      '若需继续 reply,再点 [Reply] 即可(每次 reply 都是一次独立操作)。',
  });
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '❌ 取消等待' },
        value: { tag: 'agent_view_cancel_reply' },
        type: 'danger',
      },
    ],
  });
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: {
      title: { tag: 'plain_text', content: `↩️ 回复 · \`${opts.name}\`` },
      template: 'yellow',
    },
    elements,
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

/**
 * v2.4: Rendezvous 停止 bg 确认卡。
 *
 * 触发场景:用户在 rendezvous 流式卡(等 bg 响应的长轮询卡)上点 [🛑 停止 bg]
 * 按钮 → 弹出本卡,让用户再次确认是否真的要 kill bg worker。
 *
 * 与 buildStopConfirmCard 的差异:
 *   - 只接收 shortId(不需要 sessionId/name,因为 stop 走 claude stop CLI
 *     只需要 shortId)
 *   - 文案:强调"如果只想停止跟踪、让 bg 继续跑完,请关闭此卡返回上一卡点
 *     [🔙 不等了]"——给用户更轻的退出路径
 *   - 取消按钮 value.tag 是 'agent_view_refresh_list' (回到列表卡)
 *
 * **UX 限制**: 飞书 card 按钮回调是 one-shot,无法"取消当前卡回到上一卡点
 * (rendezvous 流式卡)"。按 [← 取消] 后用户会被带到 /agents 列表卡,需要
 * 重新 /agents → 进 session 才能看到流式卡。这是飞书平台的限制,不是 bug。
 * 如果想做得更完美(取消后直接 patch 回流式卡),需要新加一个 tag
 * 'agent_view_rendezvous_stop_cancel' 走 bot 端 handler 调 CardUpdater
 * 重发流式卡 —— 但这超出当前 plan 范围。
 */
export function buildRendezvousStopConfirmCard(shortId: string): string {
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: {
      title: { tag: 'plain_text', content: `🔴 确认停止 bg? · \`${shortId}\`` },
      template: 'red',
    },
    elements: [
      {
        tag: 'markdown',
        content:
          'bg 进行中的工作会被中断,已写文件保留。\n\n' +
          '> 💡 如果只想停止跟踪、让 bg 继续跑完,请关闭此卡返回上一卡点 [🔙 不等了]。',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 确认停止 bg' },
            type: 'danger',
            value: { tag: 'agent_view_rendezvous_stop_bg_confirm', shortId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '← 取消' },
            type: 'default',
            value: { tag: 'agent_view_refresh_list' },
          },
        ],
      },
    ],
  });
}

/**
 * v2.2.11 + v2.2.13: bg-worker 并发冲突卡。
 *
 * 触发场景:用户在飞书侧 Attach 到一个仍被 daemon bg worker 持有的 session,
 * 然后试图发消息。直接发会让 worker 跟飞书 SDK 同时操作 cwd 文件,可能造成
 * 改动互相覆盖。bot 默认拒绝并给两条出路:
 *   1) [🛑 停 bg 后继续发送] — 跑 `claude stop <short>` 释放 worker,然后**总是
 *      fallback 到 parent session** resume(不再尝试 resume bg 自身 —— v2.2.12
 *      实测 post-stop resume 即使 JSONL 有内容也可能报"No conversation found",
 *      状态不稳),把 stashed text 作为新 turn 发出。parent 从 roster 拿
 *      `dispatch.launch.sessionId`,在拒绝分支已 pre-compute 好 stashed 到
 *      button value,handler 不需要二次查(避免 worker 被 stop 后从 roster 移除
 *      导致查不到 parent)。
 *   2) [🌿 开新会话发送] — runChatSDK(isNew=true),独立新 session,不影响 bg
 *   3) [❌ 取消] — 丢弃,不发不存
 *
 * `parentUuid` + `hasParent` 字段:正常 bg 是 fork 出来的,有 parent;极少数
 * 是 raw slash 派发,没 parent。这种 raw-slash case handler 会直接 resume bg
 * 自身 sessionId。`hasParent=false` 时,handler 知道这情况。
 */
export function buildBgConflictCard(opts: {
  name: string;
  shortId: string;
  sessionId: string;
  cwd: string;
  text: string;
  workerPid?: number;
  parentUuid?: string | null;
}): string {
  const hasParent = !!(opts.parentUuid && /^[0-9a-f]{8}-/.test(opts.parentUuid));
  const elements: any[] = [
    {
      tag: 'markdown',
      content:
        `**\`${opts.name}\`** 仍在后台运行` +
        (opts.workerPid ? `(bg worker pid=${opts.workerPid})` : '') +
        `。\n\n` +
        `从飞书发新消息会让 worker 和飞书侧的 claude **同时**在 \`${truncateCwd(opts.cwd)}\` ` +
        `操作文件,可能造成改动互相覆盖。bot 默认拒绝,请选择:`,
    },
    {
      tag: 'markdown',
      content: `**你的消息:** ${opts.text.length > 100 ? opts.text.slice(0, 100) + '…' : opts.text}`,
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🛑 停 bg 后继续发送' },
          value: {
            tag: 'agent_view_stop_and_send',
            shortId: opts.shortId,
            sessionId: opts.sessionId,
            cwd: opts.cwd,
            text: opts.text,
            parentUuid: opts.parentUuid ?? '',
            hasParent,
          },
          type: 'primary',
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🌿 开新会话发送' },
          value: { tag: 'agent_view_new_and_send', cwd: opts.cwd, text: opts.text },
          type: 'default',
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '❌ 取消' },
          value: { tag: 'agent_view_bg_conflict_cancel' },
          type: 'default',
        },
      ],
    },
  ];
  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: {
      title: { tag: 'plain_text', content: `⚠️ bg worker 仍在运行 · \`${opts.name}\`` },
      template: 'yellow',
    },
    elements,
  });
}

/** 25KB 卡片上限(同 MAX_CARD_BYTES in manager.ts) */
const MAX_ATTACH_CARD_BYTES = 25_000;
/** 智能截断的 recentOutput 字符预算档位 */
const ATTACH_RECENT_BUDGETS = [2048, 1024, 512, 256];

/**
 * 智能截断 recentOutput,保证最终卡片 ≤ 25KB。
 * 优先级:2048 → 1024 → 512 → 256 字符。每档调 renderAttachedCardJson + 测 bytes。
 * 全部超 25KB 时降级为警告文字。
 *
 * **关键:调 renderAttachedCardJson,不调 buildAttachedCard —— 后者会再调本函数,无限递归**
 * @internal
 */
function truncateRecentForCard(
  opts: Parameters<typeof renderAttachedCardJson>[0],
  rawRecentOutput: string,
): string {
  for (const budget of ATTACH_RECENT_BUDGETS) {
    const truncated =
      rawRecentOutput.length <= budget
        ? rawRecentOutput
        : rawRecentOutput.slice(0, budget);
    const cardJson = renderAttachedCardJson({ ...opts, recentOutput: truncated });
    if (new TextEncoder().encode(cardJson).length <= MAX_ATTACH_CARD_BYTES) {
      return truncated;
    }
  }
  return '⚠️ 内容过大, 请点 [Peek] 查看完整';
}

/**
 * 内部渲染器:无截断,纯字符串拼接。被 buildAttachedCard(经 truncateRecentForCard)和 truncateRecentForCard 自身共用。
 * @internal
 */
function renderAttachedCardJson(opts: {
  name: string;
  status: AgentSessionStatus;
  completed?: boolean;
  waitingFor?: string;
  shortId: string;
  sessionId: string;
  cwd: string;
  recentOutput: string;
  outputFormat: 'markdown' | 'terminal';
  lastWatchedAt: string;
  /** 覆盖 header title(默认 `📡 Watching · \`name\``)。Final patch 时用 per-reason 文案。 */
  headerTitle?: string;
}): string {
  const statusLabel =
    opts.status === 'busy' ? '处理中'
    : opts.status === 'waiting' ? '等待输入'
    : opts.status === 'idle' ? (opts.completed ? '已完成' : '空闲')
    : '未知';

  const recentBlock =
    opts.outputFormat === 'terminal'
      ? `**Recent output** _(原始终端片段,可能含格式残留)_\n\`\`\`\n${opts.recentOutput}\n\`\`\``
      : `**Recent output**\n\n${opts.recentOutput}`;

  const elements: any[] = [
    {
      tag: 'markdown',
      content:
        `Status: ${statusLabel} (${opts.status})` +
        (opts.waitingFor ? `\n等待原因: ${opts.waitingFor}` : '') +
        `\nCWD: ${truncateCwd(opts.cwd)}`,
    },
    { tag: 'markdown', content: recentBlock },
    { tag: 'markdown', content: `Last watched ${opts.lastWatchedAt}` },
  ];

  const actions: any[] = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '🔄 Refresh' },
      value: {
        tag: 'agent_view_refresh_peek',
        shortId: opts.shortId,
        sessionId: opts.sessionId,
      },
      type: 'default',
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '🛑 Stop Watching' },
      value: { tag: 'agent_view_stop_watching' },
      type: 'default',
    },
  ];
  if (opts.status === 'waiting') {
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
  }
  if (opts.status === 'busy') {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: 'Stop session' },
      value: {
        tag: 'agent_view_stop',
        shortId: opts.shortId,
        sessionId: opts.sessionId,
        name: opts.name,
      },
      type: 'danger',
    });
  }
  elements.push({ tag: 'action', actions });

  return JSON.stringify({
    ...TEMPLATE_HEADER,
    header: {
      title: { tag: 'plain_text', content: opts.headerTitle ?? `📡 Watching · \`${opts.name}\`` },
      template: 'blue',
    },
    elements,
  });
}

/**
 * Attached 卡:Attach 成功后,bot 自动紧跟发的可交互卡 + 10s 自动 patch。
 *
 * 与 buildPeekCard 的差异:
 * - 移除 pid / startedAt(elapsed 由 "Last watched" 时间戳代替)
 * - 按钮组:[Refresh] [Stop Watching] [Reply] [Stop session](按 status 显隐)
 * - header title:`📡 Watching · \`name\``(蓝色)
 *
 * 25KB 截断在 Task 3 加 wrapper。
 */
export function buildAttachedCard(opts: {
  name: string;
  status: AgentSessionStatus;
  completed?: boolean;
  waitingFor?: string;
  shortId: string;
  sessionId: string;
  cwd: string;
  recentOutput: string;
  outputFormat: 'markdown' | 'terminal';
  lastWatchedAt: string;
  /** 覆盖 header title(默认 `📡 Watching · \`name\``)。Final patch 时用 per-reason 文案。 */
  headerTitle?: string;
}): string {
  const truncated = truncateRecentForCard(opts, opts.recentOutput);
  return renderAttachedCardJson({ ...opts, recentOutput: truncated });
}


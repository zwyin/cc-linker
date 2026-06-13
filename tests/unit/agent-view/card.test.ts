// tests/unit/agent-view/card.test.ts
import { describe, test, expect } from 'bun:test';
import {
  buildListCard,
  buildPeekCard,
  buildErrorCard,
  buildEmptyCard,
  buildWaitingCard,
  buildStopConfirmCard,
  buildBgConflictCard,
  buildAttachedCard,  // 新增
  buildRendezvousStopConfirmCard,  // v2.4: rendezvous stop-bg 确认卡
} from '../../../src/agent-view/card';
import { groupByStatus, type AgentSession, type AgentSessionGroup } from '../../../src/agent-view/types';
import { parseAgentsJson } from '../../../src/agent-view/snapshot';
import { readFileSync } from 'fs';
import { join } from 'path';

const fixtureDir = join(import.meta.dir, '..', '..', 'fixtures', 'agents-json');

describe('buildListCard', () => {
  test('renders busy / waiting / idle groups with correct buttons', () => {
    const sessions = parseAgentsJson(readFileSync(join(fixtureDir, 'waiting.json'), 'utf8'));
    const groups = groupByStatus(sessions);
    const card = JSON.parse(buildListCard(groups, '12:34:56'));
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toContain('Agent View');
    // waiting 组显示 [Peek] [Attach] [Reply]
    const waitingRow = card.elements.find(
      (e: any) => e.tag === 'action' && e.actions.some((a: any) => a.value?.tag === 'agent_view_reply_request')
    );
    expect(waitingRow).toBeDefined();
  });

  test('renders empty groups (no group header for empty)', () => {
    const card = JSON.parse(
      buildListCard({ busy: [], waiting: [], idle: [], completed: [] }, '12:34:56'),
    );
    // 不应有分组标题(只 0 个分组)
    const groupHeaders = card.elements.filter(
      (e: any) => e.tag === 'markdown' && /^.*\([0-9]+\)/.test(e.content || '')
    );
    expect(groupHeaders).toHaveLength(0);
  });

  test('exceeds 25KB: caller should fallback to text', () => {
    // 构造会超过 25KB 的 session:每个 name 3KB,10 个就 > 30KB
    // (但 manager 层会在 >= 10 个时 cap,所以需要超大 name 才能超 25KB)
    const big = Array.from({ length: 10 }, (_, i) => ({
      pid: i,
      cwd: '/very/long/path/' + 'x'.repeat(200) + '/' + i,
      kind: 'background',
      startedAt: 1000 + i,
      sessionId: 'uuid-' + i + '-aaaa-bbbb-cccc-dddd',
      name: 'session-' + 'y'.repeat(3000) + '-' + i,
      status: 'busy',
    }));
    const sessions = parseAgentsJson(JSON.stringify(big));
    const groups = groupByStatus(sessions);
    const cardStr = buildListCard(groups, '12:34:56');
    const size = new TextEncoder().encode(cardStr).length;
    // 卡大小 > 25KB,应由 manager 走 text fallback(此测试仅断言 size)
    expect(size).toBeGreaterThan(25_000);
  });

  test('v2.2: shows "… N more" overflow line when hasMore > 0', () => {
    const sessions = parseAgentsJson(
      readFileSync(join(fixtureDir, 'waiting.json'), 'utf8'),
    );
    const groups = groupByStatus(sessions);
    const card = JSON.parse(buildListCard(groups, '12:34:56', 5));
    const overflowLine = card.elements.find(
      (e: any) =>
        e.tag === 'markdown' &&
        typeof e.content === 'string' &&
        e.content.includes('… 5 more'),
    );
    expect(overflowLine).toBeDefined();
    // spec §6.1:必须提示用户用 `claude agents --cwd <path>` 缩小范围
    expect(overflowLine?.content).toContain('claude agents --cwd <path>');
  });

  test('v2.2: no overflow line when hasMore = 0 (default)', () => {
    const sessions = parseAgentsJson(
      readFileSync(join(fixtureDir, 'waiting.json'), 'utf8'),
    );
    const groups = groupByStatus(sessions);
    const card = JSON.parse(buildListCard(groups, '12:34:56'));
    const overflowLine = card.elements.find(
      (e: any) =>
        e.tag === 'markdown' &&
        typeof e.content === 'string' &&
        e.content.includes('more'),
    );
    expect(overflowLine).toBeUndefined();
  });

  test('v2.2.1: prepends ℹ️ status-source tooltip as first element', () => {
    const sessions = parseAgentsJson(
      readFileSync(join(fixtureDir, 'waiting.json'), 'utf8'),
    );
    const groups = groupByStatus(sessions);
    const card = JSON.parse(buildListCard(groups, '12:34:56'));
    // tooltip 是 elements[0],先于 "Last refreshed" 和 group headers
    // v2.3: 状态来源改为 state.json(原来 claude agents --json)
    const tooltip = card.elements.find(
      (e: any) =>
        e.tag === 'markdown' &&
        typeof e.content === 'string' &&
        e.content.includes('state.json'),
    );
    expect(tooltip).toBeDefined();
    // v2.3: state.json 来自 ~/.claude/jobs/<short> 路径下
    expect(tooltip.content).toContain('~/.claude/jobs');
    // 第二个 markdown 必须是 "Last refreshed"(保持原有顺序)
    const refreshLine = card.elements.find(
      (e: any) =>
        e.tag === 'markdown' &&
        typeof e.content === 'string' &&
        e.content.startsWith('Last refreshed'),
    );
    expect(refreshLine).toBeDefined();
  });

  test('v2.2.4: renders a separate "已完成" section for completed sessions', () => {
    const groups = {
      busy: [],
      waiting: [],
      idle: [],
      completed: [
        {
          pid: 0,
          cwd: '',
          kind: 'background' as const,
          startedAt: Date.now() - 5 * 60_000,
          sessionId: '3a41fe73',
          name: '✅ fix-flaky-test',
          status: 'idle' as const,
          source: 'slash' as const,
          completed: true,
        },
      ],
    };
    const card = JSON.parse(buildListCard(groups, '12:34:56'));
    // 标题用 "已完成" 区分于 idle 的 "空闲"
    const completedHeader = card.elements.find(
      (e: any) =>
        e.tag === 'markdown' &&
        typeof e.content === 'string' &&
        e.content.includes('已完成') &&
        e.content.includes('(1)'),
    );
    expect(completedHeader).toBeDefined();
    // 总数应包含 completed
    expect(card.header.title.content).toContain('1 sessions');
  });

  test('v2.2.4: completed sessions do NOT appear in idle group', () => {
    const sessions: AgentSession[] = [
      {
        pid: 1,
        cwd: '/a',
        kind: 'background',
        startedAt: 0,
        sessionId: 'idle0000-1111-2222-3333-444444444444',
        name: 'active-idle',
        status: 'idle',
        source: 'slash',
      },
      {
        pid: 0,
        cwd: '',
        kind: 'background',
        startedAt: 0,
        sessionId: 'compl000-1111-2222-3333-444444444444',
        name: '✅ done',
        status: 'idle',
        source: 'slash',
        completed: true,
      },
    ];
    const groups = groupByStatus(sessions);
    expect(groups.idle).toHaveLength(1);
    expect(groups.idle[0].sessionId.startsWith('idle0000')).toBe(true);
    expect(groups.completed).toHaveLength(1);
    expect(groups.completed[0].sessionId.startsWith('compl000')).toBe(true);
  });
});

describe('buildListCard v2.3 — group order waiting first', () => {
  function mkSession(over: Partial<AgentSession>): AgentSession {
    return {
      pid: 0, cwd: '/tmp/x', kind: 'background', startedAt: Date.now() - 60000,
      sessionId: 'abcdef12-1234-1234-1234-123456789012',
      name: 'x', status: 'busy', source: 'unknown', ...over,
    };
  }

  test('waiting group renders before busy', () => {
    const groups: AgentSessionGroup = {
      busy: [mkSession({ name: 'b1', status: 'busy' })],
      waiting: [mkSession({ name: 'w1', status: 'waiting',
                            waitingFor: '继续吗?', detail: '继续吗?' })],
      idle: [],
      completed: [],
    };
    const cardStr = buildListCard(groups, 'now');
    const flat = JSON.stringify(JSON.parse(cardStr));
    // 'w1' 必须出现在 'b1' 之前
    expect(flat.indexOf('w1')).toBeLessThan(flat.indexOf('b1'));
    expect(flat.indexOf('w1')).toBeGreaterThan(-1);
    expect(flat.indexOf('b1')).toBeGreaterThan(-1);
  });

  test('subtitle line includes needs for waiting session', () => {
    const groups: AgentSessionGroup = {
      busy: [], idle: [], completed: [],
      waiting: [mkSession({
        name: 'reply-me', status: 'waiting',
        waitingFor: '是否继续？', detail: '是否继续？',
      })],
    };
    const cardStr = buildListCard(groups, 'now');
    expect(cardStr).toContain('是否继续？');
  });

  test('subtitle line includes detail for busy session', () => {
    const groups: AgentSessionGroup = {
      busy: [mkSession({
        name: 'reviewing', status: 'busy',
        detail: '# 修正完成 — 最终汇总',
      })],
      idle: [], waiting: [], completed: [],
    };
    const cardStr = buildListCard(groups, 'now');
    expect(cardStr).toContain('# 修正完成');
  });

  test('subtitle truncates very long detail to ~60 chars', () => {
    const groups: AgentSessionGroup = {
      busy: [mkSession({
        name: 'long', status: 'busy',
        detail: 'A'.repeat(200),
      })],
      idle: [], waiting: [], completed: [],
    };
    const cardStr = buildListCard(groups, 'now');
    // 60 字符 A + … (truncate marker)
    expect(cardStr).toContain('A'.repeat(60) + '…');
    expect(cardStr).not.toContain('A'.repeat(100));  // no overflow
  });

  test('subtitle falls back to intent when detail is empty', () => {
    const groups: AgentSessionGroup = {
      busy: [], waiting: [], completed: [],
      idle: [mkSession({
        name: 'just-started', status: 'idle',
        intent: '原始派发命令',
      })],
    };
    const cardStr = buildListCard(groups, 'now');
    expect(cardStr).toContain('原始派发命令');
  });

  test('stopped session keeps 🛑 prefix in completed group', () => {
    const groups: AgentSessionGroup = {
      busy: [], waiting: [], idle: [],
      completed: [mkSession({ name: '🛑 cancelled', status: 'idle', completed: true })],
    };
    const cardStr = buildListCard(groups, 'now');
    expect(cardStr).toContain('🛑 cancelled');
  });

  test('footer mentions state.json, NOT "claude agents --json"', () => {
    const groups: AgentSessionGroup = { busy: [], waiting: [], idle: [], completed: [] };
    const cardStr = buildListCard(groups, 'now');
    expect(cardStr).toContain('state.json');
    expect(cardStr).not.toContain('claude agents --json');
  });

  test('no subtitle line when no detail/needs/intent', () => {
    const groups: AgentSessionGroup = {
      busy: [], idle: [mkSession({ name: 'bare', status: 'idle' })], waiting: [], completed: [],
    };
    const cardStr = buildListCard(groups, 'now');
    expect(cardStr).toContain('bare');
    // No subtitle marker — no ❓ in this card, no 副标题 ❓ from previous renders
    const parsed = JSON.parse(cardStr);
    const flat = JSON.stringify(parsed);
    // 验证 bare 这行没有 ❓ 标记(只有 emoji name 列出现 emoji,无副标题 ❓)
    expect(flat).not.toContain('❓');
  });
});

describe('buildPeekCard', () => {
  test('renders status + waitingFor + recentOutput', () => {
    const card = JSON.parse(
      buildPeekCard({
        name: 'flaky-test-fix',
        status: 'waiting',
        waitingFor: 'input needed',
        cwd: '~/projects/my-app',
        pid: 33348,
        startedAt: 1780728421000,
        recentOutput: 'What would you like to do?',
        shortId: 'short1', // v2.2: 按钮 value 需要
        sessionId: 'uuid-1', // v2.2: 按钮 value 需要
        buttons: { peek: true, attach: true, reply: true, stop: false, refresh: true },
      })
    );
    expect(card.header.title.content).toContain('flaky-test-fix');
    expect(JSON.stringify(card)).toContain('input needed');
  });
});

describe('buildErrorCard', () => {
  test('renders version error', () => {
    const card = JSON.parse(
      buildErrorCard({
        title: 'Claude 版本过低',
        body: '需要 v2.1.139+,当前 v2.1.100',
      })
    );
    expect(card.header.template).toBe('red');
    expect(card.header.title.content).toContain('❌');
  });
});

describe('buildEmptyCard', () => {
  test('renders empty state with [回到普通聊天] + [Refresh]', () => {
    const card = JSON.parse(buildEmptyCard());
    const actions = card.elements.find((e: any) => e.tag === 'action');
    const tags = actions?.actions?.map((a: any) => a.value?.tag) || [];
    expect(tags).toContain('agent_view_back_to_chat');
    expect(tags).toContain('agent_view_refresh_list');
  });
});

describe('buildWaitingCard', () => {
  test('renders waiting input card with [取消等待]', () => {
    const card = JSON.parse(
      buildWaitingCard({
        name: 'power-up',
        status: 'waiting',
        waitingFor: 'input needed',
        cwd: '/x',
      })
    );
    const actions = card.elements.find((e: any) => e.tag === 'action');
    expect(actions?.actions?.[0]?.value?.tag).toBe('agent_view_cancel_reply');
    expect(JSON.stringify(card)).toContain('5 分钟');
  });
});

describe('buildStopConfirmCard', () => {
  test('renders stop confirm with [确认停止] + [取消]', () => {
    // v2.2 修正:必须传 shortId, sessionId(不只是 name)
    const card = JSON.parse(buildStopConfirmCard('flaky-test-fix', 'short1', 'uuid-1'));
    const actions = card.elements.find((e: any) => e.tag === 'action');
    const tags = actions?.actions?.map((a: any) => a.value?.tag) || [];
    expect(tags).toContain('agent_view_stop_confirm');
  });
});

describe('buildRendezvousStopConfirmCard', () => {
  test('renders red header with shortId + [确认] + [取消] buttons', () => {
    const card = JSON.parse(buildRendezvousStopConfirmCard('abc12345'));
    expect(card.header.template).toBe('red');
    expect(card.header.title.content).toContain('abc12345');
    const a = card.elements.find((e: any) => e.tag === 'action');
    expect(a.actions).toHaveLength(2);
    expect(a.actions[0].text.content).toMatch(/确认/);
    expect(a.actions[0].type).toBe('danger');
    expect(a.actions[0].value).toEqual({
      tag: 'agent_view_rendezvous_stop_bg_confirm', shortId: 'abc12345',
    });
    expect(a.actions[1].text.content).toMatch(/取消/);
  });

  test('has update_multi: true (avoid Feishu merge-revert bug)', () => {
    const card = JSON.parse(buildRendezvousStopConfirmCard('abc12345'));
    expect(card.config?.update_multi).toBe(true);
  });
});

/**
 * v2.2.20: Agent View 卡的 patch 在飞书侧被回滚/覆盖的根本原因之一是
 * 缺 update_multi: true。CardUpdater 的所有动态卡(streaming/permission/
 * CLI busy)都设了 update_multi:true,飞书把这当 "streaming-friendly" 处理,
 * 每次 patch 都替换显示;Peek/List 等 agent-view 卡没有这个标记,飞书某些
 * 情况下把首次 patch 当作 "merge" 而非 "replace" 处理,导致回滚到旧内容。
 * 修复:TEMPLATE_HEADER 统一加 update_multi: true。
 */
describe('Agent View cards: update_multi: true (v2.2.20 fix for Peek revert bug)', () => {
  test('buildPeekCard has update_multi: true', () => {
    const card = JSON.parse(
      buildPeekCard({
        name: 'x', status: 'busy', cwd: '/', pid: 1, startedAt: 0,
        recentOutput: 'r', shortId: 's', sessionId: 'u',
        buttons: { peek: true, attach: true, reply: false, stop: true, refresh: true },
      }),
    );
    expect(card.config).toBeDefined();
    expect(card.config?.update_multi).toBe(true);
  });

  test('buildListCard has update_multi: true', () => {
    const card = JSON.parse(
      buildListCard({ busy: [], waiting: [], idle: [], completed: [] }, '12:34:56'),
    );
    expect(card.config?.update_multi).toBe(true);
  });

  test('buildErrorCard has update_multi: true', () => {
    const card = JSON.parse(buildErrorCard({ title: 'X', body: 'Y' }));
    expect(card.config?.update_multi).toBe(true);
  });

  test('buildEmptyCard has update_multi: true', () => {
    const card = JSON.parse(buildEmptyCard());
    expect(card.config?.update_multi).toBe(true);
  });

  test('buildWaitingCard has update_multi: true', () => {
    const card = JSON.parse(
      buildWaitingCard({ name: 'x', status: 'waiting', cwd: '/' }),
    );
    expect(card.config?.update_multi).toBe(true);
  });

  test('buildStopConfirmCard has update_multi: true', () => {
    const card = JSON.parse(buildStopConfirmCard('x', 's', 'u'));
    expect(card.config?.update_multi).toBe(true);
  });

  test('buildBgConflictCard has update_multi: true', () => {
    const card = JSON.parse(
      buildBgConflictCard({
        name: 'x', shortId: 's', sessionId: 'u', cwd: '/', text: 't',
      }),
    );
    expect(card.config?.update_multi).toBe(true);
  });
});

describe('buildAttachedCard', () => {
  const baseOpts = {
    name: 'sleep 30',
    status: 'busy' as const,
    shortId: 'abc12345',
    sessionId: 'abc12345-9be0-4d5e-8b3f-1234567890ab',
    cwd: '/Users/wuyujun/Git/trae-data',
    recentOutput: '执行 sleep 30 中',
    outputFormat: 'markdown' as const,
    lastWatchedAt: '12:34:56',
  };

  test('renders header with name and Watching prefix', () => {
    const card = JSON.parse(buildAttachedCard(baseOpts));
    expect(card.header.title.content).toBe('📡 Watching · `sleep 30`');
    expect(card.header.template).toBe('blue');
    // 必须有 update_multi: true 避免飞书 merge 渲染
    expect(card.config.update_multi).toBe(true);
  });

  test('shows status line with cwd but hides pid/startedAt', () => {
    const card = JSON.parse(buildAttachedCard(baseOpts));
    const markdownTexts = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .map((e: any) => e.content)
      .join('\n');
    expect(markdownTexts).toContain('Status: 处理中 (busy)');
    expect(markdownTexts).toContain('CWD: ~/Git/trae-data');
    // 不应包含 Peek 卡的 PID / Started 字样
    expect(markdownTexts).not.toContain('PID:');
    expect(markdownTexts).not.toContain('Started');
  });

  test('waiting status shows waitingFor', () => {
    const card = JSON.parse(
      buildAttachedCard({ ...baseOpts, status: 'waiting', waitingFor: 'input needed' }),
    );
    const text = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .map((e: any) => e.content)
      .join('\n');
    expect(text).toContain('等待原因: input needed');
  });

  test('waiting status hides waitingFor line when undefined', () => {
    const card = JSON.parse(buildAttachedCard({ ...baseOpts, status: 'waiting' }));
    const text = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .map((e: any) => e.content)
      .join('\n');
    expect(text).not.toContain('等待原因:');
  });

  test('shows 3 buttons when status is busy: refresh / stop_watching / stop', () => {
    const card = JSON.parse(buildAttachedCard(baseOpts));
    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    expect(actionEl).toBeDefined();
    const tags = actionEl.actions.map((a: any) => a.value.tag);
    expect(tags).toContain('agent_view_refresh_peek');
    expect(tags).toContain('agent_view_stop_watching');
    expect(tags).toContain('agent_view_stop');
    expect(tags).not.toContain('agent_view_attach'); // 已 attach 不再显示
  });

  test('waiting status shows reply button (not stop)', () => {
    const card = JSON.parse(
      buildAttachedCard({ ...baseOpts, status: 'waiting', waitingFor: 'input' }),
    );
    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    const tags = actionEl.actions.map((a: any) => a.value.tag);
    expect(tags).toContain('agent_view_reply_request');
    expect(tags).not.toContain('agent_view_stop');
  });

  test('idle status shows only refresh + stop_watching', () => {
    const card = JSON.parse(buildAttachedCard({ ...baseOpts, status: 'idle' }));
    const actionEl = card.elements.find((e: any) => e.tag === 'action');
    const tags = actionEl.actions.map((a: any) => a.value.tag);
    expect(tags).toEqual(
      expect.arrayContaining(['agent_view_refresh_peek', 'agent_view_stop_watching']),
    );
    expect(tags).not.toContain('agent_view_stop');
    expect(tags).not.toContain('agent_view_reply_request');
  });

  test('shows Last watched timestamp at end', () => {
    const card = JSON.parse(buildAttachedCard({ ...baseOpts, lastWatchedAt: '23:59:59' }));
    const lastMarkdown = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .pop();
    expect(lastMarkdown.content).toBe('Last watched 23:59:59');
  });

  test('terminal outputFormat wraps in code-block with warning', () => {
    const card = JSON.parse(
      buildAttachedCard({ ...baseOpts, outputFormat: 'terminal' }),
    );
    const recentBlock = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .find((e: any) => e.content.includes('Recent output'));
    expect(recentBlock.content).toContain('原始终端片段');
    expect(recentBlock.content).toContain('```');
  });

  test('markdown outputFormat does not wrap in code-block', () => {
    const card = JSON.parse(
      buildAttachedCard({ ...baseOpts, outputFormat: 'markdown' }),
    );
    const recentBlock = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .find((e: any) => e.content.includes('Recent output'));
    expect(recentBlock.content).not.toContain('```');
  });
});

describe('buildAttachedCard 25KB smart truncation', () => {
  // 构造一个固定大小的 recentOutput,让 buildAttachedCard 序列化后超 25KB
  // recentOutput 占大头,所以我们用 massive content
  const bigOpts = {
    name: 'big',
    status: 'busy' as const,
    shortId: 'big12345',
    sessionId: 'big12345-9be0-4d5e-8b3f-1234567890ab',
    cwd: '/x',
    outputFormat: 'markdown' as const,
    lastWatchedAt: '00:00:00',
  };

  test('recentOutput under 2KB: card built without truncation', () => {
    const out = 'x'.repeat(1500); // < 2048
    const card = JSON.parse(buildAttachedCard({ ...bigOpts, recentOutput: out }));
    // 包含原始内容(没被截断到 1024)
    expect(card.elements.some((e: any) =>
      e.tag === 'markdown' && e.content.includes('x'.repeat(1500))
    )).toBe(true);
  });

  test('recentOutput over 25KB: progressive truncation brings it under 25KB', () => {
    const out = 'y'.repeat(30_000); // 远超 2KB,会触发截断链
    const cardJson = buildAttachedCard({ ...bigOpts, recentOutput: out });
    const card = JSON.parse(cardJson);
    const cardBytes = new TextEncoder().encode(cardJson).length;
    expect(cardBytes).toBeLessThanOrEqual(25_000);
    // 截断后内容必然少于 30_000(至少 256 字符)
    const recentBlock = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .find((e: any) => e.content.includes('Recent output'));
    expect(recentBlock.content.length).toBeLessThan(30_000);
  });

  test('extremely large recentOutput: falls back to warning message', () => {
    // 30KB 中文 + 控制字符,即使 256 截断都放不下整个 markdown wrapper 时
    // 走终极 fallback
    // 但实际上 256 字符的 markdown wrapper 远小于 25KB,这条主要防回归
    const out = 'z'.repeat(100_000);
    const card = JSON.parse(buildAttachedCard({ ...bigOpts, recentOutput: out }));
    const recentBlock = card.elements
      .filter((e: any) => e.tag === 'markdown')
      .find((e: any) => e.content.includes('Recent output'));
    // 应有 截断标记 或 fallback
    const isTruncated = recentBlock.content.length < 100_000;
    expect(isTruncated).toBe(true);
  });
});

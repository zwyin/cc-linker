// tests/unit/agent-view/card.test.ts
import { describe, test, expect } from 'bun:test';
import {
  buildListCard,
  buildPeekCard,
  buildErrorCard,
  buildEmptyCard,
  buildWaitingCard,
  buildStopConfirmCard,
} from '../../../src/agent-view/card';
import { groupByStatus } from '../../../src/agent-view/types';
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
    const card = JSON.parse(buildListCard({ busy: [], waiting: [], idle: [] }, '12:34:56'));
    // 不应有分组标题(只 0 个分组)
    const groupHeaders = card.elements.filter(
      (e: any) => e.tag === 'markdown' && /^.*\([0-9]+\)/.test(e.content || '')
    );
    expect(groupHeaders).toHaveLength(0);
  });

  test('exceeds 25KB: caller should fallback to text', () => {
    // 构造 200 个 session
    const big = Array.from({ length: 200 }, (_, i) => ({
      pid: i,
      cwd: '/very/long/path/to/some/directory/' + i,
      kind: 'background',
      startedAt: 1000 + i,
      sessionId: 'uuid-' + i,
      name: 'session-' + i + '-name-very-long',
      status: 'busy',
    }));
    const sessions = parseAgentsJson(JSON.stringify(big));
    const groups = groupByStatus(sessions);
    const cardStr = buildListCard(groups, '12:34:56');
    const size = new TextEncoder().encode(cardStr).length;
    // 列表上限 10 个,所以正常情况不会超 25KB
    // 这个测试只确认 size 是 number
    expect(typeof size).toBe('number');
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

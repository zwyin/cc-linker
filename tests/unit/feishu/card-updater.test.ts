import { test, expect, mock, describe, beforeEach, afterEach } from 'bun:test';
import { CardUpdater } from '../../../src/feishu/card-updater';

function createMockClient() {
  const createFn = mock(async () => ({ data: { message_id: 'om_card_123' } }));
  const patchFn = mock(async () => ({}));
  return {
    im: { v1: { message: { create: createFn, patch: patchFn } } },
    createFn,
    patchFn,
  };
}

test('startProcessing sends initial card and returns message_id', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any);
  const id = await updater.startProcessing('ou_user123');
  expect(id).toBe('om_card_123');
  expect(m.createFn).toHaveBeenCalledTimes(1);
});

test('updateStream patches the card with content', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 0 });
  await updater.startProcessing('ou_user123');
  await updater.updateStream('thinking...', 'reply...', 10);
  expect(m.patchFn).toHaveBeenCalled();
});

test('throttle prevents rapid patches', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 100 });
  await updater.startProcessing('ou_user123');
  await updater.updateStream('t1', '', 5);
  const count1 = m.patchFn.mock.calls.length;
  await updater.updateStream('t2', '', 6);
  const count2 = m.patchFn.mock.calls.length;
  expect(count2).toBe(count1); // throttled
  await new Promise(r => setTimeout(r, 150));
  const count3 = m.patchFn.mock.calls.length;
  expect(count3).toBeGreaterThan(count1);
});

test('complete patches with green header', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 0 });
  await updater.startProcessing('ou_user123');
  await updater.complete('Final answer', 0.05, 2000, 3);
  const lastCall = m.patchFn.mock.calls[m.patchFn.mock.calls.length - 1];
  const card = JSON.parse(lastCall[0].data.content);
  expect(card.header.template).toBe('green');
});

test('error patches with red header', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 0 });
  await updater.startProcessing('ou_user123');
  await updater.error('Crashed');
  const lastCall = m.patchFn.mock.calls[m.patchFn.mock.calls.length - 1];
  const card = JSON.parse(lastCall[0].data.content);
  expect(card.header.template).toBe('red');
});

test('shouldFallbackToText detects oversized content', () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { max_card_bytes: 100 });
  expect(updater.shouldFallbackToText('x'.repeat(200))).toBe(true);
  expect(updater.shouldFallbackToText('short')).toBe(false);
});

test('truncateContent cuts to max_card_bytes', () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { max_card_bytes: 10 });
  const truncated = updater.truncateContent('Hello World!');
  const encoder = new TextEncoder();
  expect(encoder.encode(truncated).length).toBeLessThanOrEqual(13);
});

/**
 * v2.4.x: 当 bg 处理完一个 reply 又问新问题 (new_needs), 卡应当 patch 回
 * "等待输入" 状态(黄色 header + [取消等待] 按钮), 而不是 "🛑 已取消"。
 * 语义: bg 没死, 只是发完一个 turn 后又问下一个。
 */
test('patchWaitingCard patches with yellow waiting header + cancel button', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 0 });
  // adopt 一张已有卡(模拟 reply 路径接管等待卡)
  await updater.adoptExistingCard('om_existing_456', false);
  expect(m.patchFn).not.toHaveBeenCalled();

  await updater.patchWaitingCard({
    name: 'bash loop script',
    status: 'waiting',
    waitingFor: '是否继续?',
    cwd: '~',
    recentOutput: '当前时间: 02:32',
  });

  expect(m.patchFn).toHaveBeenCalledTimes(1);
  const lastCall = m.patchFn.mock.calls[m.patchFn.mock.calls.length - 1];
  const card = JSON.parse(lastCall[0].data.content);
  expect(card.header.template).toBe('yellow');  // 等待卡是黄色
  expect(card.header.title.content).toContain('回复');
  expect(card.header.title.content).toContain('bash loop script');
  // 等待原因要在 elements 里
  const md = card.elements.find((e: any) => e.tag === 'markdown');
  expect(md.content).toContain('是否继续?');
  // [取消等待] 按钮要在
  const action = card.elements.find((e: any) => e.tag === 'action');
  expect(action).toBeDefined();
  const cancelBtn = action.actions.find((a: any) => a.text?.content?.includes('取消等待'));
  expect(cancelBtn).toBeDefined();
});

test('patchWaitingCard preserves existing cardMessageId (no new card created)', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 0 });
  await updater.adoptExistingCard('om_existing_789', false);
  await updater.patchWaitingCard({
    name: 'test',
    status: 'waiting',
    cwd: '~',
  });
  expect(updater.getCardMessageId()).toBe('om_existing_789');
  // patch 用的是 adopt 的 id, 不是 create
  expect(m.createFn).not.toHaveBeenCalled();
});

/**
 * v2.4.x UX 改进: 处理中卡的初始布局跟 streaming 卡片一致 (header "💭 处理中"
 * + ⏱ 0s), 而不是静态"Claude 正在处理你的请求, 预计 2-10 秒..."文本。
 * 这样 updateStream 的 patch 不会改变 header, 视觉更连贯。
 */
test('startProcessing initial card uses streaming layout (💭 处理中 + ⏱ 0s)', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any);
  await updater.startProcessing('ou_user123');
  const lastCall = m.createFn.mock.calls[m.createFn.mock.calls.length - 1];
  const card = JSON.parse(lastCall[0].data.content);
  expect(card.header.template).toBe('blue');
  expect(card.header.title.content).toBe('💭 处理中');
  // 应该有 ⏱ 0s 元素 (elapsed time), 但不应该有静态"Claude 正在处理"文本
  const elapsedEl = card.elements.find((e: any) => e.tag === 'markdown' && e.content?.includes('⏱'));
  expect(elapsedEl).toBeDefined();
  expect(elapsedEl.content).toContain('0s');
  // 不应该再有"Claude 正在处理你的请求" 那种占位文本
  const placeholderEl = card.elements.find((e: any) =>
    e.tag === 'markdown' && e.content?.includes('Claude 正在处理你的请求')
  );
  expect(placeholderEl).toBeUndefined();
});

/**
 * v2.4.x: adoptExistingCard + initialPatch=true 也应该用 streaming 布局,
 * 这样 reply 路径接管等待卡时, 不会先变成"⏳ 正在处理"再变成"💭 处理中"。
 */
test('adoptExistingCard with initialPatch uses streaming layout (💭 处理中)', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 0 });
  await updater.adoptExistingCard('om_existing_adopt', true);
  const lastCall = m.patchFn.mock.calls[m.patchFn.mock.calls.length - 1];
  const card = JSON.parse(lastCall[0].data.content);
  expect(card.header.template).toBe('blue');
  expect(card.header.title.content).toBe('💭 处理中');
  // 不应该有静态占位文本
  const placeholderEl = card.elements.find((e: any) =>
    e.tag === 'markdown' && e.content?.includes('Claude 正在处理你的请求')
  );
  expect(placeholderEl).toBeUndefined();
});

/**
 * v2.4.x bug fix: updateStream 调后会 schedule 一个 5s 后执行的 pending
 * timer (throttle 节流)。如果调用方在 timer 触发前做了终态 patch
 * (patchWaitingCard/complete/error), 旧 timer 仍会 fire, 把卡片 revert
 * 回去 (例如从 "↩️ 回复" revert 成 "💭 处理中")。这导致用户看到卡片卡住
 * 在处理中状态, 不刷新。
 *
 * cancelPending() 必须取消这个 timer, 让终态保持。
 */
test('cancelPending cancels scheduled timer — 终态 patch 不会被回退', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 1000 });
  await updater.startProcessing('ou_user123');
  m.patchFn.mockClear();

  await updater.updateStream('', 'partial text', 100);
  expect(m.patchFn).not.toHaveBeenCalled();

  updater.cancelPending();

  await new Promise(r => setTimeout(r, 1500));

  expect(m.patchFn).not.toHaveBeenCalled();
});

/**
 * v2.x: rendezvous 模式 button 渲染 — [🔙 不等了] + [🛑 停 bg] 双按钮,
 * [🛑 停 bg] 按钮 value 注入 shortId。default 模式保持原单按钮 [🛑 停止处理]。
 * 原因: rendezvous 等待 bg 跟单 turn 处理不同 — 多了"不等了"(abort wait,
 * bg 继续)和"停 bg"(真停 daemon)两个动作。
 */
describe('CardUpdater — streaming card button mode', () => {
  const mockClient: any = {
    im: { v1: { message: {
      create: mock(async () => ({ data: { message_id: 'mid-1' } })),
      patch: mock(async () => ({ code: 0 })),
    } } },
  };

  test('default mode renders single [🛑 停止处理] with value.tag="stop"', () => {
    const u = new CardUpdater(mockClient);
    const card: any = (u as any).buildStreamingCard('', '', 0, []);
    const a = card.elements.find((e: any) => e.tag === 'action');
    expect(a.actions).toHaveLength(1);
    expect(a.actions[0].text.content).toBe('🛑 停止处理');
    expect(a.actions[0].value).toEqual({ tag: 'stop' });
  });

  test('rendezvous mode renders two buttons with shortId', () => {
    const u = new CardUpdater(mockClient, { buttons: 'rendezvous' });
    (u as any).setRendezvousShortId('abcd1234');
    const card: any = (u as any).buildStreamingCard('', '', 0, []);
    const a = card.elements.find((e: any) => e.tag === 'action');
    expect(a.actions).toHaveLength(2);
    expect(a.actions[0].text.content).toBe('🔙 不等了');
    expect(a.actions[0].value).toEqual({ tag: 'agent_view_rendezvous_abort_wait' });
    expect(a.actions[1].text.content).toBe('🛑 停 bg');
    expect(a.actions[1].value).toEqual({
      tag: 'agent_view_rendezvous_stop_bg_request', shortId: 'abcd1234',
    });
  });
});

/**
 * v2.x: rendezvous abort/stop 专用终态 patch — 自定义 header + body,
 * 不复用 cancel() (硬编码 "🛑 已取消" + "随时发送新消息" 后缀, 跟 abort
 * 语义"bg 仍在 daemon"冲突)。
 */
describe('CardUpdater.patchAbortedTracking', () => {
  test('emits custom header + body without "随时发送新消息" suffix', async () => {
    const patches: any[] = [];
    const mockClient: any = {
      im: { v1: { message: {
        create: mock(async () => ({ data: { message_id: 'mid-x' } })),
        patch: mock(async (p: any) => { patches.push(JSON.parse(p.data.content)); return { code: 0 }; }),
      } } },
    };
    const u = new CardUpdater(mockClient);
    (u as any).cardMessageId = 'mid-x';

    await u.patchAbortedTracking({
      headerTitle: '🔙 已停止跟踪',
      headerTemplate: 'grey',
      body: 'bg 仍在 daemon 中运行 · /agents 可查看后续',
    });

    expect(patches).toHaveLength(1);
    expect(patches[0].header.title.content).toBe('🔙 已停止跟踪');
    expect(patches[0].header.template).toBe('grey');
    const md = patches[0].elements.find((e: any) => e.tag === 'markdown');
    expect(md.content).toBe('bg 仍在 daemon 中运行 · /agents 可查看后续');
    expect(md.content).not.toContain('随时发送新消息');
  });
});

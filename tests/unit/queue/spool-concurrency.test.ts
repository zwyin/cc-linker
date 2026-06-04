import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SpoolQueue, SpoolMessage } from '../../../src/queue/spool';

describe('SpoolQueue concurrency with cmd: serialKey (PR 2 pain point A core guarantee)', () => {
  let tmpDir: string;
  let spoolQueue: SpoolQueue;

  function makeMsg(messageId: string, serialKey: string, text: string): SpoolMessage {
    return {
      messageId,
      openId: 'ou_user1',
      text,
      target: { type: 'no_target' as const, openId: 'ou_user1' },
      serialKey,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'spool-concurrency-test-'));
    spoolQueue = new SpoolQueue(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // 场景 A：两个不同 messageId 的 command 都能 claim（核心保证）
  it('two cmd: messages with different messageIds can be claimed concurrently', async () => {
    spoolQueue.enqueue(makeMsg('om_msg_001', 'cmd:ou_user1:om_msg_001', '/list'));
    spoolQueue.enqueue(makeMsg('om_msg_002', 'cmd:ou_user1:om_msg_002', '/status'));

    // claim 第一条 → 成功
    const claimed1 = await spoolQueue.claimNext('cmd:ou_user1:om_msg_001');
    expect(claimed1).not.toBeNull();
    expect(claimed1?.messageId).toBe('om_msg_001');

    // claim 第二条 → 也成功（不同 serialKey 不被 processing 中的第一条阻塞）
    const claimed2 = await spoolQueue.claimNext('cmd:ou_user1:om_msg_002');
    expect(claimed2).not.toBeNull();
    expect(claimed2?.messageId).toBe('om_msg_002');
  });

  // 场景 A 变体：session streaming + /list 并行（痛点 A 的真实场景）
  it('session streaming (sessionUuid serialKey) + cmd: /list can be claimed concurrently', async () => {
    spoolQueue.enqueue(makeMsg('om_session_msg', 'sess-abc-123', '继续工作'));
    spoolQueue.enqueue(makeMsg('om_list_msg', 'cmd:ou_user1:om_list_msg', '/list'));

    // session 消息被 claim，模拟正在 streaming
    const sessionClaimed = await spoolQueue.claimNext('sess-abc-123');
    expect(sessionClaimed).not.toBeNull();

    // /list 立即 claim 成功（不被 session processing 阻塞）
    const listClaimed = await spoolQueue.claimNext('cmd:ou_user1:om_list_msg');
    expect(listClaimed).not.toBeNull();
    expect(listClaimed?.text).toBe('/list');
  });

  // 场景 E：连续三条 /list 都快速返回
  it('three /list commands with different messageIds all claim successfully', async () => {
    spoolQueue.enqueue(makeMsg('om_list_1', 'cmd:ou_user1:om_list_1', '/list'));
    spoolQueue.enqueue(makeMsg('om_list_2', 'cmd:ou_user1:om_list_2', '/list'));
    spoolQueue.enqueue(makeMsg('om_list_3', 'cmd:ou_user1:om_list_3', '/list'));

    const c1 = await spoolQueue.claimNext('cmd:ou_user1:om_list_1');
    const c2 = await spoolQueue.claimNext('cmd:ou_user1:om_list_2');
    const c3 = await spoolQueue.claimNext('cmd:ou_user1:om_list_3');

    expect(c1?.messageId).toBe('om_list_1');
    expect(c2?.messageId).toBe('om_list_2');
    expect(c3?.messageId).toBe('om_list_3');
  });

  // 反向：相同 serialKey（同 messageId）第二条被阻塞
  it('same serialKey (same messageId) blocks second claim correctly', async () => {
    spoolQueue.enqueue(makeMsg('om_dup', 'cmd:ou_user1:om_dup', '/list'));

    const first = await spoolQueue.claimNext('cmd:ou_user1:om_dup');
    expect(first).not.toBeNull();

    // 没有第二条同 serialKey 的消息 → claimNext 返回 null
    const second = await spoolQueue.claimNext('cmd:ou_user1:om_dup');
    expect(second).toBeNull();
  });

  // 边界：old `new:openId` serialKey 仍正常工作（向后兼容非 command 路径）
  it('new:openId serialKey (non-command path) still works as before', async () => {
    spoolQueue.enqueue(makeMsg('om_chat_1', 'new:ou_user1', 'hello'));

    const claimed = await spoolQueue.claimNext('new:ou_user1');
    expect(claimed).not.toBeNull();
    expect(claimed?.text).toBe('hello');
  });

  // CR2 #4: enqueue 失败时 receipt 必须被 revert，否则后续同 messageId 消息被 hasReceipt 误判
  it('enqueue failure reverts receipt so retry can succeed (CR2 #4)', async () => {
    // 构造一个会触发 ENAMETOOLONG 的 serialKey——直接构造 100 字符字段（绕开 SAFE_ID_REGEX 80 上限，
    // 因为 SpoolQueue 不做格式校验，本测试验证 error path）
    const hugeMsg: SpoolMessage = {
      messageId: 'a'.repeat(100),
      openId: 'ou_user1',
      text: '/list',
      target: { type: 'no_target' as const, openId: 'ou_user1' },
      // filename: cmd: + 100 + : + 100 + : + 100 + .json = 4+100+1+100+1+100+5 = 311 字符 → ENAMETOOLONG
      serialKey: `cmd:${'o'.repeat(100)}:${'a'.repeat(100)}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // enqueue 失败时必须 return false + revert receipt（不残留）
    const result = spoolQueue.enqueue(hugeMsg);
    expect(result).toBe(false);

    // 关键断言：receipt 必须被 revert
    const receiptsDir = join(tmpDir, 'receipts');
    const receiptFile = join(receiptsDir, `${hugeMsg.messageId}.json`);
    expect(existsSync(receiptFile)).toBe(false);

    // 后续合法 enqueue 必须成功（无残留状态污染）
    const okResult = spoolQueue.enqueue(makeMsg('om_retry_001', 'cmd:ou_user1:om_retry_001', '/list'));
    expect(okResult).toBe(true);
  });

  // CR3 #1: enqueue 的 markDone 循环（awaitingForceSend 取代）也必须在 try/catch 内
  // markDone 内 renameSync 抛错（EIO / EACCES）时 receipt 必须被 revert
  // 用 spy 强制 markDone 抛错来模拟（filesystem 错误实际无法可靠触发因为 markDone 内部已 try/catch）
  it('enqueue failure during awaitingForceSend markDone also reverts receipt (CR3 #1)', async () => {
    // 先在 processing 目录放一个 awaitingForceSend 消息
    const awaitingMsg: SpoolMessage = {
      messageId: 'om_awaiting_001',
      openId: 'ou_user1',
      text: 'awaiting prompt',
      target: { type: 'no_target' as const, openId: 'ou_user1' },
      serialKey: 'cmd:ou_user1:om_awaiting_001',
      status: 'processing',
      awaitingForceSend: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const processingDir = join(tmpDir, 'processing');
    const { mkdirSync, writeFileSync } = await import('fs');
    mkdirSync(processingDir, { recursive: true });
    writeFileSync(
      join(processingDir, 'cmd:ou_user1:om_awaiting_001:om_awaiting_001.json'),
      JSON.stringify(awaitingMsg),
    );

    // 用 spy 替换 markDone 强制抛错（模拟未来重构可能引入的 throw）
    const originalMarkDone = spoolQueue.markDone.bind(spoolQueue);
    (spoolQueue as any).markDone = () => {
      throw new Error('simulated markDone failure');
    };

    try {
      const newMsg: SpoolMessage = {
        messageId: 'om_new_001',
        openId: 'ou_user1',
        text: '/list',
        target: { type: 'no_target' as const, openId: 'ou_user1' },
        serialKey: 'cmd:ou_user1:om_awaiting_001',  // 同 serialKey 触发 markDone
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // enqueue 应该捕获 markDone 抛错并 revert receipt
      const result = spoolQueue.enqueue(newMsg);
      expect(result).toBe(false);

      // 关键断言：receipt 已经被 revert
      const receiptsDir = join(tmpDir, 'receipts');
      const receiptFile = join(receiptsDir, `${newMsg.messageId}.json`);
      expect(existsSync(receiptFile)).toBe(false);
    } finally {
      // 恢复原 markDone（避免污染后续测试 / afterEach cleanup）
      (spoolQueue as any).markDone = originalMarkDone;
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { createTestBot, type TestBot } from '../../helpers/feishu-bot';
import { SERVICE_UNAVAILABLE_REPLY } from '../../../src/feishu/replies';

describe('FeishuBot serialKey and messageId validation', () => {
  let env: TestBot;

  beforeEach(() => {
    env = createTestBot({
      tmpDirPrefix: 'bot-serialkey-test-',
      extraConfigMutations: { 'queue.max_pending': 5 },
    });
  });

  afterEach(() => {
    env.cleanup();
  });

  // ====== messageId 校验 ======

  it('rejects message with invalid messageId (contains colon)', async () => {
    await env.bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om:bad:id',  // 包含 : 字符
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(env.textReplies.length).toBe(1);
    expect(env.textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
    // 拒绝入队：pending 目录应该是空的
    const pendingDir = join(env.tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('rejects message with invalid messageId (contains slash)', async () => {
    await env.bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om/bad/id',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(env.textReplies.length).toBe(1);
    expect(env.textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
    const pendingDir = join(env.tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('rejects message with invalid messageId regardless of content type (non-command)', async () => {
    // boundary case：messageId 校验在 isCommand 之前就生效
    await env.bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om:bad',  // 包含 : 字符
      content: JSON.stringify({ text: 'hello' }),  // 非 command
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(env.textReplies.length).toBe(1);
    expect(env.textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
    const pendingDir = join(env.tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('rejects message with invalid openId (contains colon)', async () => {
    // CR #3: openId 也参与 serialKey 拼接，必须同 messageId 一样校验
    await env.bot.onMessage({
      open_id: 'ou_user1:bad',  // 包含 : 字符
      message_id: 'om_valid_001',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(env.textReplies.length).toBe(1);
    expect(env.textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
    const pendingDir = join(env.tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('rejects message with messageId longer than 80 chars', async () => {
    // CR #4: 长度上限对齐 src/utils/safe-id.ts {1,80}，80 是 cmd: serialKey 组合边界
    // (cmd: + 80 + : + 80 + : + 80 + .json = 251 ≤ NAME_MAX 255)
    await env.bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'a'.repeat(81),
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(env.textReplies.length).toBe(1);
    expect(env.textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
    const pendingDir = join(env.tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('rejects message with openId longer than 80 chars', async () => {
    // CR #4: openId 同样有长度上限
    await env.bot.onMessage({
      open_id: 'o'.repeat(81),
      message_id: 'om_valid_001',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(env.textReplies.length).toBe(1);
    expect(env.textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
    const pendingDir = join(env.tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('accepts valid alphanumeric+underscore+hyphen messageId', async () => {
    await env.bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_valid_123-abc',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    // happy path 必须真入队：只断 textReplies.length===0 的话 enqueue 静默失败也 pass
    expect(env.textReplies.length).toBe(0);
    const pendingDir = join(env.tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const matchFile = pendingFiles.find(f => f.includes('om_valid_123-abc'));
    expect(matchFile).toMatch(/^cmd:ou_user1:om_valid_123-abc:om_valid_123-abc\.json$/);
  });

  // ====== cmd: serialKey 行为 ======

  it('command message uses cmd:openId:msgId serialKey', async () => {
    // 触发 onMessage 后，让 worker claim 一条消息检查 serialKey
    await env.bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_msg_001',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    // 检查 spool pending 目录中的文件名
    const pendingDir = join(env.tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const matchFile = pendingFiles.find(f => f.includes('om_msg_001'));
    expect(matchFile).toBeDefined();
    // 文件名格式: cmd:openId:msgId:msgId.json
    expect(matchFile).toMatch(/^cmd:ou_user1:om_msg_001:om_msg_001\.json$/);
  });

  it('non-command session message uses sessionUuid as serialKey', async () => {
    // 先设置 user mapping 指向一个 session
    // 注意：compareAndSwap 内部会调 validateOwner，依赖 feishu_bot.owner_open_id = ''
    // （已在 beforeEach 设置为 ''）
    await env.userManager.compareAndSwap('ou_user1', null, {
      type: 'session',
      sessionUuid: 'sess-abc-123',
      cwd: '/tmp/proj',
      createdAt: new Date().toISOString(),
    });

    await env.bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_msg_002',
      content: JSON.stringify({ text: '继续工作' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const pendingDir = join(env.tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const matchFile = pendingFiles.find(f => f.includes('om_msg_002'));
    expect(matchFile).toBeDefined();
    expect(matchFile).toMatch(/^sess-abc-123:om_msg_002\.json$/);
  });

  it('non-command no-target message uses new:openId serialKey', async () => {
    await env.bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_msg_003',
      content: JSON.stringify({ text: 'hello' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const pendingDir = join(env.tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const matchFile = pendingFiles.find(f => f.includes('om_msg_003'));
    expect(matchFile).toBeDefined();
    expect(matchFile).toMatch(/^new:ou_user1:om_msg_003\.json$/);
  });

  it('/listdir command also uses cmd: serialKey (not /list whitelist only)', async () => {
    await env.bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_msg_listdir',
      content: JSON.stringify({ text: '/listdir' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const pendingDir = join(env.tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const matchFile = pendingFiles.find(f => f.includes('om_msg_listdir'));
    expect(matchFile).toBeDefined();
    // /listdir 也走 cmd: 路径（按 isCommand 标志，不按白名单）
    expect(matchFile).toMatch(/^cmd:ou_user1:om_msg_listdir:om_msg_listdir\.json$/);
  });

  it('two different messageId commands have independent serialKeys', async () => {
    await env.bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_cmd_a',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await env.bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_cmd_b',
      content: JSON.stringify({ text: '/status' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const pendingDir = join(env.tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const fileA = pendingFiles.find(f => f.includes('om_cmd_a'));
    const fileB = pendingFiles.find(f => f.includes('om_cmd_b'));

    expect(fileA).toBeDefined();
    expect(fileB).toBeDefined();
    // 两个 serialKey 完全不同
    expect(fileA).not.toBe(fileB);
    expect(fileA).toMatch(/^cmd:ou_user1:om_cmd_a:/);
    expect(fileB).toMatch(/^cmd:ou_user1:om_cmd_b:/);
  });

  // ====== handleCardAction SAFE_ID_REGEX 校验（CR2 #2）======

  it('handleCardAction rejects card with invalid openId (no recordReceipt, returns null)', async () => {
    const result = await env.bot.handleCardAction({
      open_id: 'ou_user1:bad',  // 含 : 字符
      action: { tag: 'button', value: { tag: 'list' } },
      message: { message_id: 'om_valid_card' },
    });

    // 拒绝：返回 null，receipts 目录不应该写
    expect(result).toBeNull();
    const receiptsDir = join(env.tmpDir, 'receipts');
    const receiptsFiles = existsSync(receiptsDir) ? readdirSync(receiptsDir) : [];
    expect(receiptsFiles).toHaveLength(0);
  });

  it('handleCardAction rejects card with invalid messageId (no recordReceipt, returns null)', async () => {
    const result = await env.bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'button', value: { tag: 'list' } },
      message: { message_id: 'om:bad:id' },  // 含 : 字符
    });

    expect(result).toBeNull();
    const receiptsDir = join(env.tmpDir, 'receipts');
    const receiptsFiles = existsSync(receiptsDir) ? readdirSync(receiptsDir) : [];
    expect(receiptsFiles).toHaveLength(0);
  });

  it('handleCardAction rejects card with messageId longer than 80 chars', async () => {
    const result = await env.bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'button', value: { tag: 'list' } },
      message: { message_id: 'a'.repeat(81) },
    });

    expect(result).toBeNull();
    const receiptsDir = join(env.tmpDir, 'receipts');
    const receiptsFiles = existsSync(receiptsDir) ? readdirSync(receiptsDir) : [];
    expect(receiptsFiles).toHaveLength(0);
  });
});

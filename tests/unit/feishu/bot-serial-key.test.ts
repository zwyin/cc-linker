import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FeishuBot } from '../../../src/feishu/bot';
import { UserManager } from '../../../src/feishu/mapping';
import { ListSnapshotManager } from '../../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../../src/queue/spool';
import { RegistryManager } from '../../../src/registry/registry';
import { ClaudeSessionManager } from '../../../src/proxy/session';
import { config } from '../../../src/utils/config';
import { SERVICE_UNAVAILABLE_REPLY } from '../../../src/feishu/replies';

// 复用 bot.test.ts:42-48 的 setup 模式：(config as any).data.* 直接 mutation
// 不要用 config.load() —— 该方法不存在
describe('FeishuBot serialKey and messageId validation', () => {
  let tmpDir: string;
  let userManager: UserManager;
  let listSnapshotManager: ListSnapshotManager;
  let spoolQueue: SpoolQueue;
  let registry: RegistryManager;
  let sessionManager: ClaudeSessionManager;
  let textReplies: Array<{ text: string; openId?: string; messageId?: string }>;
  let cardReplies: Array<{ card: any; openId?: string; messageId?: string }>;
  let bot: FeishuBot;
  let originalMaxPending: number;
  let originalOwnerOpenId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bot-serialkey-test-'));

    // 仅 mutate 本测试需要的 config 字段并保存原值，afterEach 完整还原
    // （之前 cargo-cult 5 个 mutation 实际无人用，state 还会 leak 到下个测试）
    originalMaxPending = (config as any).data.queue.max_pending;
    originalOwnerOpenId = (config as any).data.feishu_bot.owner_open_id;
    (config as any).data.feishu_bot.owner_open_id = '';

    userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
    spoolQueue = new SpoolQueue(tmpDir);
    registry = new RegistryManager(tmpDir);
    sessionManager = new ClaudeSessionManager();

    textReplies = [];
    cardReplies = [];

    bot = new FeishuBot({
      userManager,
      listSnapshotManager,
      spoolQueue,
      registry,
      sessionManager,
      replyFn: async (text, opts) => {
        textReplies.push({ text, openId: opts?.openId, messageId: opts?.messageId });
        return 'reply-id-' + textReplies.length;
      },
      cardReplyFn: async (card, opts) => {
        cardReplies.push({ card, openId: opts?.openId, messageId: opts?.messageId });
        return 'card-id-' + cardReplies.length;
      },
    });
  });

  afterEach(() => {
    (config as any).data.queue.max_pending = originalMaxPending;
    (config as any).data.feishu_bot.owner_open_id = originalOwnerOpenId;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ====== messageId 校验 ======

  it('rejects message with invalid messageId (contains colon)', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om:bad:id',  // 包含 : 字符
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
    // 拒绝入队：pending 目录应该是空的
    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('rejects message with invalid messageId (contains slash)', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om/bad/id',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('rejects message with invalid messageId regardless of content type (non-command)', async () => {
    // boundary case：messageId 校验在 isCommand 之前就生效
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om:bad',  // 包含 : 字符
      content: JSON.stringify({ text: 'hello' }),  // 非 command
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('rejects message with invalid openId (contains colon)', async () => {
    // CR #3: openId 也参与 serialKey 拼接，必须同 messageId 一样校验
    await bot.onMessage({
      open_id: 'ou_user1:bad',  // 包含 : 字符
      message_id: 'om_valid_001',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('rejects message with messageId longer than 80 chars', async () => {
    // CR #4: 长度上限对齐 src/utils/safe-id.ts {1,80}，80 是 cmd: serialKey 组合边界
    // (cmd: + 80 + : + 80 + : + 80 + .json = 251 ≤ NAME_MAX 255)
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'a'.repeat(81),
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('rejects message with openId longer than 80 chars', async () => {
    // CR #4: openId 同样有长度上限
    await bot.onMessage({
      open_id: 'o'.repeat(81),
      message_id: 'om_valid_001',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    expect(pendingFiles).toHaveLength(0);
  });

  it('accepts valid alphanumeric+underscore+hyphen messageId', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_valid_123-abc',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    // happy path 必须真入队：只断 textReplies.length===0 的话 enqueue 静默失败也 pass
    expect(textReplies.length).toBe(0);
    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const matchFile = pendingFiles.find(f => f.includes('om_valid_123-abc'));
    expect(matchFile).toMatch(/^cmd:ou_user1:om_valid_123-abc:om_valid_123-abc\.json$/);
  });

  // CR2 #5: oracle 归一化——invalid messageId/openId 错误消息不再透露"格式"信息
  it('rejection messages are generic (no whitelist leak) for messageId format error', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om:bad:id',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(textReplies.length).toBe(1);
    // 通用消息，不透露白名单 / 长度上限 / 字符集
    expect(textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
  });

  it('rejection messages are generic (no whitelist leak) for openId format error', async () => {
    await bot.onMessage({
      open_id: 'ou_user1:bad',
      message_id: 'om_valid_001',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0].text).toBe(SERVICE_UNAVAILABLE_REPLY);
  });

  // ====== cmd: serialKey 行为 ======

  it('command message uses cmd:openId:msgId serialKey', async () => {
    // 触发 onMessage 后，让 worker claim 一条消息检查 serialKey
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_msg_001',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    // 检查 spool pending 目录中的文件名
    const pendingDir = join(tmpDir, 'pending');
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
    await userManager.compareAndSwap('ou_user1', null, {
      type: 'session',
      sessionUuid: 'sess-abc-123',
      cwd: '/tmp/proj',
      createdAt: new Date().toISOString(),
    });

    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_msg_002',
      content: JSON.stringify({ text: '继续工作' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const matchFile = pendingFiles.find(f => f.includes('om_msg_002'));
    expect(matchFile).toBeDefined();
    expect(matchFile).toMatch(/^sess-abc-123:om_msg_002\.json$/);
  });

  it('non-command no-target message uses new:openId serialKey', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_msg_003',
      content: JSON.stringify({ text: 'hello' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const matchFile = pendingFiles.find(f => f.includes('om_msg_003'));
    expect(matchFile).toBeDefined();
    expect(matchFile).toMatch(/^new:ou_user1:om_msg_003\.json$/);
  });

  it('/listdir command also uses cmd: serialKey (not /list whitelist only)', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_msg_listdir',
      content: JSON.stringify({ text: '/listdir' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const pendingDir = join(tmpDir, 'pending');
    const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir) : [];
    const matchFile = pendingFiles.find(f => f.includes('om_msg_listdir'));
    expect(matchFile).toBeDefined();
    // /listdir 也走 cmd: 路径（按 isCommand 标志，不按白名单）
    expect(matchFile).toMatch(/^cmd:ou_user1:om_msg_listdir:om_msg_listdir\.json$/);
  });

  it('two different messageId commands have independent serialKeys', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_cmd_a',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'om_cmd_b',
      content: JSON.stringify({ text: '/status' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const pendingDir = join(tmpDir, 'pending');
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
    const result = await bot.handleCardAction({
      open_id: 'ou_user1:bad',  // 含 : 字符
      action: { tag: 'button', value: { tag: 'list' } },
      message: { message_id: 'om_valid_card' },
    });

    // 拒绝：返回 null，receipts 目录不应该写
    expect(result).toBeNull();
    const receiptsDir = join(tmpDir, 'receipts');
    const receiptsFiles = existsSync(receiptsDir) ? readdirSync(receiptsDir) : [];
    expect(receiptsFiles).toHaveLength(0);
  });

  it('handleCardAction rejects card with invalid messageId (no recordReceipt, returns null)', async () => {
    const result = await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'button', value: { tag: 'list' } },
      message: { message_id: 'om:bad:id' },  // 含 : 字符
    });

    expect(result).toBeNull();
    const receiptsDir = join(tmpDir, 'receipts');
    const receiptsFiles = existsSync(receiptsDir) ? readdirSync(receiptsDir) : [];
    expect(receiptsFiles).toHaveLength(0);
  });

  it('handleCardAction rejects card with messageId longer than 80 chars', async () => {
    const result = await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'button', value: { tag: 'list' } },
      message: { message_id: 'a'.repeat(81) },
    });

    expect(result).toBeNull();
    const receiptsDir = join(tmpDir, 'receipts');
    const receiptsFiles = existsSync(receiptsDir) ? readdirSync(receiptsDir) : [];
    expect(receiptsFiles).toHaveLength(0);
  });
});

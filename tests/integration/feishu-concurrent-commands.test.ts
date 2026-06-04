import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FeishuBot } from '../../src/feishu/bot';
import { UserManager } from '../../src/feishu/mapping';
import { ListSnapshotManager } from '../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../src/queue/spool';
import { RegistryManager } from '../../src/registry/registry';
import { ClaudeSessionManager } from '../../src/proxy/session';
import { config } from '../../src/utils/config';

/**
 * 集成测试：模拟真实并发场景。
 * 不依赖飞书网络，用 mock 飞书 client。
 */
describe('Feishu concurrent commands integration', () => {
  let tmpDir: string;
  let userManager: UserManager;
  let listSnapshotManager: ListSnapshotManager;
  let spoolQueue: SpoolQueue;
  let registry: RegistryManager;
  let sessionManager: ClaudeSessionManager;
  let bot: FeishuBot;
  let textReplies: any[];
  let cardReplies: any[];
  let originalOwnerOpenId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'integration-test-'));

    // 不要用 config.load() —— 该方法不存在（参考 tests/unit/feishu/bot-serial-key.test.ts:13-14）。
    // 路径通过构造函数显式传入 tmpDir 子路径,config 用全局默认值。
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
        textReplies.push({ text, openId: opts?.openId });
        return 'r' + textReplies.length;
      },
      cardReplyFn: async (card, opts) => {
        cardReplies.push({ card, openId: opts?.openId });
        return 'c' + cardReplies.length;
      },
    });
  });

  afterEach(() => {
    (config as any).data.feishu_bot.owner_open_id = originalOwnerOpenId;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scenario A: /list works independently of /new -- prompt (different serialKeys)', async () => {
    // 准备：注册一个 session，让 /list 有内容
    registry.upsert('existing-session-1', {
      origin: 'cli', cwd: '/tmp/proj', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Existing', message_count: 1, last_message_preview: 'p',
    });

    // 发送 /new -- prompt
    await bot.onMessage({
      open_id: 'ou_user1', message_id: 'om_new_1',
      content: JSON.stringify({ text: '/new -- hello' }),
      chat_type: 'p2p', message_type: 'text',
    });

    // 发送 /list
    await bot.onMessage({
      open_id: 'ou_user1', message_id: 'om_list_1',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p', message_type: 'text',
    });

    // 验证：两条消息都入队，serialKey 不同
    const pending = readdirSync(join(tmpDir, 'pending'));
    const newFile = pending.find(f => f.includes('om_new_1'));
    const listFile = pending.find(f => f.includes('om_list_1'));
    expect(newFile).toMatch(/^cmd:ou_user1:om_new_1:/);
    expect(listFile).toMatch(/^cmd:ou_user1:om_list_1:/);
    expect(newFile).not.toBe(listFile);
  });

  it('scenario E: three /list commands queued independently', async () => {
    for (let i = 1; i <= 3; i++) {
      await bot.onMessage({
        open_id: 'ou_user1', message_id: `om_list_${i}`,
        content: JSON.stringify({ text: '/list' }),
        chat_type: 'p2p', message_type: 'text',
      });
    }

    const pending = readdirSync(join(tmpDir, 'pending'));
    expect(pending.length).toBe(3);
    // 三个不同的 cmd: serialKey
    expect(pending.filter(f => f.startsWith('cmd:ou_user1:om_list_1:')).length).toBe(1);
    expect(pending.filter(f => f.startsWith('cmd:ou_user1:om_list_2:')).length).toBe(1);
    expect(pending.filter(f => f.startsWith('cmd:ou_user1:om_list_3:')).length).toBe(1);
  });
});

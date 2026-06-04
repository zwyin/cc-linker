import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FeishuBot } from '../../../src/feishu/bot';
import { UserManager } from '../../../src/feishu/mapping';
import { ListSnapshotManager } from '../../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../../src/queue/spool';
import { RegistryManager } from '../../../src/registry/registry';
import { ClaudeSessionManager } from '../../../src/proxy/session';
import { config } from '../../../src/utils/config';

describe('FeishuBot doSwitch overview card', () => {
  let tmpDir: string;
  let userManager: UserManager;
  let listSnapshotManager: ListSnapshotManager;
  let spoolQueue: SpoolQueue;
  let registry: RegistryManager;
  let sessionManager: ClaudeSessionManager;
  let textReplies: Array<{ text: string; openId?: string; messageId?: string }>;
  let cardReplies: Array<{ card: any; openId?: string; messageId?: string }>;
  let bot: FeishuBot;
  let originalOwnerOpenId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bot-doswitch-test-'));

    // 不要用 config.load() —— 该方法不存在（参考 tests/unit/feishu/bot-serial-key.test.ts:13-14）。
    // 路径通过构造函数显式传入 tmpDir 子路径,config 用全局默认值。
    // 清空 owner_open_id 让 validateOwner 对测试用的 ou_user1 也通过
    // （避免真实 config.toml 里的 owner_open_id 干扰）
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
    (config as any).data.feishu_bot.owner_open_id = originalOwnerOpenId;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('doSwitch sends overview card when session is found and swapped', async () => {
    // 准备 session
    registry.upsert('test-uuid-1234', {
      origin: 'cli',
      cwd: '/tmp/project',
      project_name: 'project',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: '2026-01-02T00:00:00Z',
      title: 'Test Session',
      message_count: 5,
      last_message_preview: 'old preview',
      last_user_preview: 'How do I parse JSON?',
      last_assistant_preview: 'Use JSON.parse()',
    });

    // 通过 card action 路径触发 doSwitch
    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'switch', value: 'test-uuid-1234' },
      message: { message_id: 'msg-test-1' },
    });

    // 验证：发了 1 张卡片
    expect(cardReplies.length).toBe(1);
    expect(textReplies.length).toBe(0);

    // 卡片 header 应包含 "已切换会话"
    const card = cardReplies[0].card;
    expect(card.header.title.content).toContain('已切换会话');

    // 卡片 elements 应包含 last_user_preview 和 last_assistant_preview
    const allContent = JSON.stringify(card.elements);
    expect(allContent).toContain('How do I parse JSON');
    expect(allContent).toContain('Use JSON.parse');
  });

  it('doSwitch sends error text when session is not found', async () => {
    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'switch', value: 'nonexistent-uuid' },
      message: { message_id: 'msg-test-2' },
    });

    // 验证：发 text 消息（不卡片）
    expect(textReplies.length).toBe(1);
    expect(cardReplies.length).toBe(0);
    expect(textReplies[0].text).toContain('未找到');
  });

  it('overview card includes running indicator when target session is active', async () => {
    registry.upsert('active-uuid-5678', {
      origin: 'feishu',
      cwd: '/tmp/active',
      project_name: 'active',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: new Date().toISOString(),
      title: 'Active Session',
      message_count: 10,
      last_message_preview: 'current',
    });

    // 模拟 listSessions 返回这个 session（在跑）
    const originalListSessions = sessionManager.listSessions.bind(sessionManager);
    (sessionManager as any).listSessions = () => [
      { sessionId: 'active-uuid-5678', pid: 12345, cwd: '/tmp/active', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    try {
      await bot.handleCardAction({
        open_id: 'ou_user1',
        action: { tag: 'switch', value: 'active-uuid-5678' },
        message: { message_id: 'msg-test-3' },
      });
    } finally {
      (sessionManager as any).listSessions = originalListSessions;
    }

    expect(cardReplies.length).toBe(1);
    const allContent = JSON.stringify(cardReplies[0].card.elements);
    expect(allContent).toContain('🔴');  // running mark
    expect(allContent).toContain('处理中');
  });

  it('overview card text fallback includes key info when cardReplyFn returns null', async () => {
    registry.upsert('test-uuid-fallback', {
      origin: 'cli',
      cwd: '/tmp/fb',
      project_name: 'fb',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: '2026-01-02T00:00:00Z',
      title: 'Fallback Test',
      message_count: 3,
      last_message_preview: 'old',
      last_user_preview: 'fallback user prompt',
      last_assistant_preview: 'fallback assistant reply',
    });

    // 临时让 cardReplyFn 返回 null
    const originalCardFn = bot['cardReplyFn'];
    (bot as any).cardReplyFn = async () => null;

    try {
      await bot.handleCardAction({
        open_id: 'ou_user1',
        action: { tag: 'switch', value: 'test-uuid-fallback' },
        message: { message_id: 'msg-test-4' },
      });
    } finally {
      (bot as any).cardReplyFn = originalCardFn;
    }

    // 验证：发 text 消息（卡片失败降级）
    expect(textReplies.length).toBe(1);
    expect(textReplies[0].text).toContain('已切换到');
    expect(textReplies[0].text).toContain('fallback user prompt');
    expect(textReplies[0].text).toContain('fallback assistant reply');
  });

  it('overview card escapes < and > in previews', async () => {
    registry.upsert('escape-uuid-1234', {
      origin: 'cli',
      cwd: '/tmp/escape',
      project_name: 'esc',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: '2026-01-02T00:00:00Z',
      title: 'Escape Test',
      message_count: 1,
      last_message_preview: 'old',
      last_user_preview: 'What does <script> do?',
      last_assistant_preview: '> It runs JavaScript <code>',
    });

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'switch', value: 'escape-uuid-1234' },
      message: { message_id: 'msg-test-5' },
    });

    expect(cardReplies.length).toBe(1);
    const allContent = JSON.stringify(cardReplies[0].card.elements);
    // < > 必须被转义（防止 markdown 注入）
    expect(allContent).toContain('&lt;script&gt;');
    expect(allContent).toContain('&lt;code&gt;');
    // 原字符不应直接出现
    expect(allContent).not.toContain('<script>');
  });

  // ===== 【review 必加】补充测试覆盖盲区 =====

  it('doSwitch sends failure text when CAS swap fails (swapped=false)', async () => {
    // 准备 session
    registry.upsert('swapfail-uuid-1234', {
      origin: 'cli',
      cwd: '/tmp/swapfail',
      project_name: 'sf',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: '2026-01-02T00:00:00Z',
      title: 'Swap Fail Session',
      message_count: 1,
      last_message_preview: 'preview',
      last_user_preview: 'should not appear',
      last_assistant_preview: 'should not appear',
    });

    // 强制 userManager.compareAndSwap 返回 false（模拟并发冲突）
    const originalCompareAndSwap = userManager.compareAndSwap.bind(userManager);
    (userManager as any).compareAndSwap = async () => false;

    try {
      await bot.handleCardAction({
        open_id: 'ou_user1',
        action: { tag: 'switch', value: 'swapfail-uuid-1234' },
        message: { message_id: 'msg-test-swapfail' },
      });
    } finally {
      (userManager as any).compareAndSwap = originalCompareAndSwap;
    }

    // 验证：发"切换失败"消息（绝不卡片，避免误导用户以为切换成功）
    expect(textReplies.length).toBe(1);
    expect(cardReplies.length).toBe(0);
    expect(textReplies[0].text).toBe('⚠️ 切换失败，会话可能已被修改');
  });
});

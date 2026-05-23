import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { FeishuBot, FeishuReplyFn } from '../../../src/feishu/bot';
import { UserManager } from '../../../src/feishu/mapping';
import { ListSnapshotManager } from '../../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../../src/queue/spool';
import { ClaudeSessionManager } from '../../../src/proxy/session';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RegistryManager } from '../../../src/registry';
import { config } from '../../../src/utils/config';

describe('FeishuBot', () => {
  let tmpDir: string;
  let bot: FeishuBot;
  let replies: string[];
  let registry: RegistryManager;
  let originalMaxPending: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bot-test-'));
    mkdirSync('/tmp/project', { recursive: true });

    replies = [];
    originalMaxPending = (config as any).data.queue.max_pending;
    (config as any).data.feishu_bot.owner_open_id = '';
    (config as any).data.feishu_bot.default_cwd = '';
    (config as any).data.security.allowed_roots = [];
    (config as any).data.security.denied_roots = [];
    (config as any).data.stream.enabled = false;
    const replyFn: FeishuReplyFn = async (text: string): Promise<string | null> => {
      replies.push(text);
      return `reply-${replies.length}`;
    };

    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
    const spoolQueue = new SpoolQueue(tmpDir);
    const sessionManager = new ClaudeSessionManager();
    registry = new RegistryManager(tmpDir);

    bot = new FeishuBot({
      userManager,
      listSnapshotManager,
      spoolQueue,
      registry,
      sessionManager,
      replyFn,
    });
  });

  afterEach(() => {
    (config as any).data.queue.max_pending = originalMaxPending;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ignores group messages', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-1',
      content: JSON.stringify({ text: 'hello' }),
      chat_type: 'group',
      message_type: 'text',
    });

    expect(replies).toHaveLength(0);
  });

  it('processes /help command', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-1',
      content: JSON.stringify({ text: '/help' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    // Dispatch to process
    await bot.dispatch();

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies.some(r => r.includes('help'))).toBe(true);
  });

  it('processes /status command', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-1',
      content: JSON.stringify({ text: '/status' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await bot.dispatch();

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies.some(r => r.includes('状态'))).toBe(true);
  });

  it('processes /list command', async () => {
    registry.upsert('session-1', {
      origin: 'cli',
      cwd: '/tmp/project',
      project_name: 'project',
      title: 'Session 1',
      message_count: 3,
      last_active: new Date().toISOString(),
      created_at: new Date().toISOString(),
      last_message_preview: 'hello',
      jsonl_path: null,
    });
    await registry.flush();

    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-1',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await bot.dispatch();

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies.some(r => r.includes('我的会话'))).toBe(true);
  });

  it('rejects unknown commands', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-1',
      content: JSON.stringify({ text: '/unknown' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await bot.dispatch();

    expect(replies.some(r => r.includes('未知命令'))).toBe(true);
  });

  it('deduplicates messages by messageId', async () => {
    const event = {
      open_id: 'ou_user1',
      message_id: 'msg-dup',
      content: JSON.stringify({ text: '/status' }),
      chat_type: 'p2p',
      message_type: 'text',
    };

    await bot.onMessage(event);
    await bot.onMessage(event); // duplicate

    await bot.dispatch();

    // Should only process once
    expect(replies.length).toBe(1);
  });

  it('does not claim pending_new_session during onMessage before dispatch', async () => {
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    await userManager.compareAndSwap('ou_user1', null, {
      type: 'pending_new_session',
      sessionUuid: null,
      createdAt: new Date().toISOString(),
      cwd: '/tmp/project',
    });

    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-new',
      content: JSON.stringify({ text: '请帮我创建会话' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const entry = userManager.getEntry('ou_user1');
    expect(entry?.type).toBe('pending_new_session');
  });

  it('keeps mapping pending when queue rejects the message', async () => {
    const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    await userManager.compareAndSwap('ou_user1', null, {
      type: 'pending_new_session',
      sessionUuid: null,
      createdAt: new Date().toISOString(),
      cwd: '/tmp/project',
    });

    (config as any).data.queue.max_pending = 0;

    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-full',
      content: JSON.stringify({ text: '队列满了也不要 claim' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    const entry = userManager.getEntry('ou_user1');
    expect(entry?.type).toBe('pending_new_session');
  });

  it('retries when reply delivery fails instead of marking message done', async () => {
    let attempts = 0;
    const retryReplies: string[] = [];
    const replyFn: FeishuReplyFn = async (text: string): Promise<string | null> => {
      attempts++;
      retryReplies.push(text);
      return attempts === 1 ? null : `reply-${attempts}`;
    };

    const userManager = new UserManager(join(tmpDir, 'retry-user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'retry-list-snapshot.json'));
    const spoolQueue = new SpoolQueue(join(tmpDir, 'retry-spool'));
    const sessionManager = new ClaudeSessionManager();
    const retryRegistry = new RegistryManager(join(tmpDir, 'retry-registry'));
    const retryBot = new FeishuBot({
      userManager,
      listSnapshotManager,
      spoolQueue,
      registry: retryRegistry,
      sessionManager,
      replyFn,
    });

    await retryBot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-retry',
      content: JSON.stringify({ text: '/status' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await retryBot.dispatch();
    expect(spoolQueue.queueSize()).toBe(1);
    expect(spoolQueue.listPending()).toHaveLength(1);

    await new Promise(resolve => setTimeout(resolve, 600));
    await retryBot.dispatch();

    expect(attempts).toBe(2);
    expect(retryReplies.filter(r => r.includes('状态')).length).toBe(2);
    expect(spoolQueue.queueSize()).toBe(0);
  });

  it('resumes multi-chunk reply from the failed chunk', async () => {
    const chunkCalls: number[] = [];
    let callCount = 0;
    const replyFn: FeishuReplyFn = async (_text: string, options): Promise<string | null> => {
      chunkCalls.push(options?.chunkIndex ?? -1);
      callCount++;
      if (callCount === 2) {
        return null;
      }
      return `reply-${callCount}`;
    };

    const userManager = new UserManager(join(tmpDir, 'chunk-user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'chunk-list-snapshot.json'));
    const spoolQueue = new SpoolQueue(join(tmpDir, 'chunk-spool'));
    const chunkRegistry = new RegistryManager(join(tmpDir, 'chunk-registry'));
    const retryBot = new FeishuBot({
      userManager,
      listSnapshotManager,
      spoolQueue,
      registry: chunkRegistry,
      sessionManager: new ClaudeSessionManager(),
      replyFn,
    });

    // Must exceed 3900 bytes (MAX_CHUNK_BYTES) to trigger multi-chunk splitting
    const longText = 'A'.repeat(5000);
    spoolQueue.enqueue({
      messageId: 'msg-chunk',
      openId: 'ou_user1',
      text: '/status',
      target: { type: 'session', sessionUuid: 'sess-1', openId: 'ou_user1', cwd: '/tmp' },
      serialKey: 'sess-1',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      responseText: longText,
    });

    await retryBot.dispatch();
    const delivery = spoolQueue.getDelivery('msg-chunk');
    expect(delivery?.status).toBe('sending');
    expect(chunkCalls).toEqual([0, 1]);

    await new Promise(resolve => setTimeout(resolve, 600));
    await retryBot.dispatch();

    expect(chunkCalls).toEqual([0, 1, 1]);
    expect(spoolQueue.queueSize()).toBe(0);
  });

  it('keeps mapping bound to the new session when registry flush fails after creation', async () => {
    class FlakyRegistry extends RegistryManager {
      private failed = false;

      override async flush(): Promise<void> {
        if (!this.failed) {
          this.failed = true;
          throw new Error('flush failed');
        }
        return super.flush();
      }
    }

    const userManager = new UserManager(join(tmpDir, 'flaky-user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'flaky-list-snapshot.json'));
    const spoolQueue = new SpoolQueue(join(tmpDir, 'flaky-spool'));
    const flakyRegistry = new FlakyRegistry(join(tmpDir, 'flaky-registry'));
    const sessionManager = {
      sendMessage: async () => ({
        response: 'created',
        costUsd: 0,
        durationMs: 1,
        sessionId: 'session-created',
        jsonlPath: '/tmp/session-created.jsonl',
        sessionStatus: 'active' as const,
      }),
    } as unknown as ClaudeSessionManager;

    const flakyBot = new FeishuBot({
      userManager,
      listSnapshotManager,
      spoolQueue,
      registry: flakyRegistry,
      sessionManager,
      replyFn: async () => 'reply-ok',
    });

    await flakyBot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-create',
      content: JSON.stringify({ text: '/new /tmp/project -- hello' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await flakyBot.dispatch();

    const entry = userManager.getEntry('ou_user1');
    expect(entry?.type).toBe('session');
    expect(entry?.sessionUuid).toBe('session-created');
  });

  it('restores active status and increments message_count after a successful session message', async () => {
    const userManager = new UserManager(join(tmpDir, 'meta-user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'meta-list-snapshot.json'));
    const spoolQueue = new SpoolQueue(join(tmpDir, 'meta-spool'));
    const metaRegistry = new RegistryManager(join(tmpDir, 'meta-registry'));
    const sessionManager = {
      sendMessage: async () => ({
        response: 'ok',
        costUsd: 0,
        durationMs: 1,
        sessionId: 'session-meta',
        jsonlPath: '/tmp/session-meta.jsonl',
        sessionStatus: 'active' as const,
        error: undefined,
      }),
    } as unknown as ClaudeSessionManager;

    metaRegistry.upsert('session-meta', {
      origin: 'feishu',
      cwd: '/tmp/project',
      project_name: 'project',
      title: 'Session Meta',
      message_count: 2,
      last_active: new Date().toISOString(),
      created_at: new Date().toISOString(),
      last_message_preview: 'prev',
      jsonl_path: null,
      status: 'degraded',
      last_error: 'old',
      pending_jsonl_resolve: true,
    });
    await metaRegistry.flush();

    await userManager.compareAndSwap('ou_user1', null, {
      type: 'session',
      sessionUuid: 'session-meta',
      createdAt: new Date().toISOString(),
      cwd: '/tmp/project',
    });

    const metaBot = new FeishuBot({
      userManager,
      listSnapshotManager,
      spoolQueue,
      registry: metaRegistry,
      sessionManager,
      replyFn: async () => 'reply-meta',
    });

    await metaBot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-meta',
      content: JSON.stringify({ text: 'hello meta' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await metaBot.dispatch();

    const entry = metaRegistry.get('session-meta');
    expect(entry?.status).toBe('active');
    expect(entry?.message_count).toBe(3);
    expect(entry?.last_error).toBeNull();
    expect(entry?.pending_jsonl_resolve).toBe(false);
  });

  it('processes /model command (no providers)', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-model',
      content: JSON.stringify({ text: '/model' }),
      chat_type: 'p2p',
      message_type: 'text',
    });
    await bot.dispatch();

    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies.some(r => r.includes('模型') || r.includes('provider') || r.includes('默认'))).toBe(true);
  });

  it('rejects unknown model alias', async () => {
    await bot.onMessage({
      open_id: 'ou_user1',
      message_id: 'msg-model-unknown',
      content: JSON.stringify({ text: '/model nonexistent' }),
      chat_type: 'p2p',
      message_type: 'text',
    });
    await bot.dispatch();

    expect(replies.some(r => r.includes('未知模型'))).toBe(true);
  });
});

describe('FeishuBot cards', () => {
  let tmpDir: string;
  let cardReplies: Record<string, unknown>[];
  let textReplies: string[];
  let bot: FeishuBot;
  let registry: RegistryManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bot-card-test-'));
    mkdirSync('/tmp/project', { recursive: true });

    cardReplies = [];
    textReplies = [];
    (config as any).data.feishu_bot.owner_open_id = '';
    (config as any).data.security.allowed_roots = [];
    (config as any).data.security.denied_roots = [];
    (config as any).data.stream.enabled = false;

    const replyFn: FeishuReplyFn = async (text: string): Promise<string | null> => {
      textReplies.push(text);
      return `reply-${textReplies.length}`;
    };

    const cardReplyFn = async (card: Record<string, unknown>): Promise<string | null> => {
      cardReplies.push(card);
      return `card-${cardReplies.length}`;
    };

    const userManager = new UserManager(join(tmpDir, 'card-user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'card-list-snapshot.json'));
    const spoolQueue = new SpoolQueue(tmpDir);
    const sessionManager = new ClaudeSessionManager();
    registry = new RegistryManager(tmpDir);

    bot = new FeishuBot({
      userManager,
      listSnapshotManager,
      spoolQueue,
      registry,
      sessionManager,
      replyFn,
      cardReplyFn,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handleCardAction routes help action', async () => {
    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'help', value: '' },
      message: { message_id: 'msg-card-1' },
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0]).toContain('可用命令');
  });

  it('handleCardAction routes unknown action', async () => {
    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'unknown_action', value: '' },
      message: { message_id: 'msg-card-2' },
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0]).toContain('未知操作');
  });

  it('handleCardAction routes switch with UUID', async () => {
    registry.upsert('test-session-uuid', {
      origin: 'cli',
      cwd: '/tmp/project',
      project_name: 'project',
      title: 'Test Session',
      message_count: 5,
      last_active: new Date().toISOString(),
    });

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'switch', value: 'test-session-uuid' },
      message: { message_id: 'msg-card-3' },
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0]).toContain('已切换到会话');
  });

  it('handleCardAction routes switch with nonexistent session', async () => {
    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'switch', value: 'nonexistent-uuid' },
      message: { message_id: 'msg-card-4' },
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0]).toContain('未找到');
  });

  it('handleCardAction routes resume with UUID', async () => {
    registry.upsert('resume-session-uuid', {
      origin: 'cli',
      cwd: '/tmp/project',
      project_name: 'project',
      title: 'Resume Session',
      message_count: 3,
      last_active: new Date().toISOString(),
    });

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'resume', value: 'resume-session-uuid' },
      message: { message_id: 'msg-card-5' },
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0]).toContain('cc-linker resume');
  });

  it('handleCardAction routes resume with corrupted session', async () => {
    registry.upsert('corrupt-session-uuid', {
      origin: 'cli',
      cwd: '/tmp/project',
      project_name: 'project',
      title: 'Corrupt Session',
      message_count: 1,
      last_active: new Date().toISOString(),
      status: 'corrupted',
    });

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'resume', value: 'corrupt-session-uuid' },
      message: { message_id: 'msg-card-6' },
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0]).toContain('已损坏');
  });

  it('handleCardAction routes status', async () => {
    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'status', value: '' },
      message: { message_id: 'msg-card-7' },
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0]).toContain('cc-linker 状态');
    expect(textReplies[0]).toContain('队列消息');
  });

  it('handleCardAction routes list (sends card)', async () => {
    registry.upsert('list-session-1', {
      origin: 'cli',
      cwd: '/tmp/project',
      project_name: 'project',
      title: 'List Session 1',
      message_count: 10,
      last_active: new Date().toISOString(),
    });
    registry.upsert('list-session-2', {
      origin: 'feishu',
      cwd: '/tmp/project',
      project_name: 'project',
      title: 'List Session 2',
      message_count: 5,
      last_active: new Date(Date.now() - 60000).toISOString(),
    });

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'list', value: '' },
      message: { message_id: 'msg-card-8' },
    });

    expect(cardReplies.length).toBe(1);
    const card = cardReplies[0] as Record<string, unknown>;
    expect(card.config).toEqual({ wide_screen_mode: true });
    expect(card.header).toBeDefined();
    expect((card.elements as unknown[])?.length).toBeGreaterThan(0);
  });

  it('handleCardAction routes new', async () => {
    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'new', value: '' },
      message: { message_id: 'msg-card-9' },
    });

    expect(textReplies.length).toBe(1);
    expect(textReplies[0]).toContain('已设置新会话目录');
  });

  it('handleCardAction routes list (sends card)', async () => {
    registry.upsert('card-list-1', {
      origin: 'cli',
      cwd: '/tmp/project',
      project_name: 'project',
      title: 'Card List Session',
      message_count: 5,
      last_active: new Date().toISOString(),
    });

    await bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'list', value: '' },
      message: { message_id: 'msg-card-list' },
    });

    expect(cardReplies.length).toBe(1);
    const card = cardReplies[0] as Record<string, unknown>;
    expect(card.config).toEqual({ wide_screen_mode: true });
    expect(card.header).toBeDefined();
  });
});

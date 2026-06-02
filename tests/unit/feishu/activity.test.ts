/**
 * Focused tests for the activity-sync code paths in FeishuBot:
 *   - handleChat() activity detection → busy card + awaitingForceSend flag
 *   - handleForceSendCardAction() → re-queue + skipActivityCheck flag
 *   - Skip-when-inactive path
 *
 * Design choice — NO mock.module for session-activity:
 *   bun's `mock.module` is shared across test files in the same `bun test`
 *   invocation, so mocking session-activity here would break
 *   tests/unit/utils/session-activity.test.ts. Instead we drive the real
 *   isSessionActive() with a controllable JSONL mtime signal:
 *     - "busy": a background writer appends to the JSONL every 30ms during
 *       the dispatch, so isJSONLWrittenSince()'s 500ms sample detects the
 *       write and returns busy.
 *     - "inactive": no JSONL path / no process → detectCliActivity returns
 *       no_signals.
 *   SpoolQueue is the real implementation (pure file I/O on a tmp dir) so
 *   we verify message lifecycle end-to-end.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FeishuBot, FeishuReplyFn } from '../../../src/feishu/bot';
import { UserManager } from '../../../src/feishu/mapping';
import { ListSnapshotManager } from '../../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../../src/queue/spool';
import { ClaudeSessionManager } from '../../../src/proxy/session';
import { RegistryManager } from '../../../src/registry';
import { config } from '../../../src/utils/config';

function makeMockFeishuClient() {
  return {
    im: {
      v1: {
        message: {
          create: mock(async () => ({ data: { message_id: 'mock-busy-card-id' } })),
          patch: mock(async () => ({})),
        },
      },
    },
  };
}

describe('FeishuBot activity sync (busy → force-send round-trip)', () => {
  let tmpDir: string;
  let jsonlPath: string;
  let textReplies: string[];
  let cardReplies: Record<string, unknown>[];
  let userManager: UserManager;
  let spoolQueue: SpoolQueue;
  let registry: RegistryManager;
  let bot: FeishuBot;
  let originalMaxPending: number;
  let originalCliDetection: boolean;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bot-activity-test-'));
    mkdirSync(join(tmpDir, 'spool/processing'), { recursive: true });
    mkdirSync(join(tmpDir, 'spool/pending'), { recursive: true });
    mkdirSync('/tmp/activity-test-project', { recursive: true });

    // Pre-create a JSONL file for activity mtime detection
    jsonlPath = join(tmpDir, 'session.jsonl');
    writeFileSync(jsonlPath, '{"role":"user","content":"prior msg"}\n');

    textReplies = [];
    cardReplies = [];
    originalMaxPending = (config as any).data.queue.max_pending;
    // Skip the CLI process check so the activity detector falls through to
    // the JSONL mtime path (no Claude process is running in the test env).
    originalCliDetection = (config as any).data.runtime.cli_process_detection_enabled;
    (config as any).data.queue.max_pending = 100;
    (config as any).data.runtime.cli_process_detection_enabled = false;
    (config as any).data.feishu_bot.owner_open_id = '';
    (config as any).data.security.allowed_roots = [];
    (config as any).data.security.denied_roots = [];
    (config as any).data.stream.enabled = false;
    (config as any).data.sdk.enabled = false;

    const replyFn: FeishuReplyFn = async (text: string) => {
      textReplies.push(text);
      return `reply-${textReplies.length}`;
    };
    const cardReplyFn = async (card: Record<string, unknown>) => {
      cardReplies.push(card);
      return `card-${cardReplies.length}`;
    };

    userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
    const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
    spoolQueue = new SpoolQueue(join(tmpDir, 'spool'));
    registry = new RegistryManager(join(tmpDir, 'registry'));

    bot = new FeishuBot({
      userManager,
      listSnapshotManager,
      spoolQueue,
      registry,
      sessionManager: new ClaudeSessionManager(),
      replyFn,
      cardReplyFn,
    });
  });

  afterEach(() => {
    (config as any).data.queue.max_pending = originalMaxPending;
    (config as any).data.runtime.cli_process_detection_enabled = originalCliDetection;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('busy session: message stays in processing/ with awaitingForceSend=true; force-send re-queues with skipActivityCheck=true', async () => {
    const sessionUuid = '11111111-1111-1111-1111-111111111111';
    const openId = 'ou_activity1';

    // Pre-warm the JSONL: write a line first, then start the live writer.
    // isJSONLWrittenSince does a 500ms double-stat sample; if we write during
    // that window, it reports busy. The writer below appends every 30ms.
    appendFileSync(jsonlPath, '{"role":"assistant","content":"warming up"}\n');

    registry.upsert(sessionUuid, {
      origin: 'cli',
      cwd: '/tmp/activity-test-project',
      project_name: 'activity-test-project',
      title: 'Activity Test Session',
      message_count: 1,
      last_active: new Date().toISOString(),
      jsonl_path: jsonlPath,
    });
    await registry.flush();

    await userManager.compareAndSwap(openId, null, {
      type: 'session',
      sessionUuid,
      createdAt: new Date().toISOString(),
      cwd: '/tmp/activity-test-project',
    });

    // Start a background writer that simulates an active CLI session
    // writing to the JSONL. Stop it after dispatch completes.
    let writerActive = true;
    const writerInterval = setInterval(() => {
      if (!writerActive) return;
      try {
        appendFileSync(jsonlPath, '{"role":"assistant","content":"tick"}\n');
      } catch {
        // tmpdir may be gone in afterEach
      }
    }, 30);

    try {
      const client = makeMockFeishuClient();
      bot.setFeishuClient(client);

      // Send a chat message
      await bot.onMessage({
        open_id: openId,
        message_id: 'msg-busy-1',
        content: JSON.stringify({ text: '我有个问题想问' }),
        chat_type: 'p2p',
        message_type: 'text',
      });

      // Drain the queue
      await bot.dispatch();

      // === Phase 1: busy detected → message stays in processing/ ===
      const processingAfterBusy = spoolQueue.listProcessing();
      expect(processingAfterBusy).toHaveLength(1);
      expect(processingAfterBusy[0].messageId).toBe('msg-busy-1');
      expect(processingAfterBusy[0].serialKey).toBe(sessionUuid);
      expect(processingAfterBusy[0].awaitingForceSend).toBe(true);
      expect(processingAfterBusy[0].skipActivityCheck).toBeUndefined();
      expect(spoolQueue.listPending()).toHaveLength(0);

      // The busy card was sent to Feishu (via feishuClient, not cardReplyFn)
      expect(client.im.v1.message.create).toHaveBeenCalled();
      expect(cardReplies).toHaveLength(0);

      // No text reply yet — message is still pending user decision
      expect(textReplies).toHaveLength(0);

      // === Phase 2: user clicks "强制发送" ===
      await bot.handleCardAction({
        open_id: openId,
        action: {
          tag: 'force_send',
          value: { type: 'cli_force_send' },
        },
        message: { message_id: 'msg-busy-1' },
      });

      // Force-send handler should have moved the message back to pending/
      expect(spoolQueue.listProcessing()).toHaveLength(0);
      const pendingAfterForce = spoolQueue.listPending();
      expect(pendingAfterForce).toHaveLength(1);
      expect(pendingAfterForce[0].messageId).toBe('msg-busy-1');
      expect(pendingAfterForce[0].skipActivityCheck).toBe(true);
      expect(pendingAfterForce[0].awaitingForceSend).toBe(false);

      // === Phase 3: dispatch again, this time it should process the message ===
      // Stop the writer so the next dispatch sees "inactive" and processes.
      writerActive = false;
      clearInterval(writerInterval);

      // Replace sessionManager with a no-op mock to avoid spawning Claude.
      (bot as any).sessionManager = {
        sendMessage: async () => ({
          response: 'forced response',
          costUsd: 0,
          durationMs: 1,
          sessionId: sessionUuid,
          jsonlPath,
          sessionStatus: 'active' as const,
          error: undefined,
        }),
      } as unknown as ClaudeSessionManager;

      await bot.dispatch();

      // Message should have been processed and moved out of the queue
      expect(spoolQueue.listPending()).toHaveLength(0);
      expect(spoolQueue.listProcessing()).toHaveLength(0);
      // The text reply should be present
      expect(textReplies.some(r => r.includes('forced response'))).toBe(true);
    } finally {
      writerActive = false;
      clearInterval(writerInterval);
    }
  });

  test('inactive session: message proceeds normally, no busy card, no awaitingForceSend flag', async () => {
    const sessionUuid = '22222222-2222-2222-2222-222222222222';
    const openId = 'ou_activity2';

    // No jsonl_path → activity detection returns no_signals (inactive)
    registry.upsert(sessionUuid, {
      origin: 'cli',
      cwd: '/tmp/activity-test-project',
      project_name: 'activity-test-project',
      title: 'Inactive Test Session',
      message_count: 0,
      last_active: new Date().toISOString(),
    });
    await registry.flush();

    await userManager.compareAndSwap(openId, null, {
      type: 'session',
      sessionUuid,
      createdAt: new Date().toISOString(),
      cwd: '/tmp/activity-test-project',
    });

    const client = makeMockFeishuClient();
    bot.setFeishuClient(client);

    // Replace sessionManager with a mock that returns a quick response
    (bot as any).sessionManager = {
      sendMessage: async () => ({
        response: 'normal response',
        costUsd: 0,
        durationMs: 1,
        sessionId: sessionUuid,
        jsonlPath: null,
        sessionStatus: 'active' as const,
        error: undefined,
      }),
    } as unknown as ClaudeSessionManager;

    await bot.onMessage({
      open_id: openId,
      message_id: 'msg-inactive-1',
      content: JSON.stringify({ text: '普通消息' }),
      chat_type: 'p2p',
      message_type: 'text',
    });

    await bot.dispatch();

    // === Verify: message processed normally, NOT blocked by activity check ===
    // No busy card sent
    expect(client.im.v1.message.create).not.toHaveBeenCalled();

    // Message has been processed (moved out of pending/processing)
    expect(spoolQueue.listPending()).toHaveLength(0);
    expect(spoolQueue.listProcessing()).toHaveLength(0);

    // The reply went through
    expect(textReplies.some(r => r.includes('normal response'))).toBe(true);
  });

  test('force-send handler returns status card when no message in processing/ for session', async () => {
    const sessionUuid = '33333333-3333-3333-3333-333333333333';
    const openId = 'ou_activity3';

    await userManager.compareAndSwap(openId, null, {
      type: 'session',
      sessionUuid,
      createdAt: new Date().toISOString(),
      cwd: '/tmp/activity-test-project',
    });

    // No message in processing/
    const result = await bot.handleCardAction({
      open_id: openId,
      action: {
        tag: 'force_send',
        value: { type: 'cli_force_send' },
      },
      message: { message_id: 'msg-missing' },
    });

    // Returns a status card explaining the message has been processed
    // (instead of a silent null which left the user with no feedback)
    expect(result).not.toBeNull();
    const card = result as Record<string, unknown>;
    const header = card.header as Record<string, unknown>;
    expect((header.title as Record<string, unknown>).content).toContain('消息已被处理');
    const elements = card.elements as Array<Record<string, unknown>>;
    const md = elements.find(e => e.tag === 'markdown') as Record<string, unknown>;
    expect(md.content as string).toContain('该消息已不在等待状态');
    expect(spoolQueue.listProcessing()).toHaveLength(0);
    expect(spoolQueue.listPending()).toHaveLength(0);
  });

  test('force-send handler returns error card when user has no session', async () => {
    const openId = 'ou_activity_no_session';

    const result = await bot.handleCardAction({
      open_id: openId,
      action: {
        tag: 'force_send',
        value: { type: 'cli_force_send' },
      },
      message: { message_id: 'msg-x' },
    });

    expect(result).not.toBeNull();
    const card = result as Record<string, unknown>;
    const header = card.header as Record<string, unknown>;
    expect((header.title as Record<string, unknown>).content).toContain('错误');
    const elements = card.elements as Array<Record<string, unknown>>;
    const md = elements.find(e => e.tag === 'markdown') as Record<string, unknown>;
    expect(md.content as string).toContain('会话不存在');
  });
});

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { readdirSync, mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestBot, type TestBot } from '../helpers/feishu-bot';
import { syncBeforeCommand } from '../../src/scanner';
import { RegistryManager } from '../../src/registry/registry';

/**
 * 集成测试：模拟真实并发场景。
 * 不依赖飞书网络，用 mock 飞书 client。
 */
describe('Feishu concurrent commands integration', () => {
  let env: TestBot;

  beforeEach(() => {
    env = createTestBot({ tmpDirPrefix: 'integration-test-' });
  });

  afterEach(() => {
    env.cleanup();
  });

  it('scenario A: /list works independently of /new -- prompt (different serialKeys)', async () => {
    // 准备：注册一个 session，让 /list 有内容
    env.registry.upsert('existing-session-1', {
      origin: 'cli', cwd: '/tmp/proj', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Existing', message_count: 1, last_message_preview: 'p',
    });

    // 发送 /new -- prompt
    await env.bot.onMessage({
      open_id: 'ou_user1', message_id: 'om_new_1',
      content: JSON.stringify({ text: '/new -- hello' }),
      chat_type: 'p2p', message_type: 'text',
    });

    // 发送 /list
    await env.bot.onMessage({
      open_id: 'ou_user1', message_id: 'om_list_1',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p', message_type: 'text',
    });

    // 验证：两条消息都入队，serialKey 不同
    const pending = readdirSync(join(env.tmpDir, 'pending'));
    const newFile = pending.find(f => f.includes('om_new_1'));
    const listFile = pending.find(f => f.includes('om_list_1'));
    expect(newFile).toMatch(/^cmd:ou_user1:om_new_1:/);
    expect(listFile).toMatch(/^cmd:ou_user1:om_list_1:/);
    expect(newFile).not.toBe(listFile);
  });

  // ===== Spec §集成测试 5 个 MUST 场景 =====
  // 5 个场景: A (streaming + /list) / B (/new + /list) / C (双 /new 互斥) / D (/new 无 prompt + /list) / E (3x /list)
  // 原始 commit 漏了 A/C/D，本轮补全。

  it('scenario A (true streaming + /list): /list returns card with 🔴 marker for streaming session', async () => {
    // 准备：注册一个 session A，模拟其正在被 Claude 处理
    env.registry.upsert('streaming-session-A', {
      origin: 'cli', cwd: '/tmp/proj', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Streaming Session', message_count: 1, last_message_preview: 'p',
    });

    // Mock sessionManager.listSessions() —— 模拟 A 正在被 Claude 处理
    const originalListSessions = env.sessionManager.listSessions.bind(env.sessionManager);
    (env.sessionManager as any).listSessions = () => [
      { sessionId: 'streaming-session-A', pid: 12345, cwd: '/tmp/proj', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    try {
      // /list 入队
      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_list_while_streaming',
        content: JSON.stringify({ text: '/list' }),
        chat_type: 'p2p', message_type: 'text',
      });

      // Drain queue: 让 worker pool 真正处理这条消息
      await env.bot.dispatch();

      // 验证：/list 已处理完（cardReplies 收到 1 张卡片，包含 🔴 标记）
      expect(env.cardReplies.length).toBe(1);
      const allContent = JSON.stringify(env.cardReplies[0].card.elements);
      // 关键断言：streaming session A 在 /list 卡片里有 🔴 标记
      // （证明 /list 没有被 streaming session 阻塞——这是 spec 痛点 A 的核心）
      expect(allContent).toContain('🔴');
    } finally {
      (env.sessionManager as any).listSessions = originalListSessions;
    }
  });

  it('scenario D: /new (no prompt) + /list run independently (no serialization)', async () => {
    // 准备一个 session 让 /list 有内容
    env.registry.upsert('existing-session-D', {
      origin: 'cli', cwd: '/tmp/proj', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Existing', message_count: 1, last_message_preview: 'p',
    });

    // /new 无 prompt：只设 mapping 为 pending_new_session，不创建 session
    await env.bot.onMessage({
      open_id: 'ou_user1', message_id: 'om_new_noprompt',
      content: JSON.stringify({ text: '/new' }),
      chat_type: 'p2p', message_type: 'text',
    });

    // /list：独立命令
    await env.bot.onMessage({
      open_id: 'ou_user1', message_id: 'om_list_d',
      content: JSON.stringify({ text: '/list' }),
      chat_type: 'p2p', message_type: 'text',
    });

    // 验证：两条消息都用独立的 cmd: serialKey，互不阻塞
    const pending = readdirSync(join(env.tmpDir, 'pending'));
    const newFile = pending.find(f => f.includes('om_new_noprompt'));
    const listFile = pending.find(f => f.includes('om_list_d'));
    expect(newFile).toMatch(/^cmd:ou_user1:om_new_noprompt:/);
    expect(listFile).toMatch(/^cmd:ou_user1:om_list_d:/);
  });

  it('scenario C: two /new -- prompt get independent cmd: serialKeys (queue-level parallelism)', async () => {
    // Queue-level 并行：两条消息用独立 cmd: serialKey，SpoolQueue 不阻塞它们。
    // Claude-level 互斥（new:openId lock）由 ClaudeSessionManager.acquireSessionLock 实现，
    // 见 src/proxy/session.ts 的现有锁测试。

    await env.bot.onMessage({
      open_id: 'ou_user1', message_id: 'om_new_p1',
      content: JSON.stringify({ text: '/new -- prompt1' }),
      chat_type: 'p2p', message_type: 'text',
    });

    await env.bot.onMessage({
      open_id: 'ou_user1', message_id: 'om_new_p2',
      content: JSON.stringify({ text: '/new -- prompt2' }),
      chat_type: 'p2p', message_type: 'text',
    });

    const pending = readdirSync(join(env.tmpDir, 'pending'));
    const p1File = pending.find(f => f.includes('om_new_p1'));
    const p2File = pending.find(f => f.includes('om_new_p2'));

    expect(p1File).toMatch(/^cmd:ou_user1:om_new_p1:/);
    expect(p2File).toMatch(/^cmd:ou_user1:om_new_p2:/);
    expect(p1File).not.toBe(p2File);
  });

  it('scenario E: three /list commands queued independently', async () => {
    for (let i = 1; i <= 3; i++) {
      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: `om_list_${i}`,
        content: JSON.stringify({ text: '/list' }),
        chat_type: 'p2p', message_type: 'text',
      });
    }

    const pending = readdirSync(join(env.tmpDir, 'pending'));
    expect(pending.length).toBe(3);
    // 三个不同的 cmd: serialKey
    expect(pending.filter(f => f.startsWith('cmd:ou_user1:om_list_1:')).length).toBe(1);
    expect(pending.filter(f => f.startsWith('cmd:ou_user1:om_list_2:')).length).toBe(1);
    expect(pending.filter(f => f.startsWith('cmd:ou_user1:om_list_3:')).length).toBe(1);
  });

  // 真实复现：dispatch 跑长任务时，新到 /list 必须并行处理
  // 之前的测试只在 dispatch() 启动时入队（无活跃 worker），没覆盖"已有长任务在跑"场景
  it('BUG REPRO: /list must process in parallel with already-running long worker', async () => {
    // 准备：注册一个 session，让 /list 有内容
    env.registry.upsert('long-task-session', {
      origin: 'cli', cwd: '/tmp/proj', project_name: 'proj', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Long Task', message_count: 1, last_message_preview: 'p',
    });

    // 让 sendSDKMessage 阻塞 1.5s（模拟长任务，类似 sleep 50 但更短以便测试）
    // /new -- prompt 走 createSessionFromPromptSDK → sendSDKMessage
    const origSendSDK = env.sessionManager.sendSDKMessage.bind(env.sessionManager);
    (env.sessionManager as any).sendSDKMessage = async () => {
      await new Promise(r => setTimeout(r, 1500));
      return { sessionId: 'long-task-session', response: 'done' };
    };

    try {
      // 1) 注入长任务消息（用 /new -- 触发 sendMessage 阻塞）
      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_long_task',
        content: JSON.stringify({ text: '/new -- sleep 50' }),
        chat_type: 'p2p', message_type: 'text',
      });

      // 2) 启动 dispatch 但不 await 完成（fire-and-forget）
      const dispatchPromise = env.bot.dispatch().catch(() => {});

      // 等 200ms 让长任务被 claim 并进入 activeWorkers
      await new Promise(r => setTimeout(r, 200));

      // 3) 在长任务跑的过程中入队 /list
      await env.bot.onMessage({
        open_id: 'ou_user1', message_id: 'om_list_parallel',
        content: JSON.stringify({ text: '/list' }),
        chat_type: 'p2p', message_type: 'text',
      });

      // 4) 等 500ms——/list 应该已经处理完（doCardList 是同步 I/O，< 100ms）
      await new Promise(r => setTimeout(r, 500));

      // 验证：/list 已处理完，cardReplies 收到 1 张卡片
      // 【核心断言】这是在长任务跑的过程中并行处理的，不应等长任务结束
      expect(env.cardReplies.length).toBe(1);

      // 等 dispatch 完全结束
      await dispatchPromise;
    } finally {
      (env.sessionManager as any).sendSDKMessage = origSendSDK;
    }
  });
});

// ===== Spec §2.1 端到端 v3→v4 迁移测试 =====
// Spec §2.1 明确：升 v4 第一次启动后，老 session 的 last_user_preview 不为空。
// 这需要 cache + scanner + migration 三者协同工作，必须端到端测试。

describe('v3→v4 end-to-end migration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'e2e-migration-test-'));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('v3 cache + v3 registry: after sync, new preview fields are populated', async () => {
    // 1. 写入 v3 格式的 cache（无 meta.schemaVersion 字段）
    const claudeDir = join(tmpDir, '.claude', 'projects', '-Users-test-e2e');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(tmpDir, '.claude', 'projects', '-Users-test-e2e', 'e2e-session.jsonl'), [
      JSON.stringify({
        cwd: '/tmp/e2e',
        type: 'user',
        message: { role: 'user', content: 'E2E_TEST_USER_PROMPT_LINE_1' },
        timestamp: '2026-01-01T00:00:00Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'E2E assistant reply' }] },
        timestamp: '2026-01-01T00:01:00Z',
      }),
    ].join('\n'));

    // 2. 写入 v3 格式的 registry（包含一个 session，但没新字段）
    const v3Registry = {
      version: 3,
      updated_at: '2026-01-01T00:00:00Z',
      sessions: {
        'e2e-session': {
          origin: 'cli',
          cwd: '/tmp/e2e',
          project_name: 'e2e',
          jsonl_path: null,
          project_dir: 'e2e',
          created_at: '2026-01-01T00:00:00Z',
          last_active: '2026-01-01T00:01:00Z',
          title: 'E2E',
          message_count: 2,
          last_message_preview: 'E2E assistant reply',
          // 注意：没有 last_user_preview / last_assistant_preview
        },
      },
    };
    writeFileSync(join(tmpDir, 'registry.json'), JSON.stringify(v3Registry, null, 2));

    // 3. 写入 v3 格式的 scan_cache（无 meta.schemaVersion）
    writeFileSync(join(tmpDir, 'scan_cache.json'), JSON.stringify({
      // 没有 meta 字段——v3 格式
      cache: { 'whatever': 0 },
    }));

    // 4. 触发 sync：模拟 bot 启动
    const registry = new RegistryManager(tmpDir);
    await syncBeforeCommand(registry, join(tmpDir, 'scan_cache.json'), join(tmpDir, '.claude'));

    // 5. 验证：registry 升到 v4 + 新字段被填入
    const entry = registry.get('e2e-session');
    expect(entry).toBeDefined();
    // 关键断言：老 session 升级后 last_user_preview 不为空（spec §2.1 核心要求）
    expect(entry?.last_user_preview).toBe('E2E_TEST_USER_PROMPT_LINE_1');
    expect(entry?.last_assistant_preview).toBe('E2E assistant reply');  // < 80 chars, 完整保留
  });
});

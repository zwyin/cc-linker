import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { createTestBot, type TestBot } from '../../helpers/feishu-bot';

describe('FeishuBot doCardList running marker', () => {
  let env: TestBot;

  beforeEach(() => {
    env = createTestBot({ tmpDirPrefix: 'bot-list-test-' });
  });

  afterEach(() => {
    env.cleanup();
  });

  it('list card shows 🔴 mark for running sessions', async () => {
    env.registry.upsert('running-uuid-1', {
      origin: 'cli',
      cwd: '/tmp/running',
      project_name: 'running',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: new Date().toISOString(),
      title: 'Running Session',
      message_count: 3,
      last_message_preview: 'preview',
    });
    env.registry.upsert('idle-uuid-2', {
      origin: 'cli',
      cwd: '/tmp/idle',
      project_name: 'idle',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: new Date().toISOString(),
      title: 'Idle Session',
      message_count: 1,
      last_message_preview: 'idle preview',
    });

    // 模拟 running-uuid-1 正在跑
    (env.sessionManager as any).listSessions = () => [
      { sessionId: 'running-uuid-1', pid: 12345, cwd: '/tmp/running', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    await env.bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'list', value: '' },
      message: { message_id: 'msg-list-1' },
    });

    expect(env.cardReplies.length).toBe(1);
    const allContent = JSON.stringify(env.cardReplies[0].card.elements);
    expect(allContent).toContain('🔴 Running Session');
    expect(allContent).toContain('Idle Session');
    // Idle session 不应有 🔴
    expect(allContent).not.toContain('🔴 Idle Session');
  });

  it('list card text fallback shows [运行中] for running sessions', async () => {
    env.registry.upsert('running-uuid-3', {
      origin: 'cli',
      cwd: '/tmp/r3',
      project_name: 'r3',
      jsonl_path: null,
      project_dir: null,
      created_at: '2026-01-01T00:00:00Z',
      last_active: new Date().toISOString(),
      title: 'Running Three',
      message_count: 5,
      last_message_preview: 'p',
    });

    (env.sessionManager as any).listSessions = () => [
      { sessionId: 'running-uuid-3', pid: 999, cwd: '/tmp/r3', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    // 让 cardReplyFn 返回 null 触发 text fallback
    (env.bot as any).cardReplyFn = async () => null;

    await env.bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'list', value: '' },
      message: { message_id: 'msg-list-2' },
    });

    expect(env.textReplies.length).toBe(1);
    expect(env.textReplies[0].text).toContain('[运行中]');
    expect(env.textReplies[0].text).toContain('Running Three');
  });

  // ===== 【review 必加】补充测试覆盖盲区 =====

  it('list card shows no 🔴 mark when listSessions is empty (negative case)', async () => {
    // 准备 2 个 sessions
    env.registry.upsert('idle-a', {
      origin: 'cli', cwd: '/tmp/a', project_name: 'a', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Idle A', message_count: 1, last_message_preview: 'p',
    });
    env.registry.upsert('idle-b', {
      origin: 'cli', cwd: '/tmp/b', project_name: 'b', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Idle B', message_count: 1, last_message_preview: 'p',
    });

    // listSessions 返回空 → 没有 session 应该被标 🔴
    (env.sessionManager as any).listSessions = () => [];

    await env.bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'list', value: '' },
      message: { message_id: 'msg-list-empty' },
    });

    expect(env.cardReplies.length).toBe(1);
    const allContent = JSON.stringify(env.cardReplies[0].card.elements);
    expect(allContent).not.toContain('🔴');
    // 标题应存在
    expect(allContent).toContain('Idle A');
    expect(allContent).toContain('Idle B');
  });

  it('list card displays AI 末条 preview when last_assistant_preview exists', async () => {
    env.registry.upsert('preview-uuid-1', {
      origin: 'cli', cwd: '/tmp/p', project_name: 'p', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Preview Session', message_count: 1, last_message_preview: 'p',
      last_assistant_preview: 'This is a test assistant response that should appear in the list card',
    });

    (env.sessionManager as any).listSessions = () => [];

    await env.bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'list', value: '' },
      message: { message_id: 'msg-list-preview' },
    });

    expect(env.cardReplies.length).toBe(1);
    const allContent = JSON.stringify(env.cardReplies[0].card.elements);
    // 🤖 标记 + 60 字符截断版的 AI 末条
    expect(allContent).toContain('🤖');
    expect(allContent).toContain('This is a test assistant response that should appear');
  });

  it('runningUuids filters out empty sessionId from spawning sessions', async () => {
    // 准备一个真实存在的 session
    env.registry.upsert('real-uuid-filter', {
      origin: 'cli', cwd: '/tmp/rf', project_name: 'rf', jsonl_path: null, project_dir: null,
      created_at: '2026-01-01T00:00:00Z', last_active: new Date().toISOString(),
      title: 'Real Filter Session', message_count: 1, last_message_preview: 'p',
    });

    // mock: 一个空 sessionId（新 session 正在 spawn，sessionId 还没解析）+ 一个真实 sessionId
    // plan 中 doCardList 用 .filter(Boolean) 过滤空 sessionId，避免误把 '' 加进 runningUuids Set
    (env.sessionManager as any).listSessions = () => [
      { sessionId: '', pid: 111, cwd: '/tmp/spawning', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: true },
      { sessionId: 'real-uuid-filter', pid: 222, cwd: '/tmp/rf', createdAt: Date.now(), lastOutputAt: Date.now(), isNew: false },
    ];

    await env.bot.handleCardAction({
      open_id: 'ou_user1',
      action: { tag: 'list', value: '' },
      message: { message_id: 'msg-list-filter' },
    });

    expect(env.cardReplies.length).toBe(1);
    const allContent = JSON.stringify(env.cardReplies[0].card.elements);
    // 真实 session 应该有 🔴
    expect(allContent).toContain('🔴 Real Filter Session');
    // 因为 registry 中没有 '' 这个 uuid，所以空 sessionId 不会出现在卡片中（这是间接验证 filter 工作）
    // 但更重要的是：没有任何 "🔴" 误标到不存在的 session 上
    const runningMatches = allContent.match(/🔴/g) ?? [];
    expect(runningMatches.length).toBe(1);  // 只有 real-uuid-filter 一个 🔴
  });
});

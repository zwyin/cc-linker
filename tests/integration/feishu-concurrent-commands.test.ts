import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { readdirSync } from 'fs';
import { join } from 'path';
import { createTestBot, type TestBot } from '../helpers/feishu-bot';

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
});

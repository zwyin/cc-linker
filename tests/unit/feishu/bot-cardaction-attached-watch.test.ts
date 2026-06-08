import { beforeEach, describe, expect, test, mock } from 'bun:test';
import { FeishuBot } from '../../../src/feishu/bot';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { UserManager } from '../../../src/feishu/mapping';
import { config } from '../../../src/utils/config';
import { AgentSnapshotFetcher } from '../../../src/agent-view/snapshot-fetcher';

let bot: FeishuBot;
let agentView: AgentViewManager;
let handleStopWatchingCalls: string[];
const origFetcherFetch = AgentSnapshotFetcher.fetch;

beforeEach(() => {
  (config as any).data.feishu_bot.owner_open_id = '';
  bot = new FeishuBot({} as any);
  const userManager = new UserManager('/tmp/test-user-mapping-' + Math.random() + '.json');
  agentView = new AgentViewManager({
    userManager,
    replyFn: async () => 'msg',
    cardReplyFn: async () => 'om',
    patchFn: async () => ({}),
    runChatSDK: async () => ({ result: {}, handler: {}, cardMessageId: null }),
  });
  handleStopWatchingCalls = [];
  (agentView as any).handleStopWatching = async (openId: string) => {
    handleStopWatchingCalls.push(openId);
    return null;
  };
  bot.setAgentView(agentView);
  (AgentSnapshotFetcher as any).fetch = mock(async () => ({ ok: true, sessions: [] }));
});

describe('FeishuBot.handleCardAction agent_view_stop_watching', () => {
  test('dispatches to manager.handleStopWatching', async () => {
    const result = await bot.handleCardAction({
      open_id: 'ou_test',
      action: { tag: 'agent_view_stop_watching', value: { tag: 'agent_view_stop_watching' } },
      message: { message_id: 'om_test' },
    } as any);
    expect(handleStopWatchingCalls).toEqual(['ou_test']);
    expect(result).toBeNull();
  });
});

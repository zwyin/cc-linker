import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FeishuBot } from '../../src/feishu/bot';
import { UserManager } from '../../src/feishu/mapping';
import { ListSnapshotManager } from '../../src/feishu/list-snapshot';
import { SpoolQueue } from '../../src/queue/spool';
import { RegistryManager } from '../../src/registry/registry';
import { ClaudeSessionManager } from '../../src/proxy/session';
import { config } from '../../src/utils/config';

export interface ReplyCapture {
  text: string;
  openId?: string;
  messageId?: string;
}

export interface CardCapture {
  card: any;
  openId?: string;
  messageId?: string;
}

export interface TestBotOptions {
  /** Prefix for the tmpDir name. Default: 'cc-linker-bot-test-'. */
  tmpDirPrefix?: string;
  /** Suffix added to mock reply return values. Default: '-id'. */
  replyIdSuffix?: string;
  /** If true, do not mutate config (caller manages config). Default: false. */
  noConfigMutation?: boolean;
}

export interface TestBot {
  bot: FeishuBot;
  userManager: UserManager;
  listSnapshotManager: ListSnapshotManager;
  spoolQueue: SpoolQueue;
  registry: RegistryManager;
  sessionManager: ClaudeSessionManager;
  textReplies: ReplyCapture[];
  cardReplies: CardCapture[];
  tmpDir: string;
  /** Idempotent cleanup: restores config and removes tmpDir. */
  cleanup: () => void;
}

/**
 * Create a FeishuBot wired to in-memory mocks (real UserManager / ListSnapshotManager /
 * SpoolQueue / RegistryManager on a tempdir, mock replyFn / cardReplyFn capturing calls).
 *
 * Always clears `config.feishu_bot.owner_open_id` so tests using arbitrary openIds
 * (e.g. 'ou_user1') pass `validateOwner`. The original value is restored on `cleanup()`.
 *
 * Intended usage:
 *   const env = createTestBot({ tmpDirPrefix: 'my-test-' });
 *   try {
 *     // use env.bot, env.textReplies, env.cardReplies, env.registry
 *   } finally {
 *     env.cleanup();
 *   }
 */
export function createTestBot(opts: TestBotOptions = {}): TestBot {
  const tmpDirPrefix = opts.tmpDirPrefix ?? 'cc-linker-bot-test-';
  const replyIdSuffix = opts.replyIdSuffix ?? 'id';

  const tmpDir = mkdtempSync(join(tmpdir(), tmpDirPrefix));

  let originalOwnerOpenId: string | undefined;
  if (!opts.noConfigMutation) {
    originalOwnerOpenId = (config as any).data.feishu_bot.owner_open_id;
    (config as any).data.feishu_bot.owner_open_id = '';
  }

  const userManager = new UserManager(join(tmpDir, 'user-mapping.json'));
  const listSnapshotManager = new ListSnapshotManager(join(tmpDir, 'list-snapshot.json'));
  const spoolQueue = new SpoolQueue(tmpDir);
  const registry = new RegistryManager(tmpDir);
  const sessionManager = new ClaudeSessionManager();

  const textReplies: ReplyCapture[] = [];
  const cardReplies: CardCapture[] = [];

  const bot = new FeishuBot({
    userManager,
    listSnapshotManager,
    spoolQueue,
    registry,
    sessionManager,
    replyFn: async (text, replyOpts) => {
      textReplies.push({ text, openId: replyOpts?.openId, messageId: replyOpts?.messageId });
      return `reply-${replyIdSuffix}-${textReplies.length}`;
    },
    cardReplyFn: async (card, cardOpts) => {
      cardReplies.push({ card, openId: cardOpts?.openId, messageId: cardOpts?.messageId });
      return `card-${replyIdSuffix}-${cardReplies.length}`;
    },
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (originalOwnerOpenId !== undefined) {
      (config as any).data.feishu_bot.owner_open_id = originalOwnerOpenId;
    }
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  };

  return { bot, userManager, listSnapshotManager, spoolQueue, registry, sessionManager, textReplies, cardReplies, tmpDir, cleanup };
}

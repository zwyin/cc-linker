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
  /**
   * Extra config fields to set during the test, in `'section.field'` form.
   * The original value of each path is snapshot before being overwritten and
   * restored on `cleanup()`. If the path was absent originally (e.g.
   * `security.allowed_roots` not yet set), cleanup deletes the key so the
   * post-test state matches the pre-test state.
   *
   * Example: `{ 'queue.max_pending': 5, 'security.allowed_roots': [] }`.
   */
  extraConfigMutations?: Record<string, unknown>;
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
 * Use `extraConfigMutations` to also clear/overwrite other config keys (the snapshot
 * is taken pre-overwrite; missing keys are deleted on cleanup to leave config
 * exactly as the test found it).
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

  // Snapshot all config keys the test wants to mutate, then apply.
  // The sentinel `undefined` marks "key was absent originally" so cleanup
  // knows to delete it instead of restoring a value.
  const configSnapshots = new Map<string, unknown | undefined>();
  const applyConfigMutation = (path: string, newValue: unknown) => {
    const [section, field] = path.split('.');
    if (!section || !field) {
      throw new Error(`extraConfigMutations path must be "section.field", got: ${path}`);
    }
    const sectionData = (config as any).data[section];
    if (!sectionData) {
      throw new Error(`config.data.${section} does not exist; cannot set ${path}`);
    }
    if (!configSnapshots.has(path)) {
      configSnapshots.set(path, field in sectionData ? sectionData[field] : undefined);
    }
    sectionData[field] = newValue;
  };

  if (!opts.noConfigMutation) {
    applyConfigMutation('feishu_bot.owner_open_id', '');
  }
  for (const [path, value] of Object.entries(opts.extraConfigMutations ?? {})) {
    applyConfigMutation(path, value);
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
    for (const [path, originalValue] of configSnapshots) {
      const [section, field] = path.split('.');
      const sectionData = (config as any).data[section];
      if (originalValue === undefined) {
        delete sectionData[field];
      } else {
        sectionData[field] = originalValue;
      }
    }
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  };

  return { bot, userManager, listSnapshotManager, spoolQueue, registry, sessionManager, textReplies, cardReplies, tmpDir, cleanup };
}

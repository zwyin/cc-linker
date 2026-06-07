import type { UserManager, MappingEntry } from '../feishu/mapping';
import { AgentSnapshotFetcher } from './snapshot-fetcher';
import { ExpectedReplyState } from './expected-reply-state';
import { buildListCard, buildPeekCard, buildErrorCard, buildEmptyCard, buildWaitingCard, buildStopConfirmCard } from './card';
import type { AgentSession, AgentSessionGroup, AgentSessionStatus } from './types';
import { groupByStatus } from './types';
import { config } from '../utils/config';
import { extractRecentAssistantText } from './jsonl-peek';
import { JsonlIndex } from './jsonl-name';
import { readRoster, lookupResumeFromPath } from './roster-source';

/** Maximum list-card byte size. 飞书 card 25KB 上限;超过走 text fallback。 */
const MAX_CARD_BYTES = 25_000;
/** 列表卡显示上限:spec §6.1 "列表上限 10 个会话 + 折行"。 */
const MAX_LIST_ITEMS = 10;
/** 列表 fallback 文本:卡超 25KB 时降级。 */
const LIST_FALLBACK_TEXT = (n: number) => `📋 Agent View · ${n} sessions · /agents to refresh`;

export interface AgentViewDeps {
  userManager: UserManager;
  feishuClient?: any;
  replyFn: (text: string, opts: { openId: string; messageId?: string }) => Promise<string | null>;
  cardReplyFn: (card: string, opts: { openId: string; messageId?: string }) => Promise<string | null>;
  patchFn: (messageId: string, card: string) => Promise<any>;
  runChatSDK: (params: {
    openId: string; sessionUuid: string; cwd: string;
    promptText: string; serialKey: string; isNew?: boolean;
    settingsPath?: string;
  }) => Promise<{ result: any; handler: any; cardMessageId: string | null }>;
  expectedReplyTimeoutMs?: number;
}

export class AgentViewManager {
  readonly expectedReply: ExpectedReplyState;
  private minRefreshIntervalMs = 2000;
  private lastRefreshAt = 0;

  constructor(public deps: AgentViewDeps) {
    this.expectedReply = new ExpectedReplyState(
      deps.userManager,
      deps.expectedReplyTimeoutMs ?? 300_000
    );
  }

  /** /agents 命令入口 — 抓取快照并发送列表卡;持久化 cardMessageId 以便后续 refresh patch */
  async handleList(openId: string, _msgMessageId?: string): Promise<void> {
    const result = await AgentSnapshotFetcher.fetch();
    if (!result.ok) {
      const card = buildErrorCard({ title: 'Agent View 错误', body: result.reason });
      await this.deps.cardReplyFn(card, { openId });
      return;
    }
    const totalSessions = result.sessions.length;
    if (totalSessions === 0) {
      const card = buildEmptyCard();
      await this.deps.cardReplyFn(card, { openId });
      return;
    }
    // 列表上限 10(spec §6.1)
    const cappedSessions = result.sessions.slice(0, MAX_LIST_ITEMS);
    const groups = groupByStatus(cappedSessions);
    // v2.2 修正:>10 时 buildListCard 追加 "… N more" 折行
    const hasMore = Math.max(0, result.sessions.length - MAX_LIST_ITEMS);
    const card = buildListCard(groups, new Date().toLocaleTimeString(), hasMore);
    const cardMessageId = await this.sendOrFallback(
      card,
      { openId },
      LIST_FALLBACK_TEXT(totalSessions),
      openId,
    );
    if (cardMessageId) {
      // 保存 cardMessageId 到 user-mapping(last_agent_list_card)
      // 供 handleRefreshList 校验 messageId 时使用
      await this.deps.userManager.compareAndSwap(openId, null, {
        type: 'last_agent_list_card',
        sessionUuid: null,
        createdAt: new Date().toISOString(),
        cardMessageId,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  // ── Card action handlers (dispatched from FeishuBot.handleCardAction) ──
  // Full implementations land in T14-T22. These stubs keep the bot's
  // dispatch typecheck-clean while the real handlers are being written;
  // calling them before T14-T22 throws so we notice in QA.

  /**
   * Refresh 列表卡 — 校验 messageId 匹配 user-mapping 中的 last_agent_list_card,
   * 校验通过则 patch 原卡;校验失败则发新卡(避免误 patch 已被覆盖的旧卡)。
   */
  async handleRefreshList(openId: string, messageId?: string): Promise<string | null> {
    if (!messageId) return null;
    if (!this.shouldRefresh()) return null;
    // v2.2 修正:校验 messageId 匹配 last_agent_list_card.cardMessageId
    // 防止用户从飞书历史消息点 [Refresh](旧 messageId 已 patch 过),误 patch 错卡片
    const entry = this.deps.userManager.getEntry(openId);
    if (entry?.type !== 'last_agent_list_card' || entry.cardMessageId !== messageId) {
      // 校验失败:发新列表卡(覆盖原 cardMessageId 记录)
      await this.handleList(openId);
      return null;
    }
    const result = await AgentSnapshotFetcher.fetch();
    if (!result.ok) {
      // patch 错误卡
      const card = buildErrorCard({
        title: 'Refresh 失败',
        body: result.reason,
        refreshButton: true,
      });
      await this.deps.patchFn(messageId, card);
      return null;
    }
    const totalSessions = result.sessions.length;
    if (totalSessions === 0) {
      const card = buildEmptyCard();
      await this.deps.patchFn(messageId, card);
      return null;
    }
    const cappedSessions = result.sessions.slice(0, MAX_LIST_ITEMS);
    const groups = groupByStatus(cappedSessions);
    // v2.2 修正:>10 时 buildListCard 追加 "… N more" 折行
    const hasMore = Math.max(0, result.sessions.length - MAX_LIST_ITEMS);
    const card = buildListCard(groups, new Date().toLocaleTimeString(), hasMore);
    // G11:超 25KB 走 text fallback;用 replyFn 代替 patchFn(无法 patch 一个新消息)
    const size = new TextEncoder().encode(card).length;
    if (size > MAX_CARD_BYTES) {
      await this.deps.replyFn(LIST_FALLBACK_TEXT(totalSessions), { openId });
      return null;
    }
    await this.deps.patchFn(messageId, card);
    return null;
  }

  /** Find a session in the latest snapshot by sessionId. Returns null if absent. */
  private async findSession(_openId: string, sessionId: string): Promise<AgentSession | null> {
    const result = await AgentSnapshotFetcher.fetch();
    if (!result.ok) return null;
    return result.sessions.find(s => s.sessionId === sessionId) ?? null;
  }

  /**
   * v2.2.8: 解析 Peek 卡的 Recent output 内容。
   *
   * 数据源优先级:
   *   1) bg session 自己的 JSONL 最后一条 assistant 文本(本地 markdown,飞书直接渲染)
   *   2) roster.dispatch.launch.sessionId 指向的 parent JSONL 最后 assistant 文本
   *      (fork-from-active 场景:bg session 自己的 JSONL 只有 metadata)
   *   3) 退化:`claude logs <short>` raw 输出 + ANSI strip,加入"原始终端片段"提示
   *
   * 返回 `{ text, format }`:
   *   format='markdown' — 直接 markdown 渲染(干净)
   *   format='terminal' — 走 code-block + 提示这是 raw 终端片段(可能有 tofu)
   *   text=null — 三层都没拿到东西
   *
   * @internal _peekHooks 用于测试 swap 各层依赖
   */
  async resolvePeekContent(
    shortId: string,
    maxChars: number,
  ): Promise<{ text: string | null; format: 'markdown' | 'terminal' }> {
    // Tier 1: 自己的 JSONL
    const ownPath = AgentViewManager._peekHooks.findJsonlForShort(shortId);
    if (ownPath) {
      const text = AgentViewManager._peekHooks.extractRecentAssistantText(ownPath, maxChars);
      if (text) return { text, format: 'markdown' };
    }
    // Tier 2: roster 的 resume-from parent JSONL
    const roster = AgentViewManager._peekHooks.readRoster();
    const parentPath = roster ? AgentViewManager._peekHooks.lookupResumeFromPath(roster, shortId) : null;
    if (parentPath) {
      const text = AgentViewManager._peekHooks.extractRecentAssistantText(parentPath, maxChars);
      if (text) return { text, format: 'markdown' };
    }
    // Tier 3: 老的 claude logs 退化(尽量避免)
    try {
      const cp = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileP = promisify(cp.execFile);
      const r = await execFileP('claude', ['logs', shortId], { timeout: 3000 });
      const { stripAnsi } = await import('./ansi-strip');
      const stripped = stripAnsi(r.stdout);
      const peekLines = config.get<number>('agent_view.peek_lines', 30);
      const tail = stripped.split('\n').slice(-peekLines).join('\n');
      const truncated = truncateBytes(tail, maxChars);
      if (truncated.trim()) return { text: truncated, format: 'terminal' };
    } catch {
      // ignore, fall through
    }
    return { text: null, format: 'markdown' };
  }

  // v2.2.8: 注入点 —— tests 通过 swap 这些函数模拟各层命中/miss
  // 走 mutable object(不是 ESM 命名空间),绕开 bun mock.module 跨文件限制
  static _peekHooks = {
    findJsonlForShort: (short: string): string | null => {
      const idx = new JsonlIndex();
      return idx.lookup(short);
    },
    extractRecentAssistantText,
    readRoster,
    lookupResumeFromPath,
  };

  /**
   * /agents 列表卡 → [Peek] 按钮入口。
   * v2.2.8: Recent output 改从 JSONL 提取最后一条 assistant markdown 文本,
   * 不再用 `claude logs` 的 raw 终端 buffer(含光标定位 + box-drawing,飞书渲染成 tofu □)。
   * 见 resolvePeekContent。
   */
  async handlePeek(
    openId: string,
    shortId: string,
    sessionId: string,
    cwd: string,
  ): Promise<string | Record<string, unknown> | null> {
    const session = await this.findSession(openId, sessionId);
    if (!session) {
      await this.deps.replyFn('⚠️ 会话已不存在', { openId });
      return null;
    }
    const peekMaxBytes = config.get<number>('agent_view.peek_max_bytes', 2048);
    const peek = await this.resolvePeekContent(shortId, peekMaxBytes);
    const truncated = peek.text ?? '(无可用输出)';
    const buttons = {
      peek: true,
      attach: true,
      reply: session.status === 'waiting',
      stop: session.status === 'busy',
      refresh: true,
    };
    const card = buildPeekCard({
      name: session.name,
      status: session.status,
      waitingFor: session.waitingFor,
      shortId,
      sessionId,
      cwd,
      pid: session.pid,
      startedAt: session.startedAt,
      recentOutput: truncated,
      outputFormat: peek.format,
      buttons,
    });
    return await this.sendOrFallback(
      card,
      { openId },
      `🔍 Peek · \`${session.name}\` · /agents 刷新列表`,
      openId,
    );
  }

  /**
   * Peek 卡 → [Refresh] 按钮入口。校验 messageId 后,跟 handlePeek 类似流程
   * 但用 patchFn patch 现有 peek 卡。session 不存在时 patch 错误卡提示"已自动刷新列表"。
   */
  async handleRefreshPeek(
    openId: string,
    shortId: string,
    sessionId: string,
    messageId?: string,
  ): Promise<string | null> {
    if (!messageId) return null;
    const session = await this.findSession(openId, sessionId);
    if (!session) {
      await this.deps.patchFn(
        messageId,
        buildErrorCard({
          title: '⚠️ 会话已不存在',
          body: '已自动刷新列表',
        }),
      );
      return null;
    }
    const peekMaxBytes = config.get<number>('agent_view.peek_max_bytes', 2048);
    const peek = await this.resolvePeekContent(shortId, peekMaxBytes);
    const truncated = peek.text ?? '(无可用输出)';
    const buttons = {
      peek: true,
      attach: true,
      reply: session.status === 'waiting',
      stop: session.status === 'busy',
      refresh: true,
    };
    const card = buildPeekCard({
      name: session.name,
      status: session.status,
      waitingFor: session.waitingFor,
      shortId,
      sessionId,
      cwd: session.cwd,
      pid: session.pid,
      startedAt: session.startedAt,
      recentOutput: truncated,
      buttons,
    });
    // G11:超 25KB 走 text fallback(无法 patch 时发新文本)
    const size = new TextEncoder().encode(card).length;
    if (size > MAX_CARD_BYTES) {
      await this.deps.replyFn(
        `🔍 Peek · \`${session.name}\` · /agents 刷新列表`,
        { openId },
      );
      return null;
    }
    await this.deps.patchFn(messageId, card);
    return null;
  }

  /**
   * Step A: 二次确认(发独立卡)
   * 当用户点 [Stop] 按钮时,先弹一张红色确认卡,避免误触。
   * 卡内带 [确认停止] 按钮触发 handleStopConfirm(T21)。
   */
  async handleStop(
    _openId: string,
    shortId: string,
    sessionId: string,
    name: string,
  ): Promise<string | Record<string, unknown> | null> {
    const card = buildStopConfirmCard(name, shortId, sessionId);
    return await this.deps.cardReplyFn(card, { openId: _openId });
  }

  /**
   * Step B: 真执行 `claude stop <shortId>` + 等 1s + 刷新列表。
   * 失败时回复 `❌ Stop 失败:<err>`。
   */
  async handleStopConfirm(
    openId: string,
    shortId: string,
    _sessionId: string,
    _messageId?: string,
  ): Promise<string | null> {
    try {
      const cp = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileP = promisify(cp.execFile);
      await execFileP('claude', ['stop', shortId], { timeout: 5000 });
      // 等 supervisor 收尾
      await new Promise(r => setTimeout(r, 1000));
      await this.deps.replyFn(`✅ 已停止 ${shortId}`, { openId });
      // 重新拉并 patch 列表卡
      await this.handleList(openId);
      return null;
    } catch (err: any) {
      await this.deps.replyFn(`❌ Stop 失败:${err.message}`, { openId });
      return null;
    }
  }

  /**
   * Attach 到一个 background session。
   * v2.2 关键:必须用**两步 CAS**:
   *   1. 清旧 entry(如果有)→ entriesMatch(oldEntry, null) 在 entriesMatch 中
   *      视为 (non-null, null) 不匹配,所以不能直接 CAS(null → new)。
   *   2. 写新 session entry。
   * 保留旧 entry 的 defaultProvider(用户级配置,不应因 attach 重置)。
   * 失败:实时守卫(会话已不存在)/ CAS 冲突。
   */
  async handleAttach(
    openId: string,
    sessionId: string,
    _shortId: string,
    _name: string,
    cwd: string,
  ): Promise<string | Record<string, unknown> | null> {
    // v2.2.15: 比较守卫同时认 short 和 full UUID,避免 v2.2.14 把 short 展开成
    // full 后跟 snapshot 里的 full UUID 比较反而失配的回归(实测 card 给的 sessionId
    // 是 short,snapshot 里的 sessionId 是 full —— 两者展开成同一个 full 时看似一致,
    // 但顺序问题: 展开前是 "098639ad" vs "098639ad-9be0-...",不等;展开后是
    // "098639ad-9be0-..." vs "098639ad-9be0-...",相等 —— 但展开前守卫已经失败)。
    // 解决: 守卫里同时接受 short 和 full,把 sessionId 存 UserManager 之前
    // 才正式展开成 full。
    const idx = new JsonlIndex();
    let fullUuid: string | null = null;
    if (/^[0-9a-f]{8}$/.test(sessionId)) {
      const jsonlPath = idx.lookup(sessionId);
      if (jsonlPath) {
        const base = jsonlPath.split('/').pop() ?? '';
        const extracted = base.replace(/\.jsonl$/, '');
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(extracted)) {
          fullUuid = extracted;
        }
      }
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) {
      fullUuid = sessionId;
    }
    // 0. 实时守卫(snapshot 里的 sessionId 可能是 short 或 full,都得认)
    const result = await AgentSnapshotFetcher.fetch();
    if (
      !result.ok ||
      !result.sessions.find(s => s.sessionId === sessionId || (fullUuid && s.sessionId === fullUuid))
    ) {
      await this.deps.replyFn('⚠️ 会话已不存在', { openId });
      return null;
    }
    // 进入 CAS 阶段前,正式把 sessionId 替换成 full UUID,后续 UserManager
    // 写入和 SDK 调用都走 full,免得 SDK 拒 short("Provided value ... is not a UUID")
    if (fullUuid) sessionId = fullUuid;
    // v2.2 修正:只清除 expectedReply IF oldEntry 本身就是 pending_agent_reply。
    // 旧逻辑:无条件 expectedReply.clear() 早于 CAS 1/2 — 如果 CAS 1 或 2 失败,用户
    //   已经丢失了 pending reply(白白丢弃)。新逻辑:CAS 1 失败时 expectedReply 仍在,
    //   用户下次 handleReply 仍能正常工作。
    // 1. CAS 1 准备:如果旧 entry 就是 expectedReply,先 clear 它(它会自己做 CAS pending_agent_reply → null)
    //    然后重新读 entry(防止中间并发修改)。
    const oldEntry = this.deps.userManager.getEntry(openId);
    if (oldEntry && oldEntry.type === 'pending_agent_reply') {
      await this.expectedReply.clear(openId, 'overwrite');
    }
    // 2. CAS 1: 清旧 entry
    const currentEntry = this.deps.userManager.getEntry(openId);
    if (currentEntry) {
      const ok1 = await this.deps.userManager.compareAndSwap(openId, currentEntry, null);
      if (!ok1) {
        await this.deps.replyFn('⚠️ 状态冲突,请重试', { openId });
        return null;
      }
    }
    // 3. CAS 2: 写新 session entry
    const newEntry: MappingEntry = {
      type: 'session',
      sessionUuid: sessionId,
      cwd,
      createdAt: new Date().toISOString(),
      // 保留用户级 defaultProvider,不要因 attach 丢失
      defaultProvider: oldEntry?.defaultProvider,
    };
    const ok2 = await this.deps.userManager.compareAndSwap(openId, null, newEntry);
    if (!ok2) {
      await this.deps.replyFn('⚠️ 状态冲突,请重试', { openId });
      return null;
    }
    // 4. 发确认文本(busy/waiting 状态加提示)
    const session = result.sessions.find(s => s.sessionId === sessionId)!;
    const warning = session.status === 'busy' ? '\n⚠️ 该 session 正在处理中' : '';
    const waitingInfo =
      session.status === 'waiting' && session.waitingFor
        ? `\n等待原因: ${session.waitingFor}`
        : '';
    // v2.2.11: 探测到 live bg worker 时,预警 attach 后发消息会被拒绝卡阻拦,
    // 避免用户后面莫名其妙看到冲突卡才反应过来。settled session 不显示该提示。
    let bgWorkerNotice = '';
    try {
      const { readRoster } = await import('./roster-source');
      const roster = readRoster();
      const short = sessionId.slice(0, 8);
      if (roster?.workers?.[short]) {
        bgWorkerNotice =
          `\n\n⚠️ 该 session 仍有 bg worker 在跑。直接发消息会被阻拦(避免与 worker ` +
          `并发改 cwd 文件),弹卡询问 [🛑 停 bg 后继续发送] / [🌿 开新会话发送] / ` +
          `[❌ 取消]。`;
      }
    } catch {
      // graceful: roster 读不到就不显示警示
    }
    await this.deps.replyFn(
      `📎 已 Attach 到 \`${session.name}\`${warning}${waitingInfo}\n` +
        `Status: ${session.status} · CWD: ${cwd}\n` +
        `💡 提示:发 /new 创建新会话,或 /agents 返回列表。${bgWorkerNotice}`,
      { openId },
    );
    return null;
  }

  /**
   * v2.2.11 + v2.2.13: bg-conflict 拒绝卡 → [🛑 停 bg 后继续发送] 按钮。
   *
   * v2.2.13 关键修正:**总是 fallback 到 parent**(除非没 parent)。
   *
   *   1) 跑 `claude stop <shortId>` 释放 bg worker
   *   2) 等 supervisor 收尾(~1s)
   *   3) 用 button value 里 stashed 的 parent UUID resume(不再二次查 roster,
   *      因为 stop 后 worker 已被移除)。UserManager 同步切到 parent,后续消息
   *      走 parent,不再触发 bg-conflict 探测。
   *
   * v2.2.12 的"探测 bg JSONL 有无对话"思路错误:实测 92664deb (有真实 user/
   * assistant 对话条目) stop 后 resume 仍然报 "No conversation found"。claude
   * 在 stop 后对 bg sessionId 状态判定不可靠。parent 永远可靠 —— bot 路径走
   * parent,牺牲"继承 bg 内存里跑出来的 worker 增量"(已经因为 stop 丢了),
   * 换取"消息能正常发出"。
   *
   * v2.2.13 进一步:stashed parent UUID 写在 button value 里,本函数不再读 roster
   * (worker 已被 stop 移走,二次查必然查不到 parent)。parent 不可用(hasParent=false)
   * 时退化为用 bg sessionId 直接 resume(raw-slash bg 场景,几乎不存在)。
   */
  async handleStopAndSend(
    openId: string,
    shortId: string,
    sessionId: string,
    cwd: string,
    text: string,
    parentUuid: string,
    hasParent: boolean,
    messageId?: string,
  ): Promise<string | null> {
    // Step 1: stop bg worker
    try {
      const cp = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileP = promisify(cp.execFile);
      await execFileP('claude', ['stop', shortId], { timeout: 5000 });
    } catch (err: any) {
      // "No job matching"(已自然 settle)算成功;其他错才报
      const msg = err?.stderr || err?.message || String(err);
      if (!/No job matching/i.test(msg)) {
        await this.deps.replyFn(`❌ Stop 失败:${msg}`, { openId });
        return null;
      }
    }
    // Step 2: 等 supervisor 释放(同 handleStopConfirm)
    await new Promise(r => setTimeout(r, 1000));

    // 把拒绝卡 patch 成"已处理"提示,避免用户重复点
    if (messageId) {
      try {
        await this.deps.patchFn(
          messageId,
          buildErrorCard({
            title: '🛑 bg worker 已停止',
            body: '正在发送你的消息...',
          }),
        );
      } catch {
        // patch 失败不影响主流程
      }
    }

    // Step 3 (v2.2.13): 总是 fallback 到 parent(除非没 parent)。
    //   hasParent=true:用 button value stashed 的 parent UUID resume。parent 永远可靠。
    //   hasParent=false:bg 是 raw slash 派发(无 parent),直接 resume bg sessionId —— 这种情况
    //     极少见,且 v2.2.12 的"探测空 JSONL"策略也救不了它(失败的话直接报错给用户看)。
    const effectiveSessionUuid = hasParent && parentUuid ? parentUuid : sessionId;
    const effectiveSerialKey = effectiveSessionUuid;
    const fallbackNote = hasParent && parentUuid
      ? `已自动 fallback 到 parent session (${parentUuid.slice(0, 8)}...) —— bg worker 内存里的增量对话会丢失,parent 有 fork 之前的历史。`
      : '';

    // 把 UserManager 的 session entry CAS 切到 effective sessionId(后续消息不再触发探测)
    if (effectiveSessionUuid !== sessionId) {
      const oldEntry = this.deps.userManager.getEntry(openId);
      if (oldEntry?.type === 'session' && oldEntry.sessionUuid === sessionId) {
        const newEntry: MappingEntry = { ...oldEntry, sessionUuid: effectiveSessionUuid };
        const ok = await this.deps.userManager.compareAndSwap(openId, oldEntry, newEntry);
        if (ok && fallbackNote) {
          this.deps.replyFn(
            `🛑 bg worker ${shortId} 已停止。${fallbackNote}`,
            { openId },
          );
        }
      }
    }

    // Step 4: 调 runChatSDK 真正发消息。worker 已不在 roster,探测不会再拒绝。
    try {
      await this.deps.runChatSDK({
        openId,
        sessionUuid: effectiveSessionUuid,
        cwd,
        promptText: text,
        serialKey: effectiveSerialKey,
        isNew: false,
      });
    } catch (err: any) {
      await this.deps.replyFn(`❌ 发送失败:${err?.message ?? err}`, { openId });
    }
    return null;
  }

  /**
   * v2.2.11: bg-conflict 拒绝卡 → [🌿 开新会话发送] 按钮。
   *
   * 完全独立于原 bg session:isNew=true 让 runChatSDK 不带 resume,
   * SDK 创建全新 sessionId。bg worker 继续独立跑,飞书侧拿到一个全新
   * 上下文(cwd 沿用原 session 的,方便继续在同项目下干活)。
   */
  async handleNewAndSend(
    openId: string,
    cwd: string,
    text: string,
    messageId?: string,
  ): Promise<string | null> {
    if (messageId) {
      try {
        await this.deps.patchFn(
          messageId,
          buildErrorCard({
            title: '🌿 开新会话中',
            body: '正在创建独立 session 处理你的消息...',
          }),
        );
      } catch {
        // ignore
      }
    }
    try {
      await this.deps.runChatSDK({
        openId,
        sessionUuid: '', // empty + isNew=true → 新建
        cwd,
        promptText: text,
        serialKey: `new:${openId}:${Date.now()}`,
        isNew: true,
      });
    } catch (err: any) {
      await this.deps.replyFn(`❌ 新会话创建失败:${err?.message ?? err}`, { openId });
    }
    return null;
  }

  /**
   * v2.2.11: bg-conflict 拒绝卡 → [❌ 取消] 按钮。
   * 把拒绝卡 patch 成"已取消"提示,不调 SDK,不动 UserManager。
   */
  async handleBgConflictCancel(
    _openId: string,
    messageId?: string,
  ): Promise<string | null> {
    if (messageId) {
      try {
        await this.deps.patchFn(
          messageId,
          buildErrorCard({
            title: '❌ 已取消',
            body: '消息未发送,bg worker 不受影响。',
          }),
        );
      } catch {
        // ignore
      }
    }
    return null;
  }

  /**
   * Step A — set expectedReply and prompt the user to send the reply text.
   * Three-way guard (fetch ok / session present / status === 'waiting') runs
   * first; on success the trigger card (list or peek) is patched to a waiting
   * card BEFORE the prompt text is sent, so the user sees the card transition
   * before their input is requested. v2.2: patch order is patch -> reply.
   */
  async handleReplyRequest(
    openId: string,
    _shortId: string,
    sessionId: string,
    cwd: string,
  ): Promise<void> {
    // 1. 三重守卫
    const result = await AgentSnapshotFetcher.fetch();
    if (!result.ok) {
      await this.deps.replyFn(`❌ ${result.reason}`, { openId });
      return;
    }
    const session = result.sessions.find(s => s.sessionId === sessionId);
    if (!session) {
      await this.deps.replyFn('⚠️ 会话已不存在', { openId });
      return;
    }
    if (session.status !== 'waiting') {
      await this.deps.replyFn(
        `⚠️ 该 session 不是 waiting 状态(当前 ${session.status}),无法 reply`,
        { openId },
      );
      return;
    }
    // 2. 持久化 expectedReply
    // ExpectedReplyState.set CAS-expects null, so any existing entry (e.g.
    // last_agent_list_card from the /agents that triggered this Reply click)
    // makes set() throw. Capture the trigger card's messageId first, then
    // clear that entry to free the slot for set(). v2.2 intent: after set()
    // succeeds we patch the captured cardMessageId to a waiting card BEFORE
    // sending the prompt text.
    const preListEntry = this.deps.userManager.getEntry(openId);
    const triggerCardMessageId =
      preListEntry?.type === 'last_agent_list_card' ? preListEntry.cardMessageId : undefined;
    if (preListEntry?.type === 'last_agent_list_card') {
      await this.deps.userManager.compareAndSwap(openId, preListEntry, null);
    }
    try {
      await this.expectedReply.set(openId, { shortId: _shortId, sessionId, cwd });
    } catch (_err: any) {
      await this.deps.replyFn('⚠️ 另一端正在操作,请先在对方客户端取消', { openId });
      return;
    }
    // 3. patch 触发的 list 卡为等待输入卡(v2.2 顺序:先 patch,后发文本)
    if (triggerCardMessageId) {
      const waitingCard = buildWaitingCard({
        name: session.name,
        status: session.status,
        waitingFor: session.waitingFor,
        cwd,
      });
      await this.deps.patchFn(triggerCardMessageId, waitingCard);
    }
    // 4. 发独立文本消息
    await this.deps.replyFn(
      `↩️ 回复会话: ${session.name}\n请直接发送文字消息作为回复(5 分钟内有效)\n可点 [取消等待] 按钮,或发 /cancel 取消`,
      { openId },
    );
  }

  /**
   * Step B — once a reply text arrives, re-run the status guard, then proxy
   * the text through runChatSDK. v2.2 critical fix: wrap runChatSDK in
   * try/finally so expectedReply is cleared even if it throws (otherwise
   * the user stays stuck in waiting state until the 5-minute timeout).
   *
   * v2.2 simplification: removed the CAS-claim dance that bumped casToken.
   * The dance was dead code: the finally block clears the entry regardless
   * of CAS outcome, so the casToken change had no observable effect.
   * sessionLocks (in the SpoolQueue dispatch path) already serialize
   * per-session data, so per-session corruption is impossible.
   */
  async handleReply(openId: string, text: string): Promise<void> {
    // 1. 检查 expectedReply
    const info = this.expectedReply.get(openId);
    if (!info) return;

    // 2. Step B 二次状态守卫
    const result = await AgentSnapshotFetcher.fetch();
    if (!result.ok) {
      await this.expectedReply.clear(openId);
      return;
    }
    const session = result.sessions.find(s => s.sessionId === info.sessionId);
    if (!session) {
      await this.expectedReply.clear(openId);
      await this.deps.replyFn('⚠️ 会话已不存在', { openId });
      return;
    }
    if (session.status !== 'waiting') {
      await this.expectedReply.clear(openId);
      await this.deps.replyFn(
        `⚠️ Claude 已切换到 ${session.status},无法 reply`,
        { openId },
      );
      return;
    }

    // 3. runChatSDK,try/finally 保证 clear 必发(v2.2 critical)
    try {
      await this.deps.runChatSDK({
        openId,
        sessionUuid: info.sessionId,
        cwd: info.cwd,
        promptText: text,
        serialKey: info.sessionId,
        isNew: false,
      });
    } finally {
      await this.expectedReply.clear(openId);
    }
  }

  /**
   * Cancel an active waiting state. Idempotent — safe to call when no
   * reply is pending. v2.2: if nothing was pending, stay SILENT — don't
   * spam a "已取消" reply that confuses the user (they didn't ask to
   * cancel anything).
   */
  async handleCancelReply(openId: string, _messageId?: string): Promise<void> {
    const wasPending = !!this.expectedReply.get(openId);
    await this.expectedReply.clear(openId, 'user');
    if (wasPending) {
      await this.deps.replyFn('✅ 已取消等待回复', { openId });
    }
    // else: silent — no reply was pending, no need to confirm
  }

  /** Drop the user out of Agent View — pure text reply, no state mutation.
   *  v2.2: clear any pending expectedReply so the next chat message doesn't
   *  get re-routed as a reply (the user wants to chat, not reply to a
   *  background session). */
  async handleBackToChat(openId: string): Promise<void> {
    await this.expectedReply.clear(openId, 'overwrite');
    await this.deps.replyFn(
      '已退出 Agent View,继续发送消息或 / 命令即可。下次进 /agents 视图重新打 /agents。',
      { openId },
    );
  }

  /** R8 启动恢复钩子 */
  async restoreExpectedReplyStates(): Promise<void> {
    await this.expectedReply.restoreExpectedReplyStates();
  }

  /** Refresh 防抖 */
  shouldRefresh(): boolean {
    const now = Date.now();
    if (now - this.lastRefreshAt < this.minRefreshIntervalMs) return false;
    this.lastRefreshAt = now;
    return true;
  }

  /**
   * G11 卡片尺寸保护:卡 ≤ 25KB 发 cardReplyFn;超 25KB 降级为 replyFn text。
   * 返回 cardMessageId(若走 fallback 则返回 null)。
   */
  private async sendOrFallback(
    card: string,
    cardOpts: { openId: string; messageId?: string },
    fallbackText: string,
    openId: string,
  ): Promise<string | null> {
    const size = new TextEncoder().encode(card).length;
    if (size > MAX_CARD_BYTES) {
      await this.deps.replyFn(fallbackText, { openId });
      return null;
    }
    return await this.deps.cardReplyFn(card, cardOpts);
  }
}

/**
 * Truncate a string to at most `max` UTF-8 bytes.
 * Used by Peek cards to keep recent log output under the 2KB message-size budget.
 * Inline (not imported from card-updater) to avoid cross-module coupling.
 */
function truncateBytes(s: string, max: number): string {
  return new TextEncoder().encode(s).length <= max
    ? s
    : (() => {
        let acc = '';
        for (const ch of s) {
          if (new TextEncoder().encode(acc + ch).length > max) break;
          acc += ch;
        }
        return acc;
      })();
}

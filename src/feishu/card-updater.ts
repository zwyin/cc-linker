import { logger } from '../utils/logger';
import { config } from '../utils/config';
import type { ActivityResult } from '../utils/session-activity';
import { esc } from './markdown-escape';
import { buildWaitingCard } from '../agent-view/card';
import type { AgentSessionStatus } from '../agent-view/types';

export type CardState = 'processing' | 'streaming' | 'complete' | 'error' | 'cancelled';

interface CardUpdaterOptions {
  throttle_ms?: number;
  max_card_bytes?: number;
  show_thinking?: boolean;
  /** 流式卡按钮模式。'default' = [🛑 停止处理]; 'rendezvous' = [🔙 不等了] + [🛑 停 bg]. */
  buttons?: 'default' | 'rendezvous';
}

interface FeishuClient {
  im: {
    v1: {
      message: {
        create: (payload: any) => Promise<any>;
        patch: (payload: any) => Promise<any>;
      };
    };
  };
}

export class CardUpdater {
  private client: FeishuClient;
  private cardMessageId: string | null = null;
  private lastPatchAt = 0;
  private pendingUpdate: {
    thinking: string;
    text: string;
    elapsed: number;
    toolUses: Array<{ name: string; inputSummary: string }>;
  } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly throttleMs: number;
  private readonly maxCardBytes: number;
  private readonly showThinking: boolean;
  /** v2.x: rendezvous 模式下 [🛑 停 bg] 按钮 value 里塞的 shortId。
   *  必须在 startProcessing 之前 set, 否则首次渲染时按钮 value.shortId 为空。 */
  private rendezvousShortId: string | null = null;
  private readonly buttonsMode: 'default' | 'rendezvous';
  private state: CardState = 'processing';

  constructor(client: FeishuClient, options: CardUpdaterOptions = {}) {
    this.client = client;
    this.throttleMs = options.throttle_ms ?? config.get<number>('stream.throttle_ms', 1500);
    this.maxCardBytes = options.max_card_bytes ?? config.get<number>('stream.max_card_bytes', 25000);
    this.showThinking = options.show_thinking ?? config.get<boolean>('stream.show_thinking', true);
    this.buttonsMode = options.buttons ?? 'default';
  }

  getCardMessageId(): string | null { return this.cardMessageId; }
  getState(): CardState { return this.state; }

  /**
   * v2.4.x: 接管一张已存在的卡片(例如 handleReplyRequest 创建的"等待输入"卡),
   * 让后续 updateStream/complete/error 直接 patch 这张卡, 而不是新发。
   *
   * 不立即 patch — 由调用方后续的 updateStream() 触发首帧。
   * 如果调用方想立刻把"等待输入"卡变成"处理中"卡, 传 initialPatch=true。
   */
  async adoptExistingCard(messageId: string, initialPatch = false): Promise<void> {
    this.cardMessageId = messageId;
    this.state = 'processing';
    this.lastPatchAt = Date.now();
    if (initialPatch) {
      await this.patchCard(this.buildProcessingCard());
    }
  }

  /**
   * v2.4.x: 取消 pending timer + 清空 pendingUpdate。
   *
   * 必须在终态 patch (patchWaitingCard / complete / error) 之后调,
   * 否则 5s 节流的 pending timer 会在终态后 fire, 把卡片 revert 回
   * 上一次 updateStream 的内容 (例如从 "↩️ 回复" revert 成 "💭 处理中")。
   *
   * 这就是用户看到"处理中卡片卡在 3s 不刷新"的根因。
   */
  cancelPending(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.pendingUpdate = null;
  }

  /**
   * v2.4.x: bg 处理完一个 reply 又问新问题 (new_needs) 时, patch 卡回
   * "等待输入" 状态(黄色 header + [取消等待] 按钮)。语义是 bg 没死, 只是
   * 发完一个 turn 后又问下一个 — 跟 🛑 已取消 (cancel) 完全相反。
   *
   * 必须先 adoptExistingCard / startProcessing 设过 cardMessageId,
   * 否则 patch 不知道 patch 哪张卡。
   *
   * 注意: buildWaitingCard 返回 string(JSON-serialized), 而 patchCard
   * 期望 Record<string, unknown>。这里 parse 回来避免 double-encode。
   * (其他 buildXxxCard 返回 object, 不用 parse。)
   */
  async patchWaitingCard(opts: {
    name: string;
    status: AgentSessionStatus;
    waitingFor?: string;
    cwd: string;
    recentOutput?: string;
    outputFormat?: 'markdown' | 'terminal';
  }): Promise<void> {
    const cardStr = buildWaitingCard(opts);
    const card = JSON.parse(cardStr);
    await this.patchCard(card);
    // 状态切回 'processing' — 表达"在等用户回"(不是 cancelled, 不是 streaming)
    this.state = 'processing';
  }

  async startProcessing(openId: string): Promise<string> {
    const card = this.buildProcessingCard();
    const resp = await this.client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    this.cardMessageId = resp.data?.message_id ?? null;
    if (!this.cardMessageId) throw new Error('Failed to create processing card');
    this.state = 'processing';
    this.lastPatchAt = Date.now();
    return this.cardMessageId;
  }

  /**
   * v2.4.x: updateStream 多接 toolUses 数组 (默认 []), 跟 thinking/text
   * 一起放进 pendingUpdate。throttle 没变 (5s 默认), flushPending 统一
   * 调 buildStreamingCard 渲染。
   */
  async updateStream(
    thinking: string,
    text: string,
    elapsedMs: number,
    toolUses: Array<{ name: string; inputSummary: string }> = [],
  ): Promise<void> {
    this.pendingUpdate = { thinking, text, elapsed: elapsedMs, toolUses };
    const now = Date.now();
    if (now - this.lastPatchAt >= this.throttleMs) {
      await this.flushPending();
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(async () => {
        this.pendingTimer = null;
        await this.flushPending();
      }, this.throttleMs - (now - this.lastPatchAt));
    }
  }

  private async flushPending(): Promise<void> {
    if (!this.pendingUpdate || !this.cardMessageId) return;
    // Clear any pending timer — we're flushing now, no need for deferred call
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
    const { thinking, text, elapsed, toolUses } = this.pendingUpdate;
    await this.patchCard(this.buildStreamingCard(thinking, text, elapsed, toolUses));
    this.pendingUpdate = null;
    this.state = 'streaming';
  }

  async complete(response: string, tokensIn: number, tokensOut: number, durationMs: number, numTurns: number): Promise<void> {
    await this.flushPending();
    await this.patchCard(this.buildCompleteCard(response, tokensIn, tokensOut, durationMs, numTurns));
    this.state = 'complete';
  }

  async error(message: string): Promise<void> {
    await this.flushPending();
    await this.patchCard(this.buildErrorCard(message));
    this.state = 'error';
  }

  async cancel(reason?: string): Promise<void> {
    await this.flushPending();
    await this.patchCard(this.buildCancelledCard(reason));
    this.state = 'cancelled';
  }

  /**
   * v2.x: rendezvous abort/stop 专用终态 patch。比 cancel() 灵活:
   * - 自定义 header title + template (不再硬编码 "🛑 已取消" grey)
   * - body 完全可控 (不再硬加 "你可以随时发送新消息继续对话" 后缀)
   */
  async patchAbortedTracking(opts: {
    headerTitle: string;
    headerTemplate: 'grey' | 'blue' | 'red' | 'green' | 'yellow';
    body: string;
  }): Promise<void> {
    await this.flushPending();
    await this.patchCard({
      config: { wide_screen_mode: true, update_multi: true },
      header: { title: { tag: 'plain_text', content: opts.headerTitle }, template: opts.headerTemplate },
      elements: [{ tag: 'markdown', content: opts.body }],
    });
    this.state = 'cancelled';
  }

  shouldFallbackToText(content: string): boolean {
    return new TextEncoder().encode(content).length > this.maxCardBytes;
  }

  truncateContent(content: string): string {
    return truncateBytes(content, this.maxCardBytes);
  }

  /** Create a permission request card with Allow/Deny buttons */
  async createPermissionCard(
    openId: string,
    toolName: string,
    action: string,
    promptIndex: number,
    handlerId: string,
  ): Promise<string> {
    const card = this.buildPermissionCard(toolName, action, promptIndex, handlerId);
    logger.info(`CardUpdater: creating permission card for openId=${openId}`);
    const resp = await this.client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    logger.info(`CardUpdater: create response=${JSON.stringify(resp)}`);
    const messageId = resp.data?.message_id ?? null;
    if (!messageId) throw new Error('Failed to create permission card');
    this.cardMessageId = messageId;
    this.state = 'processing';
    this.lastPatchAt = Date.now();
    logger.info(`CardUpdater: permission card created, message_id=${messageId}`);
    return messageId;
  }

  /** Patch an existing busy card in-place to the confirm step */
  async patchCLIBusyCardToConfirm(messageId: string, sessionTitle: string): Promise<void> {
    this.cardMessageId = messageId;
    await this.patchCard(this.buildForceSendConfirmCard(sessionTitle));
  }

  /** Create a CLI busy notification card with optional force-send action */
  async createCLIBusyCard(
    openId: string,
    sessionTitle: string,
    status: ActivityResult,
  ): Promise<string> {
    const card = this.buildCLIBusyCard(sessionTitle, status);
    logger.info(`CardUpdater: creating CLI busy card for openId=${openId}, reason=${status.reason}`);
    const resp = await this.client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    logger.info(`CardUpdater: create response=${JSON.stringify(resp)}`);
    const messageId = resp.data?.message_id ?? null;
    if (!messageId) throw new Error('Failed to create CLI busy card');
    this.cardMessageId = messageId;
    this.state = 'processing';
    this.lastPatchAt = Date.now();
    logger.info(`CardUpdater: CLI busy card created, message_id=${messageId}`);
    return messageId;
  }

  /** Update existing permission card to processing state (after user clicked) */
  async updatePermissionCardToProcessing(): Promise<void> {
    await this.patchCard(this.buildPermissionProcessingCard());
  }

  /** Update existing permission card with result */
  async updatePermissionCard(approved: boolean): Promise<void> {
    const card = approved
      ? this.buildPermissionResultCard(true)
      : this.buildPermissionResultCard(false);
    await this.patchCard(card);
  }

  /** Update existing permission card to completed state (after operation finishes) */
  async updatePermissionCardToCompleted(): Promise<void> {
    await this.patchCard(this.buildPermissionCompletedCard());
  }

  /** Allow external code to set cardMessageId for permission card patching */
  setCardMessageId(messageId: string): void {
    this.cardMessageId = messageId;
  }

  /** v2.x: rendezvous 模式按钮 value.shortId 注入。**必须在 startProcessing 之前调** —
   *  startProcessing → buildProcessingCard → buildStreamingCard, 首次渲染就读 shortId。 */
  setRendezvousShortId(short: string): void {
    this.rendezvousShortId = short;
  }

  private buildPermissionCard(
    toolName: string,
    action: string,
    promptIndex: number,
    handlerId: string,
  ): Record<string, unknown> {
    const actionLabel = this.getToolActionLabel(toolName);
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '🔐 需要权限确认' },
        template: 'orange',
      },
      elements: [
        {
          tag: 'markdown',
          content: `Claude 想要执行以下操作：\n\n**${actionLabel}：**\n\`\`\`\n${esc(action)}\n\`\`\``,
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 允许' },
              type: 'primary',
              value: { type: 'permission_approve', index: promptIndex, handlerId },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '❌ 拒绝' },
              type: 'default',
              value: { type: 'permission_deny', index: promptIndex, handlerId },
            },
          ],
        },
      ],
    };
  }

  private buildPermissionProcessingCard(): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '⏳ 处理中...' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'markdown',
          content: '**已允许**，Claude 正在执行该操作...',
        },
      ],
    };
  }

  private buildPermissionResultCard(approved: boolean): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: {
          tag: 'plain_text',
          content: approved ? '✅ 已允许' : '❌ 已拒绝',
        },
        template: approved ? 'green' : 'red',
      },
      elements: [
        {
          tag: 'markdown',
          content: approved
            ? '操作已被允许，Claude 将继续执行。'
            : '操作已被拒绝，Claude 将尝试其他方式。',
        },
      ],
    };
  }

  private buildPermissionCompletedCard(): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '✅ 已完成' },
        template: 'green',
      },
      elements: [
        {
          tag: 'markdown',
          content: '操作已执行完毕，Claude 已完成该操作。',
        },
      ],
    };
  }

  private buildCLIBusyCard(
    sessionTitle: string,
    status: ActivityResult,
  ): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '⚠️ CLI 侧会话处理中' },
        template: 'yellow',
      },
      elements: [
        {
          tag: 'markdown',
          content: `会话 **"${esc(sessionTitle)}"** 正在 **CLI 终端** 处理中。\n\n> 💡 检测依据：${esc(status.reason)}\n> 建议等待 CLI 侧处理完毕后再继续对话。`,
        },
        {
          tag: 'markdown',
          content: `**风险提示**：点击下方按钮**不会**中断 CLI 任务，而是让飞书侧**同时**处理这条消息。后果：\n\n• 两端会**并行** resume 同一个会话\n• JSONL 写入可能**冲突**，上下文可能**不一致**\n\n继续发送新消息将自动取代此等待。`,
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '⚠️ 我了解风险，仍要发送' },
              type: 'danger',
              // 直接使用 cli_force_send：点击即执行强制发送
              // 不再做二次确认（用户已经看到风险说明）
              value: { type: 'cli_force_send' },
            },
          ],
        },
      ],
    };
  }

  /**
   * 二次确认卡片 - 用户点击"我了解风险"后弹出
   * 必须再次点击才真正执行强制发送
   */
  buildForceSendConfirmCard(
    sessionTitle: string,
  ): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '🔴 确认强制发送？' },
        template: 'red',
      },
      elements: [
        {
          tag: 'markdown',
          content: `会话 **"${esc(sessionTitle)}"** 强制发送将立即执行，**不可撤销**。\n\n请确认是否继续？`,
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 确认发送' },
              type: 'danger',
              value: { type: 'cli_force_send' },
            },
          ],
        },
      ],
    };
  }

  private getToolActionLabel(toolName: string): string {
    const labels: Record<string, string> = {
      Bash: 'Bash 命令',
      Edit: '文件编辑',
      Write: '文件写入',
      Read: '文件读取',
      Glob: '文件搜索',
      Grep: '内容搜索',
      WebFetch: '网络请求',
      WebSearch: '网络搜索',
    };
    return labels[toolName] ?? toolName;
  }

  dispose(): void {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
  }

  private async patchCard(card: Record<string, unknown>): Promise<void> {
    if (!this.cardMessageId) {
      logger.warn('CardUpdater: patch skipped, no cardMessageId');
      return;
    }
    const content = JSON.stringify(card);
    try {
      logger.info(`CardUpdater: patching message_id=${this.cardMessageId}, content=${content}`);
      const resp = await this.client.im.v1.message.patch({
        path: { message_id: this.cardMessageId },
        data: {
          content,
        },
      });
      logger.info(`CardUpdater: patch raw response=${JSON.stringify(resp)}`);
      const code = resp?.code ?? 'unknown';
      if (code !== 0 && code !== 'unknown') {
        throw new Error(`patch returned non-zero code=${code}, msg=${resp?.msg ?? 'unknown'}`);
      }
      logger.info(`CardUpdater: patch success, message_id=${this.cardMessageId}`);
    } catch (err: any) {
      logger.warn(`CardUpdater: patch failed: ${err.message}, message_id=${this.cardMessageId}`);
      throw err;
    }
  }

  /**
   * v2.4.x: 初始处理卡用 streaming 布局 (跟 buildStreamingCard 一致),
   * header 是 "💭 处理中" 而不是 "⏳ 正在处理...". 这样后续 updateStream
   * patch 不会改 header, 视觉更连贯。用户也直接看到流式区域, bg 一写
   * 内容就填充进去。
   */
  private buildProcessingCard(): Record<string, unknown> {
    return this.buildStreamingCard('', '', 0);
  }

  /**
   * v2.4.x: 富内容 streaming 卡片, 接收 thinking + toolUses + text + elapsedMs。
   * 渲染顺序: 思考过程 → 当前操作 (工具调用) → 回复 → 已用时。
   * 任意一段为空就跳过 (不显示空标题)。
   */
  private buildStreamingCard(
    thinking: string,
    text: string,
    elapsedMs: number,
    toolUses: Array<{ name: string; inputSummary: string }> = [],
  ): Record<string, unknown> {
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const elements: Array<Record<string, unknown>> = [];
    // Show full content but enforce byte limit to stay within Feishu's 30KB card body
    const maxThinkingBytes = Math.min(2000, this.maxCardBytes);
    const maxTextBytes = Math.min(8000, this.maxCardBytes);

    if (this.showThinking && thinking) {
      elements.push({
        tag: 'markdown',
        content: `**思考过程：**\n> ${esc(truncateBytes(thinking, maxThinkingBytes))}`,
      });
    }
    // v2.4.x: 当前操作 (工具调用) — 一个工具一行, 名字 + 摘要
    if (this.showThinking && toolUses.length > 0) {
      const lines = toolUses
        .map(t => `🔧 \`${esc(t.name)}\` ${esc(t.inputSummary)}`)
        .join('\n');
      elements.push({
        tag: 'markdown',
        content: `**当前操作：**\n${lines}`,
      });
    }
    if (text) {
      elements.push({
        tag: 'markdown',
        content: `**回复：**\n${esc(truncateBytes(text, maxTextBytes))}`,
      });
    }
    elements.push({ tag: 'markdown', content: `⏱ 已用时 ${elapsedSec}s` });
    if (this.buttonsMode === 'rendezvous') {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔙 不等了' },
            type: 'default',
            value: { tag: 'agent_view_rendezvous_abort_wait' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🛑 停 bg' },
            type: 'danger',
            value: { tag: 'agent_view_rendezvous_stop_bg_request', shortId: this.rendezvousShortId ?? '' },
          },
        ],
      });
    } else {
      elements.push({
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '🛑 停止处理' },
          type: 'danger',
          value: { tag: 'stop' },
        }],
      });
    }
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: { title: { tag: 'plain_text', content: '💭 处理中' }, template: 'blue' },
      elements,
    };
  }

  private buildCompleteCard(response: string, tokensIn: number, tokensOut: number, durationMs: number, numTurns: number): Record<string, unknown> {
    const display = this.truncateContent(response);
    const footer: string[] = [];
    const totalTokens = tokensIn + tokensOut;
    if (totalTokens > 0) footer.push(`🪙 ${formatTokenCount(totalTokens)} tokens`);
    footer.push(`⏱ 耗时: **${Math.floor(durationMs / 1000)}s**`);
    if (numTurns > 0) footer.push(`📊 轮数: **${numTurns}**`);
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: { title: { tag: 'plain_text', content: '✅ 处理完成' }, template: 'green' },
      elements: [
        { tag: 'markdown', content: esc(display) },
        { tag: 'hr' },
        { tag: 'markdown', content: footer.join('  |  ') },
      ],
    };
  }

  private buildErrorCard(message: string): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: { title: { tag: 'plain_text', content: '❌ 处理失败' }, template: 'red' },
      elements: [{ tag: 'markdown', content: `错误原因：**${esc(message)}**\n\n请检查 Claude CLI 是否可用，或稍后重试。` }],
    };
  }

  private buildCancelledCard(reason?: string): Record<string, unknown> {
    const content = reason
      ? `**${esc(reason)}**\n\n你可以随时发送新消息继续对话。`
      : '**处理已被取消。**\n\n你可以随时发送新消息继续对话。';
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: { title: { tag: 'plain_text', content: '🛑 已取消' }, template: 'grey' },
      elements: [{ tag: 'markdown', content }],
    };
  }
}

function truncateBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;

  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low) + '...';
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

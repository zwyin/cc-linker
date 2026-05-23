import { logger } from '../utils/logger';
import { config } from '../utils/config';

export type CardState = 'processing' | 'streaming' | 'complete' | 'error';

interface CardUpdaterOptions {
  throttle_ms?: number;
  max_card_bytes?: number;
  show_thinking?: boolean;
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
  private pendingUpdate: { thinking: string; text: string; elapsed: number } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly throttleMs: number;
  private readonly maxCardBytes: number;
  private readonly showThinking: boolean;
  private state: CardState = 'processing';

  constructor(client: FeishuClient, options: CardUpdaterOptions = {}) {
    this.client = client;
    this.throttleMs = options.throttle_ms ?? config.get<number>('stream.throttle_ms', 1500);
    this.maxCardBytes = options.max_card_bytes ?? config.get<number>('stream.max_card_bytes', 25000);
    this.showThinking = options.show_thinking ?? config.get<boolean>('stream.show_thinking', true);
  }

  getCardMessageId(): string | null { return this.cardMessageId; }
  getState(): CardState { return this.state; }

  async startProcessing(openId: string): Promise<string> {
    const card = this.buildProcessingCard();
    const resp = await this.client.im.v1.message.create({
      receive_id_type: 'open_id', receive_id: openId,
      msg_type: 'interactive', content: JSON.stringify(card),
    });
    this.cardMessageId = resp.data?.message_id ?? null;
    if (!this.cardMessageId) throw new Error('Failed to create processing card');
    this.state = 'processing';
    this.lastPatchAt = Date.now();
    return this.cardMessageId;
  }

  async updateStream(thinking: string, text: string, elapsedMs: number): Promise<void> {
    this.pendingUpdate = { thinking, text, elapsed: elapsedMs };
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
    const { thinking, text, elapsed } = this.pendingUpdate;
    await this.patchCard(this.buildStreamingCard(thinking, text, elapsed));
    this.pendingUpdate = null;
    this.state = 'streaming';
  }

  async complete(response: string, costUsd: number, durationMs: number, numTurns: number): Promise<void> {
    await this.flushPending();
    await this.patchCard(this.buildCompleteCard(response, costUsd, durationMs, numTurns));
    this.state = 'complete';
  }

  async error(message: string): Promise<void> {
    await this.flushPending();
    await this.patchCard(this.buildErrorCard(message));
    this.state = 'error';
  }

  shouldFallbackToText(content: string): boolean {
    return new TextEncoder().encode(content).length > this.maxCardBytes;
  }

  truncateContent(content: string): string {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(content);
    if (bytes.length <= this.maxCardBytes) return content;
    const decoder = new TextDecoder();
    let low = 0, high = bytes.length;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (decoder.decode(bytes.slice(0, mid)).length <= this.maxCardBytes) low = mid;
      else high = mid - 1;
    }
    return decoder.decode(bytes.slice(0, low)) + '...';
  }

  dispose(): void {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
  }

  private async patchCard(card: Record<string, unknown>): Promise<void> {
    if (!this.cardMessageId) return;
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: this.cardMessageId },
        data: { content: JSON.stringify(card) },
      });
    } catch (err: any) {
      logger.warn(`CardUpdater: patch failed: ${err.message}`);
    }
  }

  private buildProcessingCard(): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '⏳ 正在处理...' }, template: 'blue' },
      elements: [{ tag: 'markdown', content: 'Claude 正在处理你的请求，预计 **2-10 秒**...' }],
    };
  }

  private buildStreamingCard(thinking: string, text: string, elapsedMs: number): Record<string, unknown> {
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const elements: Array<Record<string, unknown>> = [];
    // Show full content but enforce byte limit to stay within Feishu's 30KB card body
    const maxThinkingBytes = Math.min(2000, this.maxCardBytes);
    const maxTextBytes = Math.min(8000, this.maxCardBytes);
    if (this.showThinking && thinking) {
      elements.push({ tag: 'markdown', content: `**思考过程：**\n> ${esc(truncateBytes(thinking, maxThinkingBytes))}` });
    }
    if (text) {
      elements.push({ tag: 'markdown', content: `**回复：**\n${esc(truncateBytes(text, maxTextBytes))}` });
    }
    elements.push({ tag: 'markdown', content: `⏱ 已用时 ${elapsedSec}s` });
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '💭 处理中' }, template: 'blue' },
      elements,
    };
  }

  private buildCompleteCard(response: string, costUsd: number, durationMs: number, numTurns: number): Record<string, unknown> {
    const display = this.truncateContent(response);
    const footer: string[] = [];
    if (costUsd > 0) footer.push(`💰 费用: **$${costUsd.toFixed(2)}**`);
    footer.push(`⏱ 耗时: **${Math.floor(durationMs / 1000)}s**`);
    if (numTurns > 0) footer.push(`📊 轮数: **${numTurns}**`);
    return {
      config: { wide_screen_mode: true },
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
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '❌ 处理失败' }, template: 'red' },
      elements: [{ tag: 'markdown', content: `错误原因：**${esc(message)}**\n\n请检查 Claude CLI 是否可用，或稍后重试。` }],
    };
  }
}

function esc(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncateBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  const decoder = new TextDecoder();
  let low = 0, high = bytes.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (decoder.decode(bytes.slice(0, mid)).length <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return decoder.decode(bytes.slice(0, low)) + '...';
}

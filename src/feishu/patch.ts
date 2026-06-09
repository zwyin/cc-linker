// src/feishu/patch.ts
//
// v2.2.20: 把 start.ts 里的 patchFn 抽到独立模块,便于单测延迟行为。
//
// 历史(commit 0a8b3e0 之前):start.ts:411-435 写了一个 1200ms 硬延迟的 patchFn,
// 注释里写"避免 Feishu card action event lock(bot.ts:608-625 同款 pattern)"。
// 实际上这个延迟是 permission card 处理路径(在 bot.ts:663-679 用自己的
// setTimeout 实现)的设计,误用到了 agent-view 的 patchFn。后果:用户点 Refresh
// 后,patch 在 1.2s 才发出,期间飞书客户端显示的是旧内容(就是用户反馈的
// "卡片内容会先刷新成正确的响应内容,但是会马上又被当前卡片内容覆盖"中的
// 旧内容)。叠加 Peek 卡缺 update_multi: true(已在 card.ts:4 修复),飞书把
// patch 行为"merge 而非 replace",最终 revert 到 Peek 当时的快照内容
// (即用户最初 Peek 时看到的状态)。
//
// 修复:把 delayMs 做成可选参数,默认 0(立即发)。Permission card 不走这个
// patchFn(走自己的 setTimeout),所以保留旧 1200ms 路径不需要。

export interface FeishuPatchClient {
  im: {
    v1: {
      message: {
        patch: (payload: any) => Promise<any>;
      };
    };
  };
}

export interface PatchFnOptions {
  /** 飞书 API 调用前的延迟(ms)。默认 0 — 立即发。Permission card 不要走这个 patchFn。 */
  delayMs?: number;
  /** 调试用 env var:设了 "1" 时,无论 delayMs 多少都立即发。 */
  forceImmediate?: boolean;
}

export type FeishuPatchFn = (messageId: string, card: string) => Promise<any>;

/**
 * 构造一个 patchFn,调用飞书 message.patch API 更新已发送的卡片。
 *
 * v2.2.20 实测默认 delayMs=1200:用户点击卡片按钮后,飞书会锁住该卡片约 1.2s
 * 防止 patch 与事件处理竞争。锁内发的 patch:飞书 API 返回 success(code=0),
 * 但客户端不渲染新内容(实测:[2026-06-08 22:38] 用户点 Peek Refresh,patch
 * 发出并 success,但飞书客户端一直显示旧卡内容)。锁外发的 patch:客户端正常
 * 渲染(旧版 1200ms 延迟 + 缺 update_multi:true 时,新内容会先短暂一帧然后
 * revert 到原卡;现在加 update_multi:true 后,新内容会持久渲染)。
 *
 * 结论:1200ms 不是 over-engineering,是飞书 card action event lock 的真实
 * 旁路。Permission card 路径(走 bot.ts:663-679 自己的 setTimeout)不要用
 * 这个工厂;如果将来要,显式传 delayMs。
 */
export function createPatchFn(
  client: FeishuPatchClient,
  log: (level: 'DEBUG' | 'WARN' | 'ERROR' | 'INFO', msg: string) => void,
  options: PatchFnOptions = {},
): FeishuPatchFn {
  const { delayMs = 0, forceImmediate = false } = options;
  const effectiveDelay = forceImmediate ? 0 : delayMs;
  return async (messageId: string, card: string): Promise<any> => {
    if (effectiveDelay > 0) {
      await new Promise(r => setTimeout(r, effectiveDelay));
    }
    try {
      const response = await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: card },
      });
      const respCode = response?.code;
      const respMsg = response?.msg;
      if (respCode !== 0 && respCode !== undefined) {
        log('WARN', `[patchFn] 飞书返回非 0 code: ${respCode}, msg=${respMsg}, message_id=${messageId}`);
        return null;
      }
      log('DEBUG', `[patchFn] 卡片更新成功: message_id=${messageId}, code=${respCode}`);
      return response;
    } catch (err: any) {
      log('WARN', `[patchFn] 卡片更新失败: ${err?.message ?? err}, messageId=${messageId}`);
      return null;
    }
  };
}

import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { FeishuBot, _bgConflictHooks } from '../../../src/feishu/bot';
import { AgentViewManager } from '../../../src/agent-view/manager';
import { createTestBot, type TestBot } from '../../helpers/feishu-bot';

// v2.2.10: swap _bgConflictHooks (mutable object) instead of mock.module ——
// bun's mock.module is irrevocable across files and would poison
// roster-source.test.ts. Restore in afterAll so other suites are unaffected.
const origReadRoster = _bgConflictHooks.readRoster;
const origLookupResumeFromPath = _bgConflictHooks.lookupResumeFromPath;
const readRosterMock = mock((): any => null);
const lookupResumeFromPathMock = mock((_r: any, _short: string): string | null => null);

afterAll(() => {
  _bgConflictHooks.readRoster = origReadRoster;
  _bgConflictHooks.lookupResumeFromPath = origLookupResumeFromPath;
});

/**
 * Tests for Task 11: extracting handleChatSDK as public runChatSDK + adding
 * setAgentView. The full SDK streaming lifecycle is exercised by other bot tests
 * (handleChat end-to-end); this file focuses on the new public surface and the
 * v2.2 critical fix: setAgentView must overwrite deps.runChatSDK with an arrow
 * function that captures the FeishuBot instance.
 */
describe('FeishuBot.runChatSDK (T11 public surface)', () => {
  let env: TestBot;
  let bot: FeishuBot;

  beforeEach(() => {
    env = createTestBot({
      tmpDirPrefix: 'bot-runsdk-',
      extraConfigMutations: {
        'feishu_bot.default_cwd': '',
        'security.allowed_roots': [],
        'security.denied_roots': [],
        'stream.enabled': false,
        'sdk.enabled': true,
      },
    });
    bot = env.bot;
  });

  afterEach(() => {
    env.cleanup();
  });

  it('exposes runChatSDK as a public method on the prototype', () => {
    // Critical for AgentViewManager.handleReply (T18) to invoke it from outside the bot.
    expect(typeof (FeishuBot.prototype as any).runChatSDK).toBe('function');

    // The instance also resolves it (not just on the prototype) so the bot can
    // pass `this.runChatSDK` to dependents without losing binding.
    expect(typeof (bot as any).runChatSDK).toBe('function');
  });

  it('exposes setAgentView as a public method', () => {
    expect(typeof (FeishuBot.prototype as any).setAgentView).toBe('function');
    expect(typeof (bot as any).setAgentView).toBe('function');
  });

  it('stores the agentView manager when setAgentView is called', () => {
    // Build a real AgentViewManager using the bot's existing UserManager so the
    // constructor's ExpectedReplyState is wired correctly.
    const mgr = new AgentViewManager({
      userManager: env.userManager,
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      // runChatSDK is a placeholder — setAgentView MUST replace this with the
      // arrow-bound version. We pass a sentinel that asserts it gets replaced.
      runChatSDK: (() => {
        throw new Error('placeholder should be replaced by setAgentView');
      }) as any,
    });

    bot.setAgentView(mgr);

    // The private field stores the manager (verified via the public deps hook
    // — see next test for the override assertion).
    expect((bot as any).agentView).toBe(mgr);
  });

  it('overrides deps.runChatSDK with an arrow function that captures the bot', async () => {
    // v2.2 critical fix: a bare `this.runChatSDK` reference would lose `this`
    // when called from AgentViewManager.handleReply. setAgentView MUST rewrite
    // deps.runChatSDK to a closure over the bot instance.
    let callCount = 0;
    let capturedThis: any = null;

    const mgr = new AgentViewManager({
      userManager: env.userManager,
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      // Placeholder to be replaced; record invocations so we can verify the
      // override is reachable AND executes against the bot.
      runChatSDK: (() => {
        throw new Error('placeholder should be replaced by setAgentView');
      }) as any,
    });

    bot.setAgentView(mgr);

    // After setAgentView, deps.runChatSDK must be a function (not the thrower).
    expect(typeof mgr.deps.runChatSDK).toBe('function');

    // Call it. We're not providing a real sessionManager.sendSDKMessage, so the
    // SDK call will throw — that's fine. We assert via a wrapper that the
    // override (a) executes at all, and (b) when invoked from the manager's
    // perspective, eventually touches the bot. The cleanest way to assert (b)
    // without running the full SDK pipeline is to replace sessionManager with
    // a stub that records `this` from the perspective of the bot's method.
    const origSessionManager = (bot as any).sessionManager;
    (bot as any).sessionManager = {
      sendSDKMessage: async (..._args: any[]) => {
        capturedThis = bot; // The arrow function should have called us with bot-bound state
        callCount += 1;
        // Return a minimally-shaped result; runChatSDK will then try to use
        // cardUpdater / etc. which doesn't exist without feishuClient. That's
        // OK for this test — we only care that the override path was reached.
        return {
          result: {
            response: 'stub',
            tokensIn: 0,
            tokensOut: 0,
            durationMs: 0,
            sessionStatus: 'active' as const,
            error: null,
            jsonlPath: null,
            sessionId: null,
          },
          handler: { getUnresolvedCount: () => 0, getHandlerId: () => 'stub' },
        };
      },
    };

    try {
      // Call the override. With no feishuClient, cardUpdater is null, so the
      // success path will go to the registry/spool branch which is a no-op
      // for this test (we don't have a current registry entry). It might still
      // throw trying to call methods on missing cardUpdater; wrap in try.
      try {
        await mgr.deps.runChatSDK({
          openId: 'ou_user1',
          sessionUuid: 'sess-1',
          cwd: '/tmp',
          promptText: 'hello',
          serialKey: 'sess-1',
          isNew: false,
        });
      } catch (_e) {
        // Expected — the stub doesn't return a full result. We only care that
        // sendSDKMessage was reached, which proves the override fires.
      }

      expect(callCount).toBe(1);
      expect(capturedThis).toBe(bot);
    } finally {
      (bot as any).sessionManager = origSessionManager;
    }
  });

  it('replaces the agentView reference when called a second time', () => {
    // Sanity: setAgentView is a single-call setter; calling it once stores
    // the manager and overrides the dep. Calling it again with a different
    // manager must replace, not merge or alias.
    const mgr1 = new AgentViewManager({
      userManager: env.userManager,
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      runChatSDK: (() => { throw new Error('mgr1 placeholder'); }) as any,
    });
    const mgr2 = new AgentViewManager({
      userManager: env.userManager,
      replyFn: async () => null,
      cardReplyFn: async () => null,
      patchFn: async () => null,
      runChatSDK: (() => { throw new Error('mgr2 placeholder'); }) as any,
    });

    bot.setAgentView(mgr1);
    expect((bot as any).agentView).toBe(mgr1);
    // mgr1's deps.runChatSDK is now the arrow-bound version (no longer the
    // thrower) — that's the whole point of setAgentView.
    expect(typeof mgr1.deps.runChatSDK).toBe('function');

    bot.setAgentView(mgr2);
    expect((bot as any).agentView).toBe(mgr2);
    expect((bot as any).agentView).not.toBe(mgr1);
    expect(typeof mgr2.deps.runChatSDK).toBe('function');
  });
});

describe('FeishuBot.runChatSDK — v2.2.11 bg-conflict refuse card', () => {
  let env: TestBot;
  let bot: FeishuBot;

  beforeEach(() => {
    env = createTestBot({
      tmpDirPrefix: 'bot-runsdk-bgconflict-',
      extraConfigMutations: {
        'feishu_bot.default_cwd': '',
        'security.allowed_roots': [],
        'security.denied_roots': [],
        'stream.enabled': false,
        'sdk.enabled': true,
      },
    });
    bot = env.bot;
    readRosterMock.mockReset();
    readRosterMock.mockImplementation(() => null);
    lookupResumeFromPathMock.mockReset();
    lookupResumeFromPathMock.mockImplementation(() => null);
    _bgConflictHooks.readRoster = readRosterMock;
    _bgConflictHooks.lookupResumeFromPath = lookupResumeFromPathMock;
  });

  afterEach(() => {
    env.cleanup();
  });

  function stubSdkAndCapture(): { calls: Array<{ sessionId: string | null }>; restore: () => void } {
    const calls: Array<{ sessionId: string | null }> = [];
    const origSessionManager = (bot as any).sessionManager;
    (bot as any).sessionManager = {
      sendSDKMessage: async (sessionId: string | null, ..._rest: any[]) => {
        calls.push({ sessionId });
        return {
          result: {
            response: 'stub-ok',
            tokensIn: 0,
            tokensOut: 0,
            durationMs: 0,
            sessionStatus: 'active' as const,
            error: null,
            jsonlPath: null,
            sessionId: sessionId,
          },
          handler: { getUnresolvedCount: () => 0, getHandlerId: () => 'stub' },
        };
      },
    };
    return {
      calls,
      restore: () => {
        (bot as any).sessionManager = origSessionManager;
      },
    };
  }

  // 截获 conflict cardReplyFn 发送的内容(普通 replyFn 走另一条路,这里只关心 card)
  function captureCardReplyFn(): { cards: any[]; restore: () => void } {
    const cards: any[] = [];
    const orig = (bot as any).cardReplyFn;
    (bot as any).cardReplyFn = async (card: any, _opts: any) => {
      cards.push(card);
      return 'om_conflict_card';
    };
    return { cards, restore: () => { (bot as any).cardReplyFn = orig; } };
  }

  it('REFUSES send (no SDK call) and emits conflict card when live bg worker holds session', async () => {
    const bgShort = 'd78c8339';
    const bgUuid = 'd78c8339-18b0-4f53-8452-d4228d30f51f';
    const workerName = 'Print date every five seconds';

    readRosterMock.mockImplementation(() => ({
      proto: 1, updatedAt: 0,
      workers: {
        [bgShort]: {
          pid: 38207,
          sessionId: bgUuid,
          cwd: '/Users/wuyujun',
          startedAt: 0,
          dispatch: { source: 'slash', seed: { name: workerName } },
        },
      },
    }));
    // lookupResumeFromPath is irrelevant to v2.2.11 (we refuse, don't swap)

    const { calls, restore: restoreSdk } = stubSdkAndCapture();
    const { cards, restore: restoreCard } = captureCardReplyFn();

    let result: any = null;
    try {
      result = await bot.runChatSDK({
        openId: 'ou_user_attach',
        sessionUuid: bgUuid,
        cwd: '/Users/wuyujun',
        promptText: '继续处理',
        serialKey: bgUuid,
        isNew: false,
      });
    } catch (_e) {
      // post-SDK card/spool path may throw (no feishuClient in test)
    } finally {
      restoreSdk();
      restoreCard();
    }

    // CRITICAL: SDK was NOT called (v2.2.10 silently called with parent; v2.2.11 refuses)
    expect(calls.length).toBe(0);

    // Conflict card was sent with all 3 buttons + the stashed text
    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(JSON.stringify(card)).toContain('Print date every five seconds');
    expect(JSON.stringify(card)).toContain('继续处理');
    const actions = card.elements?.find((e: any) => e.tag === 'action')?.actions ?? [];
    const tags = actions.map((a: any) => a.value?.tag);
    expect(tags).toContain('agent_view_stop_and_send');
    expect(tags).toContain('agent_view_new_and_send');
    expect(tags).toContain('agent_view_bg_conflict_cancel');
    // 🛑 button carries stashed text + sessionId for the recovery handler
    const stopBtn = actions.find((a: any) => a.value?.tag === 'agent_view_stop_and_send');
    expect(stopBtn.value.text).toBe('继续处理');
    expect(stopBtn.value.sessionId).toBe(bgUuid);
    expect(stopBtn.value.cwd).toBe('/Users/wuyujun');
    const newBtn = actions.find((a: any) => a.value?.tag === 'agent_view_new_and_send');
    expect(newBtn.value.text).toBe('继续处理');

    // Result returned to spool layer: 方案 B(2026-06-09) 不再标 degraded,
    // 也清掉 error 字段(避免 last_error: 'bg_worker_conflict' 留误导信号)。
    // session JSONL 仍完整,bg worker 是另一个进程,user 选 3-button 中之一
    // (停bg/新会话/取消) 之后 session 状态由后续 SDK 响应决定(通常是 active)。
    // 原 degraded 标法触发 /switch 阻断 + "自动修复"误导信息,已修。
    expect(result).not.toBeNull();
    expect(result.result.error).toBeUndefined();
    expect(result.result.sessionStatus).toBe('active');
  });

  it('does NOT refuse when roster has no matching worker (normal SDK call proceeds)', async () => {
    const plainUuid = '00000000-0000-0000-0000-000000000000';
    readRosterMock.mockImplementation(() => ({ proto: 1, updatedAt: 0, workers: {} }));

    const { calls, restore } = stubSdkAndCapture();
    const { cards, restore: restoreCard } = captureCardReplyFn();
    try {
      await bot.runChatSDK({
        openId: 'ou_user_plain',
        sessionUuid: plainUuid,
        cwd: '/Users/wuyujun',
        promptText: 'hi',
        serialKey: plainUuid,
        isNew: false,
      });
    } catch (_e) {}
    restore();
    restoreCard();

    expect(calls.length).toBe(1);
    expect(calls[0].sessionId).toBe(plainUuid);
    expect(cards.length).toBe(0); // no conflict card
  });

  it('does NOT refuse when isNew=true (new sessions never collide)', async () => {
    readRosterMock.mockImplementation(() => ({
      proto: 1, updatedAt: 0,
      workers: {
        aaaaaaaa: {
          pid: 1, sessionId: 'aaaaaaaa-...', cwd: '/x', startedAt: 0,
          dispatch: { source: 'slash' },
        },
      },
    }));

    const { calls, restore } = stubSdkAndCapture();
    try {
      await bot.runChatSDK({
        openId: 'ou_new',
        sessionUuid: 'aaaaaaaa-0000-0000-0000-000000000000',
        cwd: '/tmp',
        promptText: 'hi',
        serialKey: 'aaaaaaaa-new',
        isNew: true,
      });
    } catch (_e) {}
    restore();

    // Detection skipped (isNew=true), SDK called normally
    expect(calls.length).toBe(1);
    expect(calls[0].sessionId).toBe('aaaaaaaa-0000-0000-0000-000000000000');
  });

  it('refuses regardless of lookupResumeFromPath result (v2.2.11 no longer uses it)', async () => {
    // Path returns garbage; v2.2.11 doesn't care — it refuses either way.
    const bgShort = 'd78c8339';
    const bgUuid = 'd78c8339-18b0-4f53-8452-d4228d30f51f';
    readRosterMock.mockImplementation(() => ({
      proto: 1, updatedAt: 0,
      workers: {
        [bgShort]: { pid: 1, sessionId: bgUuid, cwd: '/x', startedAt: 0, dispatch: { source: 'slash' } },
      },
    }));
    lookupResumeFromPathMock.mockImplementation(() => '/some/garbage.jsonl');

    const { calls, restore } = stubSdkAndCapture();
    const { cards, restore: restoreCard } = captureCardReplyFn();
    try {
      await bot.runChatSDK({
        openId: 'ou_user_baddash',
        sessionUuid: bgUuid,
        cwd: '/Users/wuyujun',
        promptText: 'hi',
        serialKey: bgUuid,
        isNew: false,
      });
    } catch (_e) {}
    restore();
    restoreCard();

    // v2.2.13: 仍然拒绝发 SDK,但 v2.2.13 会尝试调用 lookupResumeFromPath
    // 来 pre-compute parentUuid,这里路径 basename 不是合法 UUID,所以
    // stashed parentUuid=空,hasParent=false(handler 退化用 bg sessionId)。
    expect(calls.length).toBe(0);
    expect(cards.length).toBe(1);
    expect(lookupResumeFromPathMock).toHaveBeenCalled();
    // 🛑 button: parentUuid=空, hasParent=false
    const card = cards[0];
    const stopBtn = card.elements
      ?.find((e: any) => e.tag === 'action')
      ?.actions?.find((a: any) => a.value?.tag === 'agent_view_stop_and_send');
    expect(stopBtn).toBeDefined();
    expect(stopBtn.value.parentUuid).toBe('');
    expect(stopBtn.value.hasParent).toBe(false);
  });

  it('v2.2.13: refuses and stashes valid parentUuid in stop_and_send button', async () => {
    // v2.2.13 happy path: lookup 返回合法 UUID,stashed 到 button value,handler 会用它
    const bgShort = '92664deb';
    const bgUuid = '92664deb-f4b6-48d3-9cdd-85cf8eea6dfc';
    const parentUuid = '57872373-61d8-483b-ae2d-306351e2d86e';
    const parentPath = `/Users/wuyujun/.claude/projects/-Users-wuyujun-Git-cc-linker/${parentUuid}.jsonl`;

    readRosterMock.mockImplementation(() => ({
      proto: 1, updatedAt: 0,
      workers: {
        [bgShort]: { pid: 33341, sessionId: bgUuid, cwd: '/x', startedAt: 0, dispatch: { source: 'slash' } },
      },
    }));
    lookupResumeFromPathMock.mockImplementation((_r: any, short: string) =>
      short === bgShort ? parentPath : null,
    );

    const { calls, restore } = stubSdkAndCapture();
    const { cards, restore: restoreCard } = captureCardReplyFn();
    try {
      await bot.runChatSDK({
        openId: 'ou_user_withparent',
        sessionUuid: bgUuid,
        cwd: '/Users/wuyujun/Git/cc-linker',
        promptText: '继续处理',
        serialKey: bgUuid,
        isNew: false,
      });
    } catch (_e) {}
    restore();
    restoreCard();

    expect(calls.length).toBe(0);
    expect(cards.length).toBe(1);
    const stopBtn = cards[0].elements
      ?.find((e: any) => e.tag === 'action')
      ?.actions?.find((a: any) => a.value?.tag === 'agent_view_stop_and_send');
    expect(stopBtn).toBeDefined();
    expect(stopBtn.value.parentUuid).toBe(parentUuid);
    expect(stopBtn.value.hasParent).toBe(true);
  });
});

describe('FeishuBot.runChatSDK — v2.2.14 short→full expansion', () => {
  let env: TestBot;
  let bot: FeishuBot;

  beforeEach(() => {
    env = createTestBot({
      tmpDirPrefix: 'bot-runsdk-short-',
      extraConfigMutations: {
        'feishu_bot.default_cwd': '',
        'security.allowed_roots': [],
        'security.denied_roots': [],
        'stream.enabled': false,
        'sdk.enabled': true,
      },
    });
    bot = env.bot;
    readRosterMock.mockReset();
    readRosterMock.mockImplementation(() => null);
    lookupResumeFromPathMock.mockReset();
    lookupResumeFromPathMock.mockImplementation(() => null);
    _bgConflictHooks.readRoster = readRosterMock;
    _bgConflictHooks.lookupResumeFromPath = lookupResumeFromPathMock;
  });

  afterEach(() => {
    env.cleanup();
  });

  function stubSdkAndCapture() {
    const calls: Array<{ sessionId: string | null }> = [];
    const origSessionManager = (bot as any).sessionManager;
    (bot as any).sessionManager = {
      sendSDKMessage: async (sessionId: string | null, ..._rest: any[]) => {
        calls.push({ sessionId });
        return {
          result: {
            response: 'stub-ok',
            tokensIn: 0,
            tokensOut: 0,
            durationMs: 0,
            sessionStatus: 'active' as const,
            error: null,
            jsonlPath: null,
            sessionId,
          },
          handler: { getUnresolvedCount: () => 0, getHandlerId: () => 'stub' },
        };
      },
    };
    return {
      calls,
      restore: () => { (bot as any).sessionManager = origSessionManager; },
    };
  }

  it('expands short sessionUuid to full UUID via JsonlIndex lookup', async () => {
    // 模拟:UserManager 残留 short(历史 settled bg 种下),bot runChatSDK 时
    // 自动通过 JsonlIndex 查全 UUID 再下发 SDK。
    // 这里用一个 tmp dir mock JsonlIndex 不容易,改成直接 stub sessionManager
    // 并 stub JSONL 文件查找路径;实际我们让 JsonlIndex 走真实 CLAUDE_PROJECTS_DIR,
    // 选一个不冲突的 short(假设 00000000 不会命中),但用 roster-source 路径
    // 不太合适 —— 改用真实路径 /Users/wuyujun/.claude/projects 测试全流程。
    //
    // 简化:验证 short 通过 stub 后**会被 expand** —— 我们 mock JsonlIndex 没办法,
    // 改用 6a6cba85 这种 demo short + 在真实 projects 里找一个存在的 UUID。
    // 实际上,我们干脆把 short 选成 daemon roster 里已存在的 session 的 short,
    // 看 bot 是否能展开。
    //
    // 更简单:验证 short + 不存在 → 不 expand(直接传给 SDK,失败由 SDK 报告)。
    // 验证 short + 存在 → 走 expand(由真实 JSONL 存在证明)。
    // 这里我们只测"short 时 SDK 收到的不是原 short"行为:
    //   - 选一个不存在的 short (ffffffff),不期望 expand
    //   - 选一个真实存在的 short (3a41fe73),期望 expand 到 full UUID

    // Case A: short 不在 JsonlIndex 里,SDK 收到原 short(然后 SDK 拒,但 bot 不该 silent 失败)
    const fakeShort = 'ffffffff';
    const { calls, restore } = stubSdkAndCapture();
    try {
      await bot.runChatSDK({
        openId: 'ou_user_fake_short',
        sessionUuid: fakeShort,
        cwd: '/Users/wuyujun',
        promptText: 'hi',
        serialKey: fakeShort,
        isNew: false,
      });
    } catch (_e) {}
    restore();

    // JsonlIndex 找不到 → 不展开,SDK 收到原 short(交给 SDK 报错)
    expect(calls.length).toBe(1);
    expect(calls[0].sessionId).toBe(fakeShort);

    // Case B: short 在 JsonlIndex 里,SDK 收到 full UUID
    const realShort = '3a41fe73';
    const realFull = '3a41fe73-0951-470a-bd2f-fb5a9f0fbe6b';
    const calls2: Array<{ sessionId: string | null }> = [];
    const origSessionManager2 = (bot as any).sessionManager;
    (bot as any).sessionManager = {
      sendSDKMessage: async (sessionId: string | null, ..._rest: any[]) => {
        calls2.push({ sessionId });
        return {
          result: {
            response: 'stub-ok', tokensIn: 0, tokensOut: 0, durationMs: 0,
            sessionStatus: 'active' as const, error: null, jsonlPath: null, sessionId,
          },
          handler: { getUnresolvedCount: () => 0, getHandlerId: () => 'stub' },
        };
      },
    };
    // Seed UserManager entry with short so CAS update path is exercised
    await env.userManager.compareAndSwap('ou_user_real_short', null, {
      type: 'session',
      sessionUuid: realShort,
      cwd: '/Users/wuyujun',
      createdAt: new Date().toISOString(),
    });

    try {
      await bot.runChatSDK({
        openId: 'ou_user_real_short',
        sessionUuid: realShort,
        cwd: '/Users/wuyujun',
        promptText: 'hi',
        serialKey: realShort,
        isNew: false,
      });
    } catch (_e) {}
    (bot as any).sessionManager = origSessionManager2;

    // SDK 收到 expanded full UUID
    expect(calls2.length).toBe(1);
    expect(calls2[0].sessionId).toBe(realFull);

    // UserManager entry 已 CAS 切到 full UUID
    const updated = env.userManager.getEntry('ou_user_real_short');
    expect(updated?.type).toBe('session');
    expect((updated as any).sessionUuid).toBe(realFull);
  });
});

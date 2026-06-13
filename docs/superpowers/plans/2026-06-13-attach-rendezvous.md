# Agent View Attach: Rendezvous Socket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After user attaches to a background session via `/agents → Attach`, sending chat text should use the rendezvous socket (re-using the v2.4 Reply pipeline) when the bg is in any non-busy state (waiting / done / stopped / idle), eliminating the false-positive "CLI 侧会话处理中" busy card.

**Architecture:** Add an `attachedAt?: string` field to existing `MappingEntry` (semantically distinct from `session` via metadata, not a new type). `manager.handleAttach` sets it; `manager.handleBackToChat` / `handleStopWatching` clear it. `bot.ts handleChat` checks the field — if set AND bg is not busy (per refined eligibility), it short-circuits to the existing `tryRendezvousReply` path with a new `fromAttachedChat: true` flag (parallel to existing `fromAgentViewReply`). The eligibility check in `rendezvous-fallback.ts` is refined: bg in `done` / `stopped` / `idle` is now eligible (`reason: 'bg_resumable'`) — probe proved daemon respawns the worker and processes the reply.

**Tech Stack:** Bun + TypeScript + bun:test. No new dependencies. Reuses `RendezvousClient`, `checkRendezvousEligibility`, `tryRendezvousReply` from v2.4.

**Spec / Evidence:**
- `docs/qa/2026-06-11-rendezvous-probe-notes.md` (probe 3: stopped → respawn)
- Probe results from this session: `4d9df1d2` (done) and `e36ed632` (done) both respawned + processed the sentinel reply
- Existing v2.4 reply plan: `docs/superpowers/plans/2026-06-11-rendezvous-reply.md`
- Existing v2.4 reply design: `docs/superpowers/specs/2026-06-11-rendezvous-reply-design.md`

---

## File Structure

```
src/agent-view/
├── rendezvous-fallback.ts        [MOD]  add 'bg_resumable' reason + refined state check
├── manager.ts                    [MOD]  handleAttach sets attachedAt; handleAttachedChat method; handleBackToChat / handleStopWatching clear it; AgentViewDeps.isAttachedChat getter
└── expected-reply-state.ts       [MOD]  no change to interface; manager-level coordination only
src/feishu/
├── mapping.ts                    [MOD]  add attachedAt?: string to MappingEntry (optional field, default undefined = backward-compatible)
├── bot.ts                        [MOD]  runChatSDK accepts fromAttachedChat param; handleChat routes attached → rendezvous
└── card-updater.ts               no change
src/utils/
└── config.ts                     no change (reuses rendezvous_enabled + rendezvous_timeout_ms)
docs/qa/
└── 2026-06-13-attach-rendezvous-probe-notes.md  [NEW]  probe evidence

scripts/
└── probe-rendezvous-non-waiting.ts  [NEW]  diagnostic probe script (already created in this session)

tests/unit/agent-view/
├── rendezvous-fallback.test.ts   [MOD]  add 4 cases for bg_resumable + busy-deny
├── manager.test.ts               [MOD]  add 3 cases for attachedAt lifecycle
└── ...
tests/unit/feishu/
└── bot-handlechat-routing.test.ts [MOD]  add 2 cases for handleChat routing attached entry to rendezvous path
```

PR cut: PR 1 (Tasks 0-2) ships probe + eligibility refinement (foundation, no user-visible change). PR 2 (Tasks 3-5) wires attached-session through manager + bot. PR 3 (Task 6) is local manual E2E.

---

## PR 1: Foundation (probe + eligibility refinement)

### Task 0: Commit the probe script + write probe notes doc

**Files:**
- Already created: `scripts/probe-rendezvous-non-waiting.ts`
- Create: `docs/qa/2026-06-13-attach-rendezvous-probe-notes.md`

- [ ] **Step 1: Confirm probe script is in place**

Run: `ls -la scripts/probe-rendezvous-non-waiting.ts`
Expected: file exists (created earlier this session).

- [ ] **Step 2: Write probe notes doc**

Create `docs/qa/2026-06-13-attach-rendezvous-probe-notes.md`:

```markdown
# Attach Rendezvous Probe — Empirical Evidence (2026-06-13)

## Context

Goal: confirm that injecting `{type:"reply", text}` to a bg worker's rendezvous
socket causes the daemon to respawn the worker + process the input — even when
the bg is in `done` / `idle` / `stopped` state, not just `waiting` (Reply's only
eligible state today).

This is a prerequisite for letting Attach + chat use the rendezvous path
instead of going through the false-positive busy card on CPU jitter.

## Test environment

- Claude CLI 2.1.163 (Mach-O 64-bit arm64, /usr/local/bin/claude)
- OS: macOS Darwin 24.6.0
- Probe script: `scripts/probe-rendezvous-non-waiting.ts`
- Pre-existing candidates (no synthetic bg created — used real fleet bg that had
  settled to done state naturally):

| short | state | tempo | source | rendezvousSock |
|---|---|---|---|---|
| 4d9df1d2 | done | idle | fleet | ✓ |
| e36ed632 | done | idle | fleet | ✓ |
| (8 other done/idle bg) | done | idle | fleet | ✗ (no sock — supervisor cleaned up) |
| (2 stopped bg) | stopped | idle | (settled) | ✗ (no sock) |

## Probe 1: Dry-run inject on done bg → respawn confirmed

```bash
bun run scripts/probe-rendezvous-non-waiting.ts
```

For `4d9df1d2` (done/idle, fleet source):
- Connect to rendezvousSock: ✓
- Write `{"type":"reply","text":"__PROBE_SENTINEL_mqbp8efi__"}`
- Daemon returns ack: `{"type":"state","patch":{"tempo":"active","needs":""}}`
- Bot immediately closes (dry-run mode)

**Post-condition (~3s later)**:
- `~/.claude/jobs/4d9df1d2/state.json` transitioned:
  - `state`: `done` → `blocked`
  - `tempo`: `idle` → `blocked`
  - `needs`: null → `"收到探针信号 \`__PROBE_SENTINEL_mqbp8efi__\`。有什么需要我帮忙的吗？"`
  - `linkScanPath`: populated (was null while idle)
- `~/.claude/projects/-Users-wuyujun/4d9df1d2-3319-4535-a175-f8011b0db673.jsonl`
  last 4 lines:
  ```
  user         role=user       | __PROBE_SENTINEL_mqbp8efi__
  assistant    role=assistant  |
  assistant    role=assistant  | 收到探针信号 `__PROBE_SENTINEL_mqbp8efi__`。有什么需要我帮忙的吗？
  system       role=?          |
  ```

For `e36ed632` (done/idle, fleet source): same pattern, different model (qwen3.6
per respawnFlags). The bg wrote a similar assistant turn that explicitly
mentions the sentinel.

## Probe 2: Other states (no candidates available)

The current machine had no `running`/`working` bg with active rendezvousSock
to probe the busy case. Probe 5 from the original notes
(`docs/qa/2026-06-11-rendezvous-probe-notes.md:67-73`) already covers this:
the daemon protocol only recognizes `{type:"reply"}`; other types are silently
dropped. Since `running`/`working` bg is already processing the previous turn,
injecting a second reply would either queue, drop, or be accepted as a new turn
(speculative). For safety, we **deny** rendezvous eligibility when bg is in
`running`/`working` (handled by refined eligibility in Task 1).

## Conclusions

1. **bg in `done` state with active rendezvousSock → respawn + process.** Probe
   definitively proved this for fleet bg sessions on CLI 2.1.163.

2. **Eligibility for Attach + chat should be broadened** from "waiting only" to
   "any non-busy state with valid rendezvousSock". The daemon handles respawn
   transparently.

3. **No protocol change needed.** `{type:"reply",text}` is the only message
   type we ever need to send; the daemon decides whether to respawn based on
   current bg state.

4. **Implication for `running`/`working` bg:** refuse rendezvous; user must go
   through existing bg-conflict / force-send path.
```

- [ ] **Step 3: Commit probe artifacts**

```bash
git add scripts/probe-rendezvous-non-waiting.ts docs/qa/2026-06-13-attach-rendezvous-probe-notes.md
git commit -m "feat(probe): non-waiting rendezvous probe + evidence doc

Probe proved done bg respawns + processes injected reply.
Foundation for letting Attach+chat use rendezvous instead of
false-positive busy card.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 1: Refine `checkRendezvousEligibility` to add `bg_resumable` reason

**Files:**
- Modify: `src/agent-view/rendezvous-fallback.ts` (refine eligibility logic)
- Modify: `tests/unit/agent-view/rendezvous-fallback.test.ts` (add cases for new reason)

The current logic at `rendezvous-fallback.ts:77-85` rejects any bg not in `waiting` state with reason `'bg_busy'`. We split this into two cases:
- `running` / `working` (no needs) → `'bg_busy'` (still rejected; concurrent turn risk)
- `done` / `stopped` / `idle` / `blocked` → eligible with new reason `'bg_resumable'`

- [ ] **Step 1: Read current eligibility logic**

Read `src/agent-view/rendezvous-fallback.ts:77-85` to confirm current behavior.

- [ ] **Step 2: Write failing test for new `bg_resumable` reason**

Open `tests/unit/agent-view/rendezvous-fallback.test.ts` (existing test file from v2.4 plan Task 2). Append a new describe block:

```typescript
describe('checkRendezvousEligibility - bg_resumable (Attach path, v2.4.x)', () => {
  let ccHome: string;

  beforeEach(() => {
    ccHome = mkdtempSync(join(tmpdir(), 'cc-rendezvous-resumable-test-'));
    mkdirSync(join(ccHome, 'jobs', 'dcb2ec25'), { recursive: true });
    mkdirSync(join(ccHome, 'daemon'), { recursive: true });
  });

  afterEach(() => {
    if (ccHome) rmSync(ccHome, { recursive: true, force: true });
  });

  function writeState(state: any) {
    writeFileSync(join(ccHome, 'jobs', 'dcb2ec25', 'state.json'), JSON.stringify(state));
  }
  function writeRoster(roster: any) {
    writeFileSync(join(ccHome, 'daemon', 'roster.json'), JSON.stringify(roster));
  }
  function writeSocket() {
    fs.symlinkSync('/tmp/whatever', join(ccHome, 'daemon', 'rv-dcb2ec25.sock'));
  }

  test('bg done (settled) + socket exists → canUse, reason=bg_resumable', async () => {
    writeState({
      state: 'done',
      tempo: 'idle',
      needs: null,
      linkScanPath: '/tmp/x.jsonl',
      cliVersion: '2.1.163',
    });
    writeRoster({
      workers: {
        dcb2ec25: {
          cliVersion: '2.1.163',
          rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock'),
        },
      },
    });
    writeSocket();

    const r = await checkRendezvousEligibility('dcb2ec25', {
      jobsDir: join(ccHome, 'jobs'),
      rosterPath: join(ccHome, 'daemon', 'roster.json'),
    });
    expect(r.canUse).toBe(true);
    expect(r.reason).toBe('bg_resumable');
    expect(r.rendezvousSock).toBe(join(ccHome, 'daemon', 'rv-dcb2ec25.sock'));
    expect(r.jsonlPath).toBe('/tmp/x.jsonl');
  });

  test('bg stopped (user killed) + socket exists → canUse, reason=bg_resumable', async () => {
    writeState({ state: 'stopped', tempo: 'idle', detail: 'killed', needs: null });
    writeRoster({
      workers: {
        dcb2ec25: {
          cliVersion: '2.1.163',
          rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock'),
        },
      },
    });
    writeSocket();

    const r = await checkRendezvousEligibility('dcb2ec25', {
      jobsDir: join(ccHome, 'jobs'),
      rosterPath: join(ccHome, 'daemon', 'roster.json'),
    });
    expect(r.canUse).toBe(true);
    expect(r.reason).toBe('bg_resumable');
  });

  test('bg running (busy, no needs) → bg_busy (still denied — concurrent turn risk)', async () => {
    writeState({ state: 'running', tempo: 'active', needs: null });
    writeRoster({
      workers: {
        dcb2ec25: {
          cliVersion: '2.1.163',
          rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock'),
        },
      },
    });
    writeSocket();

    const r = await checkRendezvousEligibility('dcb2ec25', {
      jobsDir: join(ccHome, 'jobs'),
      rosterPath: join(ccHome, 'daemon', 'roster.json'),
    });
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('bg_busy');
  });

  test('bg working (busy, no needs) → bg_busy', async () => {
    writeState({ state: 'working', tempo: 'active', needs: null });
    writeRoster({
      workers: {
        dcb2ec25: {
          cliVersion: '2.1.163',
          rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock'),
        },
      },
    });
    writeSocket();

    const r = await checkRendezvousEligibility('dcb2ec25', {
      jobsDir: join(ccHome, 'jobs'),
      rosterPath: join(ccHome, 'daemon', 'roster.json'),
    });
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('bg_busy');
  });
});
```

Note: the v2.4 plan's test file uses `ccHomeDir: ccHome` — check your existing
file. The probe script we just committed uses `jobsDir` + `rosterPath` (more
explicit). Adapt the test signature to match whatever `checkRendezvousEligibility`
currently accepts. If neither matches, you'll need to adjust the production code
in Step 4 to accept the matching context type.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/agent-view/rendezvous-fallback.test.ts 2>&1 | tail -10`
Expected: FAIL (the new `bg_resumable` cases fail with `reason: 'bg_busy'`).

- [ ] **Step 4: Refine eligibility logic**

In `src/agent-view/rendezvous-fallback.ts`, modify the bg state check (around line 77-85):

```typescript
  // 2. bg state check (refined for Attach path, v2.4.x)
  // - blocked (with or without needs) → eligible (existing waiting case)
  // - done / stopped → eligible (daemon respawns worker; probe 2026-06-13)
  // - tempo=idle → eligible (effectively same as done)
  // - running / working without needs → bg_busy (concurrent turn risk)
  // - running / working with needs → eligible (existing waiting case)
  const isResumable = (() => {
    if (state.state === 'done') return true;
    if (state.state === 'stopped') return true;
    if (state.tempo === 'idle' && state.state !== 'done') return true;
    if (state.state === 'blocked') return true;
    if ((state.state === 'running' || state.state === 'working') && state.needs) return true;
    return false;
  })();
  const isBusy = state.state === 'running' || state.state === 'working';
  if (isBusy) {
    return { canUse: false, reason: 'bg_busy' };
  }
  if (!isResumable) {
    return { canUse: false, reason: 'bg_busy' };
  }
```

Wait — `isBusy` is subsumed by `!isResumable` (busy without needs is the only non-resumable case besides future unknown states). The logic simplifies to:

```typescript
  // 2. bg state check (refined for Attach path, v2.4.x)
  // Eligible states (probe 2026-06-13 + probe 3 2026-06-11):
  //   - blocked (waiting for user input)
  //   - done / stopped / tempo=idle (daemon respawns worker on reply inject)
  // Ineligible:
  //   - running / working without needs (bg processing, concurrent turn risk)
  //   - unknown future states (forward-compat: fail safe)
  const isEligible = (() => {
    if (state.state === 'blocked') return true;
    if (state.state === 'done') return true;
    if (state.state === 'stopped') return true;
    if (state.tempo === 'idle' && state.state !== 'done') return true;
    if ((state.state === 'running' || state.state === 'working') && state.needs) return true;
    return false;
  })();
  if (!isEligible) {
    return { canUse: false, reason: 'bg_busy' };
  }
```

Then update the success return (around line 110-117) to use `'bg_resumable'`
when the bg is in a non-blocked state:

```typescript
  // Decide the success reason:
  //   - 'bg_waiting' → bg was already waiting for user input (existing case)
  //   - 'bg_resumable' → bg was done/stopped/idle, daemon will respawn (new)
  const reason: 'bg_waiting' | 'bg_resumable' =
    (state.state === 'blocked' || state.needs) ? 'bg_waiting' : 'bg_resumable';

  return {
    canUse: true,
    reason,
    rendezvousSock: sock,
    jsonlPath: state.linkScanPath ?? undefined,
    stateJsonPath: jobsDir,
  };
```

- [ ] **Step 5: Update `IneligibleReason` type union if needed**

The `'bg_resumable'` reason is NOT ineligible (it's the success reason). No
type change needed for `IneligibleReason`. But `RendezvousEligibility.reason`
needs the union updated:

```typescript
export interface RendezvousEligibility {
  canUse: boolean;
  reason: 'bg_waiting' | 'bg_resumable' | IneligibleReason;
  rendezvousSock?: string;
  jsonlPath?: string;
  stateJsonPath?: string;
}
```

(If `stateJsonPath` is not already on the interface in your checkout, add it
to match v2.4 design's RendezvousClient state-json polling support.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/unit/agent-view/rendezvous-fallback.test.ts 2>&1 | tail -10`
Expected: PASS (existing 10 + new 4 = 14 pass, 0 fail).

- [ ] **Step 7: Typecheck and commit**

```bash
bun run typecheck
git add src/agent-view/rendezvous-fallback.ts tests/unit/agent-view/rendezvous-fallback.test.ts
git commit -m "feat(agent-view): bg_resumable eligibility (Attach path)

Probe 2026-06-13 proved daemon respawns bg worker on reply inject
when bg is done/stopped/idle. Refine eligibility to allow these
states; running/working (no needs) still denied as bg_busy.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Update `tryRendezvousReply` callers to handle new `bg_resumable` reason

**Files:**
- Modify: `src/feishu/bot.ts:1426-1428` (logger message uses old reason)

- [ ] **Step 1: Update logger message**

In `src/feishu/bot.ts`, find the line:

```typescript
logger.info(
  `rendezvous: inject short=${short} text_len=${promptText.length} reason=bg_waiting`,
);
```

Replace with:

```typescript
logger.info(
  `rendezvous: inject short=${short} text_len=${promptText.length} reason=${eligibility.reason}`,
);
```

(`eligibility.reason` is now `bg_waiting` or `bg_resumable` — log reflects the truth.)

- [ ] **Step 2: Verify nothing else breaks**

Run: `bun test tests/unit/feishu/ 2>&1 | tail -10`
Expected: PASS (no behavior change for Reply path; only logging string change).

- [ ] **Step 3: Commit**

```bash
git add src/feishu/bot.ts
git commit -m "chore(agent-view): log new bg_resumable eligibility reason

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## PR 2: Wire attached_session through manager + bot

### Task 3: Add `attachedAt` field to MappingEntry

**Files:**
- Modify: `src/feishu/mapping.ts:16-32` (add field to interface)

- [ ] **Step 1: Add `attachedAt?: string` field**

In `src/feishu/mapping.ts`, modify the `MappingEntry` interface (around line 16-32):

```typescript
export interface MappingEntry {
  type: MappingEntryType;
  sessionUuid: string | null;
  createdAt: string;
  casToken?: string; // I3: Unique CAS token to prevent ABA race (auto-generated)
  cwd?: string; // I4: Working directory for new sessions (set by /new)
  lastActiveAt?: string;
  claimedByMessageId?: string;
  claimedAt?: string;
  defaultProvider?: string; // User's default model alias (user-level config)
  // ===== Agent View 新增字段 =====
  shortId?: string;          // pending_agent_reply: background session short hash
  startedAt?: string;        // pending_agent_reply: ISO 启动时间
  timeoutMs?: number;        // pending_agent_reply: 超时毫秒
  cardMessageId?: string;    // last_agent_list_card: 飞书卡片 message_id
  updatedAt?: string;        // last_agent_list_card: ISO 更新时间
  // v2.4.x (Attach path): 标识 entry 是通过 handleAttach 写入的,后续发消息走 rendezvous
  attachedAt?: string;       // ISO 时间;null/undefined = 普通 session(非 attached)
}
```

- [ ] **Step 2: Verify backward-compat by typecheck**

Run: `bun run typecheck`
Expected: clean (adding optional field is backward-compatible — existing entries
without `attachedAt` will have `undefined`, equivalent to not-set).

- [ ] **Step 3: Commit**

```bash
git add src/feishu/mapping.ts
git commit -m "feat(mapping): attachedAt field on MappingEntry

Distinguishes Attach-written session entries (rendezvous-eligible)
from regular /new-written entries (busy-checked). Optional field
preserves backward-compat with existing mapping.json files.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: `handleAttach` writes `attachedAt`; cleanup methods clear it

**Files:**
- Modify: `src/agent-view/manager.ts:542-549` (`handleAttach` adds `attachedAt`)
- Modify: `src/agent-view/manager.ts:998-1004` (`handleBackToChat` clears `attachedAt`)
- Modify: `src/agent-view/manager.ts:1007-1010` (`handleStopWatching` clears `attachedAt`)
- Modify: `tests/unit/agent-view/manager.test.ts` (add lifecycle cases)

- [ ] **Step 1: Write failing test for `attachedAt` set on handleAttach**

Open `tests/unit/agent-view/manager.test.ts`. Find the existing
`describe('AgentViewManager.handleAttach', ...)` block. Append:

```typescript
  test('handleAttach sets attachedAt on UserManager entry', async () => {
    // ... use existing createTestAgentView helper from this file ...
    const result = await mgr.handleAttach('ou_a', 'full-uuid-1234', 'abc12345', 'test-bg', '/tmp');
    expect(result).not.toBeNull();
    const entry = userManager.getEntry('ou_a');
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('session');
    expect(entry!.sessionUuid).toBe('full-uuid-1234');
    expect(entry!.attachedAt).toBeDefined();
    // ISO 8601 sanity check
    expect(() => new Date(entry!.attachedAt!).toISOString()).not.toThrow();
  });

  test('handleBackToChat clears attachedAt but preserves session entry', async () => {
    await mgr.handleAttach('ou_a', 'full-uuid-1234', 'abc12345', 'test-bg', '/tmp');
    const before = userManager.getEntry('ou_a');
    expect(before?.attachedAt).toBeDefined();
    await mgr.handleBackToChat('ou_a');
    // session entry 保留(用户仍绑这个 bg),只清 attachedAt
    const after = userManager.getEntry('ou_a');
    expect(after).toBeDefined();
    expect(after?.sessionUuid).toBe('full-uuid-1234');
    expect(after?.attachedAt).toBeUndefined();
  });

  test('handleStopWatching clears attachedAt', async () => {
    await mgr.handleAttach('ou_a', 'full-uuid-1234', 'abc12345', 'test-bg', '/tmp');
    expect(userManager.getEntry('ou_a')!.attachedAt).toBeDefined();
    await mgr.handleStopWatching('ou_a');
    // entry's attachedAt should be cleared (keep session entry, drop attached flag)
    const entry = userManager.getEntry('ou_a');
    expect(entry).toBeDefined();
    expect(entry!.attachedAt).toBeUndefined();
  });
```

(Adapt to match existing test setup helpers in the file. If `mgr.handleAttach`
returns different type, adjust accordingly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent-view/manager.test.ts 2>&1 | tail -10`
Expected: FAIL — `entry.attachedAt` is `undefined` because handleAttach doesn't set it.

- [ ] **Step 3: Update `handleAttach` to set `attachedAt`**

In `src/agent-view/manager.ts`, find the CAS 2 block (around line 542-549):

```typescript
    // 3. CAS 2: 写新 session entry
    const newEntry: MappingEntry = {
      type: 'session',
      sessionUuid: sessionId,
      cwd,
      createdAt: new Date().toISOString(),
      // 保留用户级 defaultProvider,不要因 attach 丢失
      defaultProvider: oldEntry?.defaultProvider,
    };
```

Replace with:

```typescript
    // 3. CAS 2: 写新 session entry
    const newEntry: MappingEntry = {
      type: 'session',
      sessionUuid: sessionId,
      cwd,
      createdAt: new Date().toISOString(),
      // 保留用户级 defaultProvider,不要因 attach 丢失
      defaultProvider: oldEntry?.defaultProvider,
      // v2.4.x: 标记 attached entry,后续 chat 走 rendezvous 路径
      attachedAt: new Date().toISOString(),
    };
```

- [ ] **Step 4: Update `handleBackToChat` to clear `attachedAt`**

In `src/agent-view/manager.ts`, find `handleBackToChat` (around line 998-1004):

```typescript
  async handleBackToChat(openId: string): Promise<void> {
    await this.expectedReply.clear(openId, 'overwrite');
    await this.deps.replyFn(
      '已退出 Agent View,继续发送消息或 / 命令即可。下次进 /agents 视图重新打 /agents。',
      { openId },
    );
  }
```

This already does `expectedReply.clear`. To clear `attachedAt`, we need to
either (a) clear the whole entry via CAS null (changes behavior — user loses
session binding), or (b) keep the entry but null out attachedAt.

Option (b) is safer — user can still chat normally after BackToChat.

Replace with:

```typescript
  async handleBackToChat(openId: string): Promise<void> {
    await this.expectedReply.clear(openId, 'overwrite');
    // v2.4.x: 清 attachedAt 但保留 session entry,后续 chat 走原 busy-check 路径
    const entry = this.deps.userManager.getEntry(openId);
    if (entry?.attachedAt) {
      const cleared: MappingEntry = { ...entry };
      delete cleared.attachedAt;
      await this.deps.userManager.compareAndSwap(openId, entry, cleared);
    }
    await this.deps.replyFn(
      '已退出 Agent View,继续发送消息或 / 命令即可。下次进 /agents 视图重新打 /agents。',
      { openId },
    );
  }
```

- [ ] **Step 5: Update `handleStopWatching` to clear `attachedAt`**

In `src/agent-view/manager.ts`, find `handleStopWatching` (around line 1007-1010):

```typescript
  /** [Stop Watching] 按钮 handler */
  async handleStopWatching(openId: string): Promise<null> {
    await this.attachedWatchers.stop(openId, 'user_stop', { patchFinal: true });
    return null;
  }
```

Replace with:

```typescript
  /** [Stop Watching] 按钮 handler */
  async handleStopWatching(openId: string): Promise<null> {
    await this.attachedWatchers.stop(openId, 'user_stop', { patchFinal: true });
    // v2.4.x: 停止 watching 后,清 attachedAt 但保留 session entry
    // (跟 handleBackToChat 一致逻辑 — 用户没说要离开 session,只是不想再 watch)
    const entry = this.deps.userManager.getEntry(openId);
    if (entry?.attachedAt) {
      const cleared: MappingEntry = { ...entry };
      delete cleared.attachedAt;
      await this.deps.userManager.compareAndSwap(openId, entry, cleared);
    }
    return null;
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/unit/agent-view/manager.test.ts 2>&1 | tail -10`
Expected: PASS (existing + 3 new cases pass).

- [ ] **Step 7: Commit**

```bash
git add src/agent-view/manager.ts tests/unit/agent-view/manager.test.ts
git commit -m "feat(agent-view): attachedAt lifecycle in handleAttach/BackToChat/StopWatching

handleAttach writes attachedAt to mark entry as rendezvous-eligible.
handleBackToChat + handleStopWatching clear it but preserve session
binding (user keeps the session, just exits attached-chat mode).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: `handleChat` routes `attached` entry → rendezvous path

**Files:**
- Modify: `src/feishu/bot.ts:1031-1078` (`handleChat` checks `attachedAt`)
- Modify: `src/feishu/bot.ts:1696-1750` (`runChatSDK` accepts new `fromAttachedChat` param)
- Modify: `tests/unit/feishu/bot-handlechat-routing.test.ts` (add routing test)

This is the wiring task. The change is local: before the busy-check at
`bot.ts:1037`, add a check for `attachedAt`. If set, route to `runChatSDK`
with `fromAttachedChat: true` flag, skipping the busy check entirely.

- [ ] **Step 1: Write failing test for routing**

Open `tests/unit/feishu/bot-handlechat-routing.test.ts`. Find the existing
`FeishuBot.handleChat routing with expectedReply (T23)` describe block. Append
the new cases (adapt to the file's existing `makeSpoolMessage`, `bot`, and
`userManager` setup — they're already imported and initialized in `beforeEach`):

```typescript
  test('handleChat: entry with attachedAt → runChatSDK with fromAttachedChat=true (skip busy check)', async () => {
    // Setup: user entry is 'session' with attachedAt set
    userManager.compareAndSwap('ou_a', null, {
      type: 'session',
      sessionUuid: 'full-uuid-1234',
      cwd: '/tmp',
      createdAt: new Date().toISOString(),
      attachedAt: new Date().toISOString(),  // ← marks as attached
    });

    // Spy on runChatSDK to capture the call
    let capturedParams: any = null;
    bot.runChatSDK = async (params: any) => {
      capturedParams = params;
      return {
        result: { response: 'ok', sessionStatus: 'active' } as any,
        handler: {} as any,
        cardMessageId: 'card-1',
        rendezvousHandled: false,
      };
    };

    // Send a regular chat message
    await bot.handleChat({
      messageId: 'm1',
      openId: 'ou_a',
      text: 'hi',
      serialKey: 'session:full-uuid-1234',
      target: { type: 'session', sessionUuid: 'full-uuid-1234', cwd: '/tmp' },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    // Verify: runChatSDK was called with fromAttachedChat=true
    expect(capturedParams).not.toBeNull();
    expect(capturedParams.fromAttachedChat).toBe(true);
  });

  test('handleChat: entry WITHOUT attachedAt → busy check runs (regression)', async () => {
    // Setup: user entry is 'session' WITHOUT attachedAt (regular /new session)
    userManager.compareAndSwap('ou_a', null, {
      type: 'session',
      sessionUuid: 'full-uuid-1234',
      cwd: '/tmp',
      createdAt: new Date().toISOString(),
      // no attachedAt
    });

    let runChatCalled = false;
    bot.runChatSDK = async (params: any) => {
      runChatCalled = true;
      return { result: {}, handler: {}, cardMessageId: null };
    };

    // Force busy check to return isProcessing to verify it's hit
    // (Setup mock for isSessionActive in env)

    await bot.handleChat({
      messageId: 'm1',
      openId: 'ou_a',
      text: 'hi',
      serialKey: 'session:full-uuid-1234',
      target: { type: 'session', sessionUuid: 'full-uuid-1234', cwd: '/tmp' },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    // Verify: busy check short-circuited before runChatSDK (busy card sent)
    // Or: runChatSDK NOT called with fromAttachedChat flag
    if (runChatCalled) {
      expect(capturedParams?.fromAttachedChat).toBeFalsy();
    }
    // If busy check fired, runChatSDK may not have been called at all
  });
```

(Adapt to match the test file's existing setup pattern — `bot`, `userManager`,
and `makeSpoolMessage` are already initialized in `beforeEach`. The key
assertion is that `fromAttachedChat: true` is passed when `attachedAt` is set.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/feishu/bot-handlechat-routing.test.ts 2>&1 | tail -10`
Expected: FAIL — `fromAttachedChat` is not passed because the routing code
doesn't exist yet.

- [ ] **Step 3: Add `attachedAt` check in `handleChat`**

In `src/feishu/bot.ts`, find the start of the `'session'` case at line 1031:

```typescript
      case 'session': {
        const sessionUuid = msg.target.sessionUuid ?? '';
        const currentEntry = this.registry.get(sessionUuid);
        const cwd = msg.target.cwd || currentEntry?.cwd || process.env.HOME || '/';

        if (!msg.skipActivityCheck && currentEntry) {
          try {
            const status = await isSessionActive(...);
            if (status.isProcessing && status.confidence !== 'low') {
              // ... busy card logic ...
            }
          } catch (err) { ... }
        }
```

Insert BEFORE the busy check block (right after `cwd = ...`):

```typescript
      case 'session': {
        const sessionUuid = msg.target.sessionUuid ?? '';
        const currentEntry = this.registry.get(sessionUuid);
        const cwd = msg.target.cwd || currentEntry?.cwd || process.env.HOME || '/';

        // v2.4.x: 如果 entry 是 attached 的,直接走 rendezvous 路径,跳过 busy check
        // (probe 2026-06-13 证明 done/stopped/idle bg 收到 reply 会 respawn 处理;
        // busy 卡因 CPU 抖动误报,不再适用 attached-chat 场景)
        const userEntry = this.userManager.getEntry(msg.openId);
        if (userEntry?.type === 'session' && userEntry.attachedAt && userEntry.sessionUuid === sessionUuid) {
          // attached chat: 走 runChatSDK + fromAttachedChat=true,内部会触发 tryRendezvousReply
          const settingsPath = this.getSettingsPathForUser(msg.openId);
          const promptText = buildPromptWithImages(msg.text, msg.imagePaths ?? []);
          let runResult: Awaited<ReturnType<FeishuBot['runChatSDK']>> | null = null;
          try {
            runResult = await this.runChatSDK({
              openId: msg.openId,
              sessionUuid,
              cwd,
              settingsPath,
              promptText,
              serialKey: msg.serialKey,
              isNew: false,
              messageId: msg.messageId,
              fromAttachedChat: true,  // ← 新 flag,触发 tryRendezvousReply
            });
          } catch (err: any) {
            this.spoolQueue.markReplied(msg.messageId, msg.serialKey);
            this.spoolQueue.markFailed(msg.messageId, msg.serialKey, String(err?.message ?? err));
            this.cancelledMessageIds.delete(msg.messageId);
            return;
          }
          // 跟现有路径同款 spool 收尾 (mirrors lines 1103-1120)
          const { result, cardMessageId } = runResult;
          this.registry.upsert(sessionUuid, {
            cwd, last_active: new Date().toISOString(),
            last_message_preview: preview(msg.text) || (msg.imagePaths?.length ? '[图片]' : ''),
            last_error: result?.error ?? null,
            status: result?.sessionStatus === 'degraded' ? 'degraded' : 'active',
            jsonl_path: result?.jsonlPath ?? undefined,
            pending_jsonl_resolve: result?.jsonlPath ? false : currentEntry?.pending_jsonl_resolve,
            message_count: (currentEntry?.message_count ?? 0) + 1,
          });
          await this.registry.flush();
          if (runResult.rendezvousHandled) {
            // rendezvous 路径已在 tryRendezvousReply 内部发完 chat-text reply
            this.spoolQueue.markReplied(msg.messageId, msg.serialKey);
            this.spoolQueue.markDone(msg.messageId, msg.serialKey);
          } else {
            // fallback 到 SDK 路径,正常收尾
            this.spoolQueue.updateProcessingMessage(msg.messageId, msg.serialKey, {
              responseText: result?.response || '(空回复)',
            });
            if (cardMessageId) {
              this.spoolQueue.recordDelivery(msg.messageId, 'sent', stableUuid(msg.messageId, 0), 0, cardMessageId, 1);
            }
            this.spoolQueue.markReplied(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
            this.spoolQueue.markDone(msg.messageId, msg.serialKey, cardMessageId ?? undefined);
            // 镜像原 runChatSDK 收尾:repairJsonlLastPrompt + cancelledMessageIds 清理
            const jlPath = result?.jsonlPath ?? currentEntry?.jsonl_path;
            if (jlPath) { try { repairJsonlLastPrompt(jlPath); } catch {} }
            this.cancelledMessageIds.delete(msg.messageId);
          }
          return;
        }

        // 原有 busy check 块 — 不动
        if (!msg.skipActivityCheck && currentEntry) {
          // ...
        }
```

- [ ] **Step 4: Update `runChatSDK` to accept `fromAttachedChat` flag**

In `src/feishu/bot.ts`, find `runChatSDK` signature (around line 1696). Add
the new param:

```typescript
  public async runChatSDK(params: {
    openId: string;
    sessionUuid: string;
    cwd: string;
    settingsPath?: string;
    promptText: string;
    serialKey: string;
    isNew?: boolean;
    messageId?: string;
    fromAgentViewReply?: boolean;
    /**
     * v2.4.x (Attach path): 标记这是 attached-chat 路径(用户在飞书侧 attached 到
     * bg session 后直接发文本)。若 true 且 bg rendezvous-eligible (canUse=true),
     * **自动** 走 tryRendezvousReply 路径(可能 respawn bg)。否则 fall through 到
     * 原 v2.2.11 busy-check + v2.3.5/3.6 auto-stop + SDK 路径。
     */
    fromAttachedChat?: boolean;
  }): Promise<{ ... }> {
```

Then also update the destructure at line 1729 to include the new flag:

```typescript
const { openId, sessionUuid: inputSessionUuid, cwd, settingsPath, promptText, serialKey, isNew = false, messageId, fromAgentViewReply = false, fromAttachedChat = false } = params;
```

Then update the rendezvous pre-step gate at line 1732:

```typescript
    // v2.4 rendezvous-first: short-circuit for Agent View Reply OR Attach-chat
    if (
      (fromAgentViewReply || fromAttachedChat) &&
      config.get<boolean>('agent_view.rendezvous_enabled', false)
    ) {
      const rv = await this.tryRendezvousReply({
        openId, sessionUuid: inputSessionUuid, promptText, messageId,
      });
      if (rv.handled) {
        return {
          result: null as unknown as SendMessageResult,
          handler: null as unknown as PermissionHandler,
          cardMessageId: rv.cardMessageId,
          rendezvousHandled: true,
          bgAskedNewQuestion: rv.bgAskedNewQuestion,
        };
      }
      // fall through to existing path
      // (Note: for attached-chat, we skip the busy check above, so fallback
      // here goes directly to SDK. For Reply path, fallback goes through the
      // v2.3.5 auto-stop path as before.)
    }
```

The `tryRendezvousReply` already accepts a single boolean return and handles
`bg_resumable` reason transparently (eligibility check returns
`reason: 'bg_resumable'` and daemon handles respawn). **No changes needed
inside `tryRendezvousReply` itself.**

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/feishu/bot-handlechat-routing.test.ts 2>&1 | tail -10`
Expected: PASS (existing + 2 new cases).

- [ ] **Step 6: Run all unit tests to verify nothing regressed**

Run: `bun test 2>&1 | tail -20`
Expected: PASS (all existing + new tests pass).

- [ ] **Step 7: Commit**

```bash
git add src/feishu/bot.ts tests/unit/feishu/bot-handlechat-routing.test.ts
git commit -m "feat(bot): handleChat routes attached entry to rendezvous

When user entry has attachedAt (set by handleAttach), handleChat
skips the busy check and routes directly to runChatSDK with
fromAttachedChat=true. runChatSDK accepts the flag and triggers
the existing tryRendezvousReply path, which now also covers
bg_resumable states (probe 2026-06-13 confirmed daemon respawn).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## PR 3: Local manual E2E

### Task 6: Manual E2E plan + verification

**Files:**
- Create: `docs/qa/v2.4.1-attach-rendezvous.md`

- [ ] **Step 1: Write E2E plan**

Create `docs/qa/v2.4.1-attach-rendezvous.md`:

```markdown
# v2.4.1 Attach + Rendezvous — Manual E2E

Pre-req: deploy PR 1 + PR 2 with `rendezvous_enabled = true` (already default
since v2.4 GA) in config.toml.

## Scenario 1: Attach to done bg → send text → rendezvous path

1. Find a done bg session in Agent View (any bg that has settled naturally).
   Example: `4d9df1d2` (fleet, completed earlier).
2. Click [Attach] on the session card.
3. **Verify**: bot replies with "📎 已 Attach 到 \`name\`..." + starts watching.
4. Send any text message (e.g. "hi").
5. **Verify**:
   - No busy card (no "⚠️ CLI 侧会话处理中")
   - Bot reply uses chat-text format with response + tokens (similar to Reply)
   - JSONL of the bg gets a new `user` turn with the text
   - bg transitions from done → blocked (respawned) → done (after processing)

## Scenario 2: Attach to running bg → send text → fallback to busy card

1. Start a real long-running bg: `claude --bg -p "请 sleep 30 然后退出"`
2. Wait for state.json `state: running` (no needs)
3. In Agent View, click [Attach]
4. Send any text
5. **Verify**:
   - Busy card appears (rendezvous eligibility returns `bg_busy`)
   - 3-button bg-conflict card (since bg is still running)
   - User can pick: stop bg / new session / cancel
   - rendezvous path NOT used (check logs for "fallback to SDK because bg_busy")

## Scenario 3: Attach → send → watcher transitions

1. Continue from Scenario 1 (bg done, attached, just sent text)
2. **Verify**:
   - Attached watcher patches the attached card with bg's new output
   - When bg settles (done again), attached card shows final status

## Scenario 4: Stop Watching → sends normal busy-check chat

1. Continue from Scenario 1 (attached, sent 1 text)
2. Click [Stop Watching] on the attached card
3. Send another text
4. **Verify**:
   - This time busy check runs (because attachedAt was cleared)
   - If bg busy → busy card; if bg idle → SDK path with stream cards

## Scenario 5: Back to Chat → normal chat routing restored

1. Send `/back` or equivalent (handleBackToChat path)
2. **Verify**:
   - Bot replies "已退出 Agent View..."
   - attachedAt cleared from entry (re-check via `cat ~/.cc-linker/user-mapping.json`)
   - Next chat text uses original busy-check path

## Scenario 6: bot daemon restart preserves attachedAt

1. Attach to a bg
2. Send a text (success via rendezvous)
3. `cc-linker daemon stop && bun run deploy`
4. Send another text
5. **Verify**:
   - entry.attachedAt restored from user-mapping.json (persisted, not just in-memory)
   - Rendezvous path used again (no busy card)

## Scenario 7: concurrent two users both attached to same bg

1. User A and User B both Attach to same bg (different openIds)
2. Both send text simultaneously
3. **Verify**:
   - Daemon serializes the two replies (probe 5 + bg queue semantics)
   - Both users get responses
   - No double-process / JSONL corruption
```

- [ ] **Step 2: Run scenarios locally**

```bash
bun run deploy
# Run through all 7 scenarios. Capture any failures.
# Document results in the doc as you go.
```

- [ ] **Step 3: Commit E2E doc**

```bash
git add docs/qa/v2.4.1-attach-rendezvous.md
git commit -m "docs(qa): v2.4.1 Attach+rendezvous E2E 7 scenarios + results

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review (checklist)

**1. Spec coverage**:

- Probe evidence → Task 0 (script + notes doc)
- Eligibility refinement (`bg_resumable`) → Task 1
- Logger update → Task 2
- `attachedAt` field → Task 3
- Manager lifecycle (handleAttach / BackToChat / StopWatching) → Task 4
- handleChat routing → Task 5
- Manual E2E → Task 6
- **Gaps**: None identified.

**2. Placeholder scan**: No TBD/TODO/"appropriate"/"implement later". All code
blocks have real implementation.

**3. Type consistency check**:

- `MappingEntry.attachedAt?: string` — Task 3 adds, Task 4 reads/writes via CAS,
  Task 5 reads in bot.ts. Same field name. ✓
- `runChatSDK.fromAttachedChat?: boolean` — Task 5 adds to signature, same task
  reads in rendezvous pre-step gate. ✓
- `RendezvousEligibility.reason: 'bg_waiting' | 'bg_resumable' | IneligibleReason`
  — Task 1 updates interface, Task 2 uses new value in logger. ✓
- `tryRendezvousReply` — unchanged; Task 1's eligibility refinement is transparent
  to it (existing return `{handled: true|false}` interface preserved). ✓
- `handleBackToChat` and `handleStopWatching` both follow same CAS-delete-attachedAt
  pattern (Task 4 Step 4 + Step 5). ✓

**No type inconsistencies found.**

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-13-attach-rendezvous.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
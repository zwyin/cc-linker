# Code Review Report — cc-linker (June 1–8, 2026)

**Scope:** 5 parallel reviews covering agent-view, feishu bot + live-progress, scanner + registry, queue + config + CLI, and test coverage. All findings adversarially verified against source. False positives removed, severities adjusted.

**Codebase state:** 721 tests passing across 68 files. ~30 commits this week (v2.2.3 → v2.2.18), heavy agent-view and bg-conflict work.

---

## Summary

The codebase is well-structured with strong defensive patterns — CAS updates, file locking, atomic writes, and graceful degradation are applied consistently *almost* everywhere. The agent-view module is the largest new surface and carries the most risk: several fire-and-forget paths lack error boundaries, network-sourced card action values aren't validated, and the most complex handlers (`_doStopAndSend`, `handleNewAndSend`, the bg-conflict flow) have little to no test coverage. The bot core has a real cancellation-key mismatch bug that makes `/stop` show incorrect feedback during SDK streaming. The queue layer has one remaining non-atomic write path. No show-stopping bugs were found — the bot works correctly for happy paths — but the long tail of unhandled error branches and untested recovery paths means regressions in the bg-conflict UX (the focus of v2.2.11–v2.2.18) would go undetected.

---

## Critical Issues (must fix before next release)

**None.** No P0 / ship-blocking bugs survived verification.

---

## High Issues (should fix soon)

### H1. `_doStopAndSend` — fire-and-forget with no top-level error boundary

**File:** `src/agent-view/manager.ts` L523–585
**Category:** error-handling
**Original severity:** CRITICAL → **DOWNGRADED to HIGH** (Bun logs-and-continues on unhandled rejections; doesn't crash)

`handleStopAndSend` (L482) calls `void this._doStopAndSend(...)` — the `void` operator discards the returned Promise. Three paths can throw unhandled:

- **L543**: `await this.deps.replyFn(...)` inside the catch block for `claude stop`. If `replyFn` throws, the catch itself throws.
- **L558–569**: CAS block with no try/catch. `compareAndSwap` internally uses `withLock`, which can throw `CCLinkerError('E007')` on lock timeout.
- **L583**: `await this.deps.replyFn(...)` inside the catch block for `runChatSDK`. Same pattern as L543.

**Impact:** Errors silently disappear. The user gets no feedback when stop/send fails. Debugging is extremely difficult because there's no log trace.

**Fix:**
```typescript
private async _doStopAndSend(...): Promise<void> {
  try {
    // ... existing logic ...
  } catch (err) {
    try {
      await this.deps.replyFn(`❌ 内部错误: ${err?.message ?? err}`, { openId });
    } catch { /* last-resort swallow */ }
  }
}
```

---

### H2. `cancelledMessageIds` keyed by `serialKey` in `runChatSDK` but `messageId` everywhere else

**File:** `src/feishu/bot.ts` L1445 (check), L1382 (delete), vs L2102 (add), L1172 (check), L1558 (check)
**Category:** bug
**Original severity:** HIGH → **DOWNGRADED to MEDIUM–HIGH** (process IS killed correctly; only card feedback is wrong)

| Location | Key used | Operation |
|----------|----------|-----------|
| L2102 (`_stopUserSession`) | `messageId` | `add()` |
| L1172 (`handleChatStreaming`) | `messageId` | `has()` / `delete()` |
| L1558 (`_handleStreamError`) | `messageId` | `has()` / `delete()` |
| L1653 (non-streaming) | `messageId` | `has()` / `delete()` |
| **L1445 (`runChatSDK`)** | **`serialKey`** | **`has()`** ← mismatch |
| L1382 (bg-conflict cleanup) | `serialKey` | `delete()` ← no-op |

`serialKey` is the session UUID (`a1b2c3d4-...`), `messageId` is the Feishu IM message ID (`om_v3...`). These are always different values.

**Impact:** During SDK streaming, `/stop` kills the Claude process correctly (via AbortController), but `runChatSDK` L1445 checks `cancelledMessageIds.has(serialKey)` → always false → card completes with `"Claude SDK 执行失败: ..."` instead of showing clean "已取消" state. The user's intent is fulfilled but the feedback is confusing.

**Fix:** Pass `messageId` into `runChatSDK` as a parameter and use it for the cancellation check. Alternatively, key the set by `serialKey` everywhere — but that requires changing `_stopUserSession` and `_handleStreamError`.

---

### H3. `isAgentViewValue` doesn't validate required fields — network-sourced data trusted blindly

**File:** `src/agent-view/action.ts` L44–48
**Category:** security / error-handling

`isAgentViewValue` only checks `v.tag.startsWith('agent_view_')`. Feishu card action values come from the network and could be malformed or truncated. Downstream in `bot.ts` L536–578, handlers access `valueObj.shortId`, `valueObj.sessionId`, `valueObj.cwd` without null checks.

**Impact:** A malformed value object with tag `agent_view_peek` but missing `sessionId` passes `undefined` to `handlePeek`, causing unpredictable behavior.

**Fix:**
```typescript
export function isAgentViewValue(v: any): v is AgentViewValue {
  if (!v || typeof v !== 'object' || typeof v.tag !== 'string') return false;
  if (!v.tag.startsWith('agent_view_')) return false;
  switch (v.tag) {
    case 'agent_view_peek':
    case 'agent_view_attach':
    case 'agent_view_reply_request':
      return typeof v.shortId === 'string' && typeof v.sessionId === 'string';
    // ... per-tag field validation
  }
  return true;
}
```

---

### H4. Missing migration path: v1/v2 registries fail to load

**File:** `src/registry/registry.ts` L98–101
**Category:** data integrity
**Original severity:** HIGH → **DOWNGRADED to MEDIUM–HIGH** (v2 was never deployed as an empty-registry version; v1 is archaic)

`migrateV1toV2` handles v1→v2. `migrateV3toV4` handles v3→v4. There is **no migration for v2→v3**. A v2 registry on disk passes neither migration, fails Zod validation (`version: z.literal(4)`), triggers `restoreFromBackup()`, and if the backup is also v2, falls through to `createEmpty()` — all session data lost.

In practice, `emptyRegistry()` always returned v3 before v4, so v2 was only a transient state from `migrateV1toV2`. v1 files only exist from pre-rename `cc-bridge` era. But the gap is real and the fix is 2 lines.

**Fix:**
```typescript
function migrateV2toV3(parsed: any): void {
  if (parsed.version === 2) parsed.version = 3;
}
// In load() / reload():
migrateV1toV2(parsed);
migrateV2toV3(parsed);  // ← add
migrateV3toV4(parsed);
```

---

### H5. `updateMessageFlags` uses `writeFileSync` instead of `writeAtomic`

**File:** `src/queue/spool.ts` L350
**Category:** crash safety
**Original severity:** HIGH → **DOWNGRADED to MEDIUM–HIGH** (withLock + small writes on modern FS greatly reduce impact)

Every other write path in `SpoolQueue` uses `writeAtomic()` (write to `.tmp` then `renameSync`). `updateMessageFlags` is the sole exception. If the process is killed mid-write, the spool message file can be truncated.

**Mitigating factors:** Already wrapped in `withLock(this.processingDir, ...)`. Spool messages are <2KB (atomic at filesystem level on ext4/APFS). `readSpoolMessage` returns `null` on corrupt files, and `recoverProcessing()` provides restart recovery.

**Fix:** Replace L350 with `this.writeAtomic(path, msg)`.

---

## Medium Issues (nice to fix)

### M1. `handleStopConfirm` — TOCTOU between guard and `claude stop`

**File:** `src/agent-view/manager.ts` L335–356

Between user clicking `[Stop]`, seeing the confirm card, and clicking `[确认停止]`, the session could have naturally completed or been stopped elsewhere. `claude stop` errors with "No job matching", which surfaces as `❌ Stop 失败:...` — confusing when the session was already done.

**Fix:** Before running `claude stop`, re-fetch snapshot and check session is still busy. Treat "No job matching" as success.

---

### M2. Sessions with `status === 'unknown'` silently invisible

**File:** `src/agent-view/types.ts` L36–46

`groupByStatus` filters for `busy`, `waiting`, `idle`, and `idle && completed`. The `unknown` status (produced by `parseAgentsJson` for unexpected values) matches none. Sessions are silently dropped.

**Fix:** Map `unknown` to `idle` with a warning log, or add an `unknown` group.

---

### M3. `handleAttach` — `expectedReply` cleared before CAS-1 succeeds

**File:** `src/agent-view/manager.ts` L413–424

When `oldEntry.type === 'pending_agent_reply'`, `expectedReply.clear(openId, 'overwrite')` runs at L416 before CAS-1 at L420. If CAS-1 fails, the user's pending reply slot is already gone. Not rolled back.

**Fix:** Don't clear `expectedReply` until after CAS-1 succeeds.

---

### M4. `sendCLIBusyCard` — no `feishuClient` null check

**File:** `src/feishu/bot.ts` L1078–1089

Creates `new CardUpdater(this.feishuClient, ...)` without checking if `feishuClient` is null. If null during startup, throws TypeError, caught by `handleChat`'s catch block, which falls through to "降级：允许发送" — defeating the activity check.

**Fix:** Guard with `if (!this.feishuClient)` and either block or warn.

---

### M5. `handleForceSendCardAction` failure returns `null` — user gets no feedback

**File:** `src/feishu/bot.ts` L746–763

If `updateMessageFlags` returns `false` or `requeueFromProcessing` fails, the handler returns `null`. Feishu keeps the card in its current state. The user clicked "⚠️ 我了解风险，仍要发送" and gets zero feedback.

**Fix:** Return an error card instead of `null`.

---

### M6. Live watcher `stop` + `start` in `doSwitch` has no ordering guarantee

**File:** `src/feishu/bot.ts` L2570–2594

`stopLiveWatcher` is fire-and-forget (`.catch()`), new watcher starts immediately. Old watcher's final "idle" patch could arrive up to 5 seconds after new watcher's first patch. Cosmetic glitch on the old card.

**Fix:** Consider awaiting `stopLiveWatcher` before starting the new watcher.

---

### M7. `cleanup()` calls `unlinkSync` without per-file try/catch

**File:** `src/queue/spool.ts` L396–478

If a file is deleted between `readdirSync` and `unlinkSync`, `unlinkSync` throws ENOENT and aborts the entire cleanup. Called from `reconciler.ts` at bot startup — can delay or fail startup.

**Fix:** Wrap each `unlinkSync` in try/catch.

---

### M8. `parseFull` reads entire file — OOM risk for files near 100MB

**File:** `src/scanner/jsonl.ts` L225, L406

`readFileSync(filePath, 'utf8')` loads entire file into memory. For a 99MB JSONL, ~300MB+ peak allocation. The 4KB fallback at L406 triggers a full read for any session where the tail lacks user/assistant messages.

**Fix:** Add a secondary size check to the 4KB fallback:
```typescript
if ((!lastUserPreview || !preview) && stat.size > 4096 && stat.size < 10 * 1024 * 1024) {
```

---

### M9. `parseTail` small-file preview extraction bypasses `cleanAssistantText`

**File:** `src/scanner/jsonl.ts` L458–460

Small-file path uses raw `textBlock.text.slice(0, 100)` while large-file path uses `cleanAssistantText()` (markdown stripping, multi-block join, line-aware truncation). Previews for files ≤ 4KB contain raw markdown.

**Fix:** Route through `cleanAssistantText` consistently.

---

### M10. `truncateBytes` is O(n²) in string length

**File:** `src/agent-view/manager.ts` L836–847

For each character, `new TextEncoder().encode(acc + ch).length` re-encodes the entire accumulated string.

**Fix:**
```typescript
function truncateBytes(s: string, max: number): string {
  const enc = new TextEncoder();
  let byteLen = 0;
  let result = '';
  for (const ch of s) {
    const chBytes = enc.encode(ch).length;
    if (byteLen + chBytes > max) break;
    result += ch;
    byteLen += chBytes;
  }
  return result;
}
```

---

### M11. `buildPeekCard` status label maps `idle` to `已完成`

**File:** `src/agent-view/card.ts` L178–179

`idle` sessions (running, waiting for user input) show as "已完成" (Completed). Only `completed: true` sessions should show that.

**Fix:** Add `idle` → `'空闲'` to the label mapping.

---

### M12. `daemon-log-reader.ts` — same file read twice, potential inconsistency

**File:** `src/agent-view/daemon-log-reader.ts` L29–49, L62–81

`readCompletedSessions` and `readClaimedSources` both independently read the same `daemon.log`. Called back-to-back in `snapshot-fetcher.ts` L148–149. Double I/O, and if the log rotates between reads, one may see entries the other doesn't.

**Fix:** Export a single `readDaemonLogEvents(withinHours)` returning both maps in one pass.

---

## Low Issues / Nits

| # | File | Line | Issue |
|---|------|------|-------|
| L1 | `expected-reply-state.ts` | 113–136 | `restoreExpectedReplyStates` uses `entry.shortId!` — non-null assertion masks potential missing field after schema migration |
| L2 | `jsonl-peek.ts` | 56, 65 | `require('fs')` mixed with ESM imports — works in Bun, breaks in pure ESM |
| L3 | `manager.ts` | 69–81 | `handleList` CAS to save `cardMessageId` doesn't check return value — silent degradation on CAS failure |
| L4 | `card.ts` | 431 | `.length` counts UTF-16 code units, not characters — emoji count as 2 in truncation |
| L5 | `daemon-log-reader.ts` | 40 | `\S+` regex accepts any non-whitespace; tighten to `[0-9a-f]{8,}` |
| L6 | `config.ts` | 306–307 | `loadEnv` accepts NaN for numeric env vars without warning |
| L7 | `activity-hook.ts` | 19 | Exit code 0 even when `writeActivityMarker` silently rejects invalid UUID |
| L8 | `spool.ts` | 281–293 | Fallback failed-message uses `'unknown'` messageId — subsequent failures overwrite each other |
| L9 | `session-activity.ts` | 229–238 | `cleanupOldActivityLogs` doesn't validate file type or reject symlinks |
| L10 | `session-activity.ts` | 71 | `warnedSessionUuids` Set cap only enforced during `cleanupOldActivityLogs` — enforce at insertion |
| L11 | `jsonl.ts` | 258 | `parseFull` early-exit never fires for non-subagent sessions — full scan always |
| L12 | `jsonl.ts` | 165–176 | `truncateByLine` invariant breaks for `maxLength < 4` (only called with 240, so theoretical) |
| L13 | `live-progress.ts` | 56, 60 | `(bot as any)` casts bypass TypeScript — fragile to internal refactoring |
| L14 | `bot.ts` | 1469–1486 | Permission card completion `setTimeout` — `this.feishuClient!` assertion 1200ms later is fragile |
| L15 | `bot.ts` | 1383–1396 | bg-conflict path returns dummy `PermissionHandler` with empty arrays — fragile contract |

---

## Positive Patterns

1. **Atomic writes are the default.** `writeAtomic()` (write to `.tmp` then `renameSync`) is used consistently across the registry, cache, name-cache, and most spool paths. The one exception (`updateMessageFlags`) is being fixed. This pattern prevents corrupt files on crash.

2. **CAS (compare-and-swap) for all user state.** `UserManager.compareAndSwap()` with `casToken` prevents race conditions between concurrent workers modifying the same user's state. This is used rigorously in `expected-reply-state.ts`, `manager.ts`, and `mapping.ts`.

3. **File locking with `proper-lockfile`.** Cross-process locking for registry writes and spool queue operations. `withLock()` provides both in-process RWLock and cross-process file locks. Used in all critical write paths.

4. **Graceful degradation everywhere.** Scanner falls back from tail read → full read → skip. `readSpoolMessage` returns `null` on corrupt files. Activity detection falls back from sidecar → process detection → "assume inactive". The system is resilient to partial failures.

5. **Incremental scan cache.** `scan_cache.json` with file size/mtime tracking means repeated CLI commands skip unchanged JSONL files. Well-designed cache invalidation.

6. **3-tier content resolver.** `resolvePeekContent` in agent-view falls back from daemon.log → name-cache → JSONL peek. Multiple independent data sources with clear priority.

7. **Error codes with user-facing suggestions.** `CCLinkerError(code, message)` in `handleError()` provides actionable suggestions per error code. Good developer experience.

8. **Zod schema validation.** Registry types are validated with Zod on every load. Migration functions are idempotent. Schema version is explicit and migrated forward.

---

## Architecture Observations

### 1. Fire-and-forget pattern needs a project-wide policy

`void someAsyncFn()` appears in at least 4 places: `_doStopAndSend`, `doSwitch` watcher stop, `stopLiveWatcher`, permission card `setTimeout`. Each has slightly different error handling (some have `.catch()`, some don't). A project-wide convention — e.g., a `fireAndForget(promise, context, logger)` helper that always catches and logs — would prevent unhandled rejections uniformly.

### 2. `cancelledMessageIds` reflects a deeper identity tension

The set is keyed by `messageId` in the streaming path and `serialKey` in the SDK path. This reflects the two different session models: streaming ties to a Feishu message, SDK ties to a session UUID. Rather than patching one check site, consider a unified `CancellationTracker` class that accepts both key types and maps them explicitly.

### 3. `(bot as any)` casts indicate a missing interface

`live-progress.ts` casts `bot` to `any` to access `sessionManager`, `registry`, `activityCache`. This is documented as "avoiding circular dependencies" but creates a runtime-only contract. Define a `BotReadContext` interface with the fields the watcher needs and have `FeishuBot` implement it. Compile-time safety, zero runtime cost.

### 4. Spool queue locking is inconsistent

`updateMessageFlags` uses `withLock`. `updateProcessingMessage` doesn't. `recordDelivery` doesn't. The documented rule should be: **all processing-dir writes go through `withLock` + `writeAtomic`**. Enforce via lint rule or a single `writeProcessing(messageId, patch)` method that encapsulates both.

### 5. Migration chain needs explicit documentation

The v1→v2→v3→v4 chain has a gap (v2→v3). Beyond fixing it, document the migration invariant: "every historical `version` value must have a migration function, even if it's a no-op version bump." Add a test that constructs a registry at each historical version and verifies it migrates to current.

---

## Test Coverage Gaps

### 🔴 HIGH priority (untested recovery paths)

| Gap | Current | Why it matters |
|-----|---------|----------------|
| `_doStopAndSend` error branches | 1 timing test only | Fire-and-forget handler with 50+ lines, 4 error branches, and parent fallback logic. Any regression silently breaks stop-and-send recovery. |
| `handleNewAndSend` | 0 tests | Entire method untested. One of the 3 bg-conflict recovery buttons. |
| bg-conflict E2E integration | 0 tests | The 4-step flow (detect worker → refuse card → button click → resolution) has zero integration coverage. Most user-visible new feature this week. |

### 🟡 MEDIUM priority (untested edge cases)

| Gap | Current | Why it matters |
|-----|---------|----------------|
| `handleBgConflictCancel` | 0 tests | Third bg-conflict recovery button. |
| `handleAttach` bgWorkerNotice | Tests mock roster as `null` only | Never tests the warning path when roster has a matching live worker. |
| `handleAttach` expectedReply ordering | Happy path tested | No test for CAS-1-fails-after-clear regression — `expectedReply` cleared before CAS, so CAS failure loses the pending slot. |
| `maybeRotateActivityLog` | 0 direct tests | Only function that truncates a file based on size. Bug could lose activity markers. |
| `updateMessageFlags` concurrency | 2 basic tests | No concurrent stress test with 2+ simultaneous callers. |
| v2→v3→v4 chained migration | Acknowledged out of scope | No test documents behavior for v2 registries. |

### 🟢 LOW priority (covered by integration or edge cases)

| Gap | Notes |
|-----|-------|
| `handleReply` fetch-failure / session-gone branches | Covered partially in integration |
| Watcher `patch_failed` / `max_ticks` stop reasons | Straightforward terminal conditions |
| `parseTailForPreview` with system-only JSONL | Edge case, would return `{}` |
| Concurrent scans on same JSONL | Single-threaded Bun makes this theoretical |

---

## Recommendations

### 1. Add top-level error boundaries to all fire-and-forget paths (H1)

Wrap `_doStopAndSend`, `handleNewAndSend`, and any `void someAsyncFn()` call in a try/catch that logs and optionally replies to the user. Consider a `fireAndForget()` helper. **Effort: ~1 hour. Impact: eliminates an entire class of silent failures.**

### 2. Fix the `cancelledMessageIds` key mismatch (H2)

Unify on `messageId` by passing it into `runChatSDK`. This is a one-line fix at L1445 plus plumbing. **Effort: ~30 minutes. Impact: `/stop` shows correct feedback during SDK streaming.**

### 3. Add field-level validation to `isAgentViewValue` (H3)

Network-sourced card action values must be validated before use. Add per-tag field checks. **Effort: ~30 minutes. Impact: prevents undefined propagation from malformed Feishu callbacks.**

### 4. Close the migration gap and add a migration chain test (H4)

Add `migrateV2toV3` stub (2 lines). Add a test that constructs registries at v1, v2, v3 and verifies each migrates to v4 with data preserved. **Effort: ~1 hour. Impact: prevents data loss for users upgrading from old versions.**

### 5. Add tests for the 3 untested bg-conflict recovery handlers (test gap)

`_doStopAndSend` (4–5 tests for error branches + parent fallback), `handleNewAndSend` (2–3 tests), and `handleBgConflictCancel` (1–2 tests). These are the user-facing recovery paths for the bg-conflict feature that was the focus of v2.2.11–v2.2.18. **Effort: ~1 day. Impact: prevents silent regression of the most complex new user-facing feature.**

---

**Reviewed by:** 5 parallel reviewers + adversarial verification pass
**Findings submitted:** 54 | **False positives removed:** 7 | **Severities downgraded:** 8 | **Final actionable items:** 12 High/Medium + 15 Low

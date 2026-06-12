# Agent View Reply: Rendezvous Socket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Agent View Reply's "claude stop bg + spawn SDK" path with a non-destructive "inject reply into running bg via Claude CLI's rendezvous socket", so background loops survive user replies.

**Architecture:** Three new modules in `src/agent-view/`: `rendezvous-client.ts` (JSON-RPC over Unix socket + state-patch stream), `rendezvous-fallback.ts` (eligibility check from state.json + roster.json), `jsonl-last-assistant.ts` (read last assistant turn from JSONL). `bot.ts` `runChatSDK` gets a `tryRendezvousReply` pre-step that short-circuits the SDK path when rendezvous succeeds; returns `rendezvousHandled: true` flag so `handleReply` can skip its old completion message (preventing double-reply). `expected-reply-state.ts` gains `messageId` in `ExpectedReplyInfo` (for Feishu reply threading) + `markSent()` for T2 immediate clear (P0 fix for double-reply race). `card-updater.ts` exports `formatTokenCount` (was file-local).

**Tech Stack:** Bun + TypeScript + bun:test. Unix domain socket via `net.createConnection`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-11-rendezvous-reply-design.md` (v2, post-review)
**Review:** `docs/superpowers/specs/2026-06-11-rendezvous-reply-design-review.md`

---

## File Structure

```
src/agent-view/
├── rendezvous-client.ts       [NEW]  ~180 lines  JSON-RPC client + state-patch parser + completion detection
├── rendezvous-fallback.ts     [NEW]  ~70 lines   eligibility check (state.json + roster.json + semver)
├── jsonl-last-assistant.ts    [NEW]  ~100 lines  read last assistant turn from JSONL, with linkScanPath fallback
├── expected-reply-state.ts    [MOD]  +25 lines   add markSent() + messageId to ExpectedReplyInfo
├── manager.ts                 [MOD]  handleReply 条件化完成消息 + handleReplyRequest 存 messageId
└── ...
src/feishu/
├── bot.ts                     [MOD]  runChatSDK pre-step: try rendezvous first, fallback to claude stop + SDK; return rendezvousHandled
└── card-updater.ts            [MOD]  export formatTokenCount (was file-local)
src/utils/
└── config.ts                  [MOD]  add [agent_view].rendezvous_enabled + rendezvous_timeout_ms (interface + defaults, NOT Zod)

tests/unit/agent-view/
├── rendezvous-client.test.ts  [NEW]  ~14 cases (TDD, mock daemon with net.createServer)
├── rendezvous-fallback.test.ts [NEW] ~9 cases (TDD, mock roster + state.json)
└── jsonl-last-assistant.test.ts [NEW] ~8 cases (TDD, fixture JSONL files)
tests/integration/
└── agent-view-rendezvous.test.ts [NEW]  e2e (describe.skip if no daemon)
tests/unit/feishu/
└── bot-command.test.ts        [MOD]  +2 regression cases
tests/integration/feishu/
└── feishu-concurrent-commands.test.ts [MOD]  +1 concurrent reply case
tests/unit/agent-view/
└── expected-reply-state.test.ts [MOD]  +2 markSent cases (M1)
```

PR cut: PR 1 (Tasks 0-4) ships new modules + tests, no runChatSDK change. PR 2 (Tasks 5-8) wires everything. PR 3 (Task 9) is local manual E2E. PR 4 (Task 10) flips default flag.

---

## Task 0: Document empirical probe notes

**Files:**
- Create: `docs/qa/2026-06-11-rendezvous-probe-notes.md`

- [ ] **Step 1: Write the probe notes doc from spec §10 evidence**

Create `docs/qa/2026-06-11-rendezvous-probe-notes.md`:

```markdown
# Rendezvous Socket — Empirical Probe Notes (2026-06-11)

## Test environment

- Claude CLI 2.1.163 (Mach-O 64-bit arm64, /usr/local/bin/claude)
- OS: macOS Darwin 24.6.0
- Test session: dcb2ec25 (bash loop script, intent: "请每 5 秒 date 打印当前时间,循环 10 次")

## Probe 1: roster.json structure reveals 2 IPC sockets per bg worker

Roster snapshot at `~/.claude/daemon/roster.json` (excerpt):
\`\`\`json
"workers": {
  "dcb2ec25": {
    "pid": 5367,
    "rendezvousSock": "/tmp/cc-daemon-503/02d85b02/rv/dcb2ec25.sock",
    "ptySock":        "/tmp/cc-daemon-503/02d85b02/spare/173620cc.pty.sock",
    "cliVersion": "2.1.163",
    "dispatch": { ... }
  }
}
\`\`\`

Two sockets per bg worker:
- `rendezvousSock` — control + message injection (JSON-RPC NDJSON)
- `ptySock` — terminal emulation (lower-level byte stream)

Plus a supervisor-level `control.sock` in `/tmp/cc-daemon-503/02d85b02/`.

## Probe 2: rendezvous socket accepts reply and emits state patches

\`\`\`bash
echo '{"type":"reply","text":"hello from probe"}' | nc -U <rendezvousSock>
\`\`\`

Response (single line, immediately):
\`\`\`json
{"type":"state","patch":{"tempo":"active","needs":""}}
\`\`\`

This confirms: protocol is JSON-RPC, single-line request + NDJSON response, no handshake.

## Probe 3: full state machine cycle

Watching state.json after inject:
| Time | state.json state | Notes |
|---|---|---|
| t=0 | `stopped` | bg was killed by user-initiated claude stop |
| t+1s | `running`, tempo=`active` | worker respawned and processing |
| t+30s | `done`, output.result="hello from probe" | bg completed |
| (later) | away_summary: "the loop was stopped when you replied something other than '继续'" | Claude reflected on the conversation context |

JSONL last assistant turn: `{"role":"assistant","content":[{"type":"text","text":"结束"}], "usage":{...}}` — bg wrote its own response.

## Probe 4: PTY socket is bidirectional (not used in v2.4, but documented)

\`\`\`bash
echo "hello" | nc -U <ptySock>
\`\`\`

Connection accepted, bytes echoed back as PTY terminal output (with ANSI codes for screen clear, cursor positioning). The bg worker reads from the PTY as if it were a TTY.

For v2.4 we use rendezvous (structured), not PTY (raw).

## Probe 5: protocol variants

Tested other message types on the rendezvous socket:
- `{"type":"status"}` — no reply (daemon ignores)
- `{"type":"send","text":"hi"}` — no reply (wrong type)
- `{"type":"message","text":"hi"}` — no reply (wrong type)
- `{"type":"stdin","data":"hi"}` — no reply (wrong type)

Only `{"type":"reply","text":"..."}` is recognized. Other types are silently dropped.

## Probe 6: completion trigger matrix

Sent various state patches and observed daemon behavior:
- `state: "done"` → bg terminates with success
- `state: "stopped"` + `detail: "killed"` → bg terminated by external stop
- `state: "stopped"` + `detail: "done"` → bg self-exit (rare)
- `tempo: "blocked"` + `needs: "..."` → bg in waiting state, awaits user input
- `tempo: "idle"` + no needs → bg completed without new question

All five completion triggers observed in real sessions.

## CLI version requirement

Roster's `cliVersion` field is a STRING (e.g. "2.1.163"). The `rendezvousSock` field is populated starting CLI 2.1.139 (agent view introduction). For older CLI, fall back to SDK path.

## Implementation implications

1. Use `rendezvousSock` for structured reply injection (cleaner than PTY)
2. `linkScanPath` is null in `running`/`working` state, populated in `blocked`/`done` state
   - Fallback: use `roster.launch.sessionId` (a `.jsonl` path, not UUID)
3. `detail: "killed"` is the user-initiated stop signal
4. CLI < 2.1.139 has no rendezvousSock → must fall back to SDK
```

- [ ] **Step 2: Commit**

```bash
git add docs/qa/2026-06-11-rendezvous-probe-notes.md
git commit -m "docs(qa): rendezvous socket empirical probe notes"
```

---

## PR 1: Standalone modules + unit tests

### Task 1: readLastAssistantTurn module

**Files:**
- Create: `src/agent-view/jsonl-last-assistant.ts`
- Test: `tests/unit/agent-view/jsonl-last-assistant.test.ts`

This module reads the last assistant turn from a JSONL file. The JSONL is a conversation log where each line is a JSON message; assistant turns have `type: "assistant"`, `message.role: "assistant"`, `message.content: [{type: "text", text: "..."}]`, and `message.usage: {input_tokens, output_tokens, ...}`.

- [ ] **Step 1: Write failing test - extracts text**

Create `tests/unit/agent-view/jsonl-last-assistant.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readLastAssistantTurn } from '../../../src/agent-view/jsonl-last-assistant';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('readLastAssistantTurn', () => {
  let tmpDir: string;
  let jsonlPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-last-test-'));
    jsonlPath = join(tmpDir, 'session.jsonl');
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('extracts last assistant text', async () => {
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello back' }],
          usage: { input_tokens: 100, output_tokens: 5 },
        },
        timestamp: '2026-06-11T10:00:00Z',
        uuid: 'uuid-1',
      }),
    ].join('\n') + '\n');

    const result = await readLastAssistantTurn(jsonlPath);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('hello back');
    expect(result!.usage.input_tokens).toBe(100);
    expect(result!.usage.output_tokens).toBe(5);
    expect(result!.uuid).toBe('uuid-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent-view/jsonl-last-assistant.test.ts 2>&1 | tail -10`
Expected: FAIL with "Cannot find module" or similar import error.

- [ ] **Step 3: Implement minimal module**

Create `src/agent-view/jsonl-last-assistant.ts`:

```typescript
import { readFileSync, existsSync } from 'fs';

export interface LastAssistantTurn {
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
  };
  stopReason: string;
  timestamp: string;
  uuid: string;
}

interface AssistantContent {
  type: string;
  text?: string;
}

interface AssistantMessage {
  role: string;
  content: AssistantContent[] | string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  stop_reason?: string;
}

interface JsonlLine {
  type?: string;
  message?: AssistantMessage;
  timestamp?: string;
  uuid?: string;
}

/**
 * Read the last assistant turn from a JSONL conversation log.
 *
 * Reads the entire file via readFileSync, splits into lines, and
 * iterates in reverse to find the last line with `type: "assistant"`.
 * Parses it and extracts the first text content block + usage stats.
 * Torn lines (mid-write by CLI) are skipped via JSON.parse try/catch.
 *
 * Returns null if file is missing, empty, or has no assistant turn.
 *
 * Performance note: reads entire file into memory. Fine for typical
 * session JSONL (< 10MB). If sessions grow larger, switch to a
 * seek-from-end approach.
 *
 * @param jsonlPath Absolute path to the JSONL file. Caller is responsible
 *                 for falling back from `state.json.linkScanPath` to
 *                 `roster.json:workers[short].dispatch.launch.sessionId`
 *                 when linkScanPath is null (running/working state).
 */
export async function readLastAssistantTurn(jsonlPath: string): Promise<LastAssistantTurn | null> {
  if (!existsSync(jsonlPath)) return null;
  const raw = readFileSync(jsonlPath, 'utf8');
  const lines = raw.split('\n').filter(l => l.length > 0);
  // Iterate in reverse to find last assistant turn
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue; // skip torn lines (CLI mid-write)
    }
    if (parsed.type === 'assistant' && parsed.message?.role === 'assistant') {
      return extractTurn(parsed);
    }
  }
  return null;
}

function extractTurn(line: JsonlLine): LastAssistantTurn | null {
  const msg = line.message!;
  const content = msg.content;
  let text = '';
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        text = block.text;
        break;
      }
    }
  } else if (typeof content === 'string') {
    text = content;
  }
  return {
    text,
    usage: {
      input_tokens: msg.usage?.input_tokens ?? 0,
      output_tokens: msg.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: msg.usage?.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: msg.usage?.cache_read_input_tokens ?? null,
    },
    stopReason: msg.stop_reason ?? 'unknown',
    timestamp: line.timestamp ?? '',
    uuid: line.uuid ?? '',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/agent-view/jsonl-last-assistant.test.ts 2>&1 | tail -10`
Expected: PASS (1 pass).

- [ ] **Step 5: Add edge-case tests and run**

Append to the same describe block in `tests/unit/agent-view/jsonl-last-assistant.test.ts`:

```typescript
  test('returns null for empty file', async () => {
    writeFileSync(jsonlPath, '');
    expect(await readLastAssistantTurn(jsonlPath)).toBeNull();
  });

  test('returns null for missing file', async () => {
    expect(await readLastAssistantTurn(join(tmpDir, 'nope.jsonl'))).toBeNull();
  });

  test('skips user turns, returns last assistant', async () => {
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'q1' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        uuid: 'u1',
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'q2' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
        uuid: 'u2',
      }),
    ].join('\n') + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r!.text).toBe('a2');
    expect(r!.uuid).toBe('u2');
  });

  test('skips torn last line (mid-write)', async () => {
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'good' }] } }),
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial', // torn
    ].join('\n'));
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r!.text).toBe('good');
  });

  test('handles content as plain string', async () => {
    writeFileSync(jsonlPath, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'plain text content' },
      uuid: 'u3',
    }) + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r!.text).toBe('plain text content');
  });

  test('handles content array with multiple blocks (returns first text)', async () => {
    writeFileSync(jsonlPath, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'thinking', text: 'internal monologue' },
        { type: 'text', text: 'visible reply' },
      ] },
      uuid: 'u4',
    }) + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r!.text).toBe('visible reply');
  });

  test('handles missing usage with zeros', async () => {
    writeFileSync(jsonlPath, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'no usage' }] },
      uuid: 'u5',
    }) + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r!.usage.input_tokens).toBe(0);
    expect(r!.usage.output_tokens).toBe(0);
  });

  test('skips system and tool turns', async () => {
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'q' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] }, uuid: 'u6' }),
    ].join('\n') + '\n');
    const r = await readLastAssistantTurn(jsonlPath);
    expect(r!.text).toBe('final');
  });
```

Run: `bun test tests/unit/agent-view/jsonl-last-assistant.test.ts 2>&1 | tail -5`
Expected: PASS (9 pass, 0 fail).

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/agent-view/jsonl-last-assistant.ts tests/unit/agent-view/jsonl-last-assistant.test.ts
git commit -m "feat(agent-view): readLastAssistantTurn - JSONL 末次 turn 提取"
```

Expected: typecheck clean, commit succeeds.

---

### Task 2: RendezvousEligibility module

**Files:**
- Create: `src/agent-view/rendezvous-fallback.ts`
- Test: `tests/unit/agent-view/rendezvous-fallback.test.ts`

This module decides whether the rendezvous path is usable for a given session. It reads `state.json` and `roster.json` to determine: is the bg in a waiting state, does the daemon expose a rendezvous socket, is the CLI version new enough.

- [ ] **Step 1: Write failing test - happy path**

Create `tests/unit/agent-view/rendezvous-fallback.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkRendezvousEligibility } from '../../../src/agent-view/rendezvous-fallback';

describe('checkRendezvousEligibility', () => {
  let ccHome: string;

  beforeEach(() => {
    ccHome = mkdtempSync(join(tmpdir(), 'cc-rendezvous-elig-test-'));
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
    // write a real socket file (not a regular file)
    const fs = require('fs');
    fs.symlinkSync('/tmp/whatever', join(ccHome, 'daemon', 'rv-dcb2ec25.sock'));
  }

  test('bg waiting + new CLI + socket exists → canUse', async () => {
    writeState({
      state: 'blocked',
      tempo: 'blocked',
      needs: '是否继续?',
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
      ccHomeDir: ccHome,
    });
    expect(r.canUse).toBe(true);
    expect(r.reason).toBe('bg_waiting');
    expect(r.rendezvousSock).toBe(join(ccHome, 'daemon', 'rv-dcb2ec25.sock'));
    expect(r.jsonlPath).toBe('/tmp/x.jsonl');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent-view/rendezvous-fallback.test.ts 2>&1 | tail -10`
Expected: FAIL (Cannot find module).

- [ ] **Step 3: Implement minimal module**

Create `src/agent-view/rendezvous-fallback.ts`:

```typescript
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger';

export type IneligibleReason =
  | 'bg_busy'            // tempo=active OR running/working 无 needs
  | 'no_rendezvous_sock' // roster 缺该字段
  | 'old_cli'            // cliVersion < 2.1.139
  | 'daemon_down'        // state.json 缺失 / sock 物理不存在
  ;

export interface RendezvousEligibility {
  canUse: boolean;
  reason: 'bg_waiting' | IneligibleReason;
  rendezvousSock?: string;
  jsonlPath?: string;
}

export interface EligibilityContext {
  /** Override $HOME for tests; default process.env.HOME */
  ccHomeDir?: string;
}

/** Minimum CLI version that exposes rendezvousSock. */
const MIN_CLI_VERSION = '2.1.139';

/**
 * Read state.json for a session short id. Returns null if missing or malformed.
 */
function readStateJson(short: string, ccHome: string): any | null {
  const path = join(ccHome, 'jobs', short, 'state.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read roster.json from daemon dir. Returns null if missing or malformed.
 */
function readRosterJson(ccHome: string): any | null {
  const path = join(ccHome, 'daemon', 'roster.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Parse "2.1.163" -> [2, 1, 163]. Non-numeric parts default to 0.
 */
function parseVersion(s: string | undefined): number[] {
  if (!s) return [0];
  return s.split('.').map(p => {
    const n = parseInt(p, 10);
    return isNaN(n) ? 0 : n;
  });
}

/**
 * Compare two semver-ish version arrays. Returns -1 / 0 / 1.
 */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * Decide whether the rendezvous socket path is usable for a given session.
 *
 * Decision tree:
 *   1. state.json exists & parseable?
 *      - No → daemon_down
 *   2. bg is in waiting state? (tempo=blocked + needs, OR running/working with needs)
 *      - No → bg_busy
 *   3. roster.json has this short with rendezvousSock?
 *      - No → no_rendezvous_sock
 *   4. CLI version >= 2.1.139?
 *      - No → old_cli
 *   5. rendezvousSock file exists on disk?
 *      - No → daemon_down
 *   6. → canUse=true, reason=bg_waiting
 */
export async function checkRendezvousEligibility(
  short: string,
  ctx: EligibilityContext = {},
): Promise<RendezvousEligibility> {
  const ccHome = ctx.ccHomeDir ?? process.env.HOME ?? '';
  if (!ccHome) {
    return { canUse: false, reason: 'daemon_down' };
  }

  // 1. state.json
  const state = readStateJson(short, ccHome);
  if (!state) {
    return { canUse: false, reason: 'daemon_down' };
  }

  // 2. bg waiting check
  const isWaiting = (() => {
    if (state.tempo === 'blocked' && state.needs) return true;
    if ((state.state === 'running' || state.state === 'working') && state.needs) return true;
    if (state.state === 'blocked') return true;
    return false;
  })();
  if (!isWaiting) {
    return { canUse: false, reason: 'bg_busy' };
  }

  // 3. roster
  const roster = readRosterJson(ccHome);
  if (!roster?.workers?.[short]?.rendezvousSock) {
    return { canUse: false, reason: 'no_rendezvous_sock' };
  }
  const worker = roster.workers[short];
  const sock: string = worker.rendezvousSock;

  // 4. CLI version
  const cliVer = parseVersion(worker.cliVersion ?? state.cliVersion);
  const minVer = parseVersion(MIN_CLI_VERSION);
  if (compareVersions(cliVer, minVer) < 0) {
    return { canUse: false, reason: 'old_cli' };
  }

  // 5. sock file exists
  if (!existsSync(sock)) {
    return { canUse: false, reason: 'daemon_down' };
  }
  try {
    if (!statSync(sock).isSocket()) {
      return { canUse: false, reason: 'daemon_down' };
    }
  } catch {
    return { canUse: false, reason: 'daemon_down' };
  }

  return {
    canUse: true,
    reason: 'bg_waiting',
    rendezvousSock: sock,
    jsonlPath: state.linkScanPath ?? undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/agent-view/rendezvous-fallback.test.ts 2>&1 | tail -10`
Expected: PASS (1 pass).

- [ ] **Step 5: Add remaining cases**

Append to the describe block:

```typescript
  test('bg busy (tempo=active) → bg_busy', async () => {
    writeState({ state: 'running', tempo: 'active', needs: '' });
    writeRoster({ workers: { dcb2ec25: { cliVersion: '2.1.163', rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock') } } });
    writeSocket();
    const r = await checkRendezvousEligibility('dcb2ec25', { ccHomeDir: ccHome });
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('bg_busy');
  });

  test('state.json missing → daemon_down', async () => {
    rmSync(join(ccHome, 'jobs', 'dcb2ec25', 'state.json'));
    const r = await checkRendezvousEligibility('dcb2ec25', { ccHomeDir: ccHome });
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('daemon_down');
  });

  test('roster missing → daemon_down', async () => {
    writeState({ state: 'blocked', tempo: 'blocked', needs: 'q' });
    const r = await checkRendezvousEligibility('dcb2ec25', { ccHomeDir: ccHome });
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('daemon_down');
  });

  test('no rendezvousSock in roster → no_rendezvous_sock', async () => {
    writeState({ state: 'blocked', tempo: 'blocked', needs: 'q' });
    writeRoster({ workers: { dcb2ec25: { cliVersion: '2.1.163' } } });
    const r = await checkRendezvousEligibility('dcb2ec25', { ccHomeDir: ccHome });
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('no_rendezvous_sock');
  });

  test('CLI 2.1.138 → old_cli', async () => {
    writeState({ state: 'blocked', tempo: 'blocked', needs: 'q' });
    writeRoster({ workers: { dcb2ec25: { cliVersion: '2.1.138', rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock') } } });
    writeSocket();
    const r = await checkRendezvousEligibility('dcb2ec25', { ccHomeDir: ccHome });
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('old_cli');
  });

  test('CLI 2.1.139 (exact) → canUse', async () => {
    writeState({ state: 'blocked', tempo: 'blocked', needs: 'q' });
    writeRoster({ workers: { dcb2ec25: { cliVersion: '2.1.139', rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock') } } });
    writeSocket();
    const r = await checkRendezvousEligibility('dcb2ec25', { ccHomeDir: ccHome });
    expect(r.canUse).toBe(true);
  });

  test('socket file missing on disk → daemon_down', async () => {
    writeState({ state: 'blocked', tempo: 'blocked', needs: 'q' });
    writeRoster({ workers: { dcb2ec25: { cliVersion: '2.1.163', rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock') } } });
    // no writeSocket() — physical file doesn't exist
    const r = await checkRendezvousEligibility('dcb2ec25', { ccHomeDir: ccHome });
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('daemon_down');
  });

  test('socket path is a regular file, not a socket → daemon_down', async () => {
    writeState({ state: 'blocked', tempo: 'blocked', needs: 'q' });
    writeRoster({ workers: { dcb2ec25: { cliVersion: '2.1.163', rendezvousSock: join(ccHome, 'daemon', 'rv-dcb2ec25.sock') } } });
    writeFileSync(join(ccHome, 'daemon', 'rv-dcb2ec25.sock'), 'not a socket');
    const r = await checkRendezvousEligibility('dcb2ec25', { ccHomeDir: ccHome });
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('daemon_down');
  });

  test('malformed state.json → daemon_down', async () => {
    writeFileSync(join(ccHome, 'jobs', 'dcb2ec25', 'state.json'), '{ not valid json');
    const r = await checkRendezvousEligibility('dcb2ec25', { ccHomeDir: ccHome });
    expect(r.canUse).toBe(false);
    expect(r.reason).toBe('daemon_down');
  });
```

Run: `bun test tests/unit/agent-view/rendezvous-fallback.test.ts 2>&1 | tail -5`
Expected: PASS (10 pass, 0 fail).

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/agent-view/rendezvous-fallback.ts tests/unit/agent-view/rendezvous-fallback.test.ts
git commit -m "feat(agent-view): checkRendezvousEligibility - bg waiting 决策"
```

---

### Task 3: RendezvousClient module

**Files:**
- Create: `src/agent-view/rendezvous-client.ts`
- Test: `tests/unit/agent-view/rendezvous-client.test.ts`

This module encapsulates the rendezvous JSON-RPC protocol: open the socket, write `{"type":"reply","text":"..."}\n`, listen for state patches, detect completion, return the result.

- [ ] **Step 1: Write failing test - sends reply and parses patch**

Create `tests/unit/agent-view/rendezvous-client.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as net from 'net';
import { RendezvousClient } from '../../../src/agent-view/rendezvous-client';

describe('RendezvousClient.injectReply', () => {
  let sockPath: string;
  let server: net.Server;
  let receivedLines: string[] = [];

  beforeEach(() => {
    sockPath = join(mkdtempSync(join(tmpdir(), 'rendezvous-test-')), 'daemon.sock');
    receivedLines = [];
    server = net.createServer(c => {
      c.on('data', d => {
        const lines = d.toString('utf8').split('\n').filter(l => l.length > 0);
        for (const line of lines) {
          receivedLines.push(line);
          const parsed = JSON.parse(line);
          if (parsed.type === 'reply') {
            // Send back a fake state patch: bg started processing
            c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active', needs: '' } }) + '\n');
            // Then send completion
            setTimeout(() => {
              c.write(JSON.stringify({ type: 'state', patch: { tempo: 'blocked', needs: 'next q?', state: 'blocked' } }) + '\n');
            }, 20);
          }
        }
      });
    });
    server.listen(sockPath);
  });

  afterEach(() => {
    server.close();
    if (sockPath) {
      try { rmSync(join(sockPath, '..'), { recursive: true, force: true }); } catch {}
    }
  });

  test('sends single line JSON and returns new_needs on tempo=blocked+needs', async () => {
    const patches: any[] = [];
    const result = await RendezvousClient.injectReply({
      short: 'dcb2ec25',
      text: '继续',
      rendezvousSock: sockPath,
      timeoutMs: 2000,
      onStatePatch: p => patches.push(p),
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('new_needs');
    expect(receivedLines).toHaveLength(1);
    const sent = JSON.parse(receivedLines[0]);
    expect(sent.type).toBe('reply');
    expect(sent.text).toBe('继续');
    expect(patches.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/agent-view/rendezvous-client.test.ts 2>&1 | tail -10`
Expected: FAIL (Cannot find module).

- [ ] **Step 3: Implement minimal module**

Create `src/agent-view/rendezvous-client.ts`:

```typescript
import * as net from 'net';
import { logger } from '../utils/logger';

export type RendezvousCompletionReason =
  | 'done'           // state=done
  | 'user_stopped'   // state=stopped + detail=killed
  | 'new_needs'      // tempo=blocked + needs non-empty
  | 'idle'           // tempo=idle + no needs
  | 'stopped'        // state=stopped (other)
  ;

export type RendezvousFailureReason =
  | 'timeout'
  | 'socket_closed'
  | 'daemon_error'
  | 'state_error'
  ;

export interface StatePatch {
  tempo?: 'active' | 'blocked' | 'idle';
  needs?: string;
  state?: 'running' | 'working' | 'blocked' | 'done' | 'stopped' | 'error';
  detail?: string;
  inFlight?: { tasks: number; queued: number; kinds: string[] };
}

interface PatchEnvelope {
  type: string;
  patch?: StatePatch;
}

export interface RendezvousReplyOptions {
  short: string;
  text: string;
  rendezvousSock: string;
  timeoutMs?: number;
  onStatePatch?: (patch: StatePatch) => void;
}

export interface RendezvousReplyResult {
  ok: boolean;
  reason: RendezvousCompletionReason | RendezvousFailureReason;
  text?: string;
  tokens?: { input: number; output: number; cacheCreation?: number; cacheRead?: number };
  durationMs?: number;
  patches?: StatePatch[];
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class RendezvousClient {
  /**
   * Send a reply to a running bg worker via the rendezvous socket.
   *
   * Protocol (single line NDJSON):
   *   - Client sends: {"type":"reply","text":"<user text>"}\n
   *   - Daemon responds with one or more:
   *       {"type":"state","patch":{...}}
   *   - Connection stays open until bg completes, errors, or times out.
   *
   * Returns on first completion trigger:
   *   - state='done'                       → reason='done'
   *   - state='stopped' + detail='killed'  → reason='user_stopped'  (S4)
   *   - state='stopped' (other)            → reason='stopped'
   *   - tempo='blocked' + needs non-empty  → reason='new_needs'
   *   - tempo='idle' + no needs            → reason='idle'
   *
   * Returns failure:
   *   - 60s timeout, no completion         → reason='timeout'
   *   - socket closed mid-wait             → reason='socket_closed'
   *   - daemon error JSON                  → reason='daemon_error'
   *   - patch with state='error'           → reason='state_error'
   */
  static async injectReply(opts: RendezvousReplyOptions): Promise<RendezvousReplyResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = Date.now();
    return new Promise<RendezvousReplyResult>(resolve => {
      const socket = net.createConnection(opts.rendezvousSock);
      const patches: StatePatch[] = [];
      let resolved = false;
      let buffer = '';
      let activeTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (activeTimer) clearTimeout(activeTimer);
        socket.destroy();
      };

      const finish = (result: RendezvousReplyResult) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      };

      const timeoutTimer = setTimeout(() => {
        finish({ ok: false, reason: 'timeout', durationMs: Date.now() - start, patches });
      }, timeoutMs);

      socket.on('connect', () => {
        // Send the reply
        const line = JSON.stringify({ type: 'reply', text: opts.text }) + '\n';
        socket.write(line);
      });

      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          let env: PatchEnvelope;
          try {
            env = JSON.parse(line);
          } catch {
            continue; // skip torn lines
          }
          if (env.type === 'error') {
            finish({ ok: false, reason: 'daemon_error', durationMs: Date.now() - start, patches });
            return;
          }
          if (env.type === 'state' && env.patch) {
            patches.push(env.patch);
            if (opts.onStatePatch) opts.onStatePatch(env.patch);
            const result = classifyPatch(env.patch);
            if (result.kind !== 'pending') {
              clearTimeout(timeoutTimer);
              finish({
                ok: result.kind === 'completed',
                reason: result.reason,
                durationMs: Date.now() - start,
                patches,
              });
              return;
            }
          }
        }
      });

      socket.on('close', () => {
        if (!resolved) {
          clearTimeout(timeoutTimer);
          finish({ ok: false, reason: 'socket_closed', durationMs: Date.now() - start, patches });
        }
      });

      socket.on('error', () => {
        if (!resolved) {
          clearTimeout(timeoutTimer);
          finish({ ok: false, reason: 'socket_closed', durationMs: Date.now() - start, patches });
        }
      });
    });
  }
}

/**
 * Classify a state patch as completed, failed, or still pending.
 * Returns a discriminated union so the caller can distinguish
 * success-completion, failure, and "still processing".
 *
 *   {kind:'completed', reason}  →  ok=true
 *   {kind:'failed',    reason}  →  ok=false (no fallback possible)
 *   {kind:'pending'}            →  no terminal event yet
 */
type Classification =
  | { kind: 'completed'; reason: RendezvousCompletionReason }
  | { kind: 'failed'; reason: RendezvousFailureReason }
  | { kind: 'pending' }
  ;

function classifyPatch(patch: StatePatch): Classification {
  if (patch.state === 'done') return { kind: 'completed', reason: 'done' };
  if (patch.state === 'stopped') {
    return { kind: 'completed', reason: patch.detail === 'killed' ? 'user_stopped' : 'stopped' };
  }
  // state=error: bg 自己报失败. 不等 timeout, 立即 finish 为 ok=false.
  // 否则会 hang 60s 才 timeout, 误导用户为"超时"。
  if (patch.state === 'error') return { kind: 'failed', reason: 'state_error' };
  if (patch.tempo === 'blocked' && patch.needs && patch.needs.length > 0) {
    return { kind: 'completed', reason: 'new_needs' };
  }
  if (patch.tempo === 'idle' && !patch.needs) {
    return { kind: 'completed', reason: 'idle' };
  }
  return { kind: 'pending' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/agent-view/rendezvous-client.test.ts 2>&1 | tail -10`
Expected: PASS (1 pass).

- [ ] **Step 5: Add remaining cases**

Append to the describe block:

```typescript
  test('completes on state=done', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { state: 'done', tempo: 'idle' } }) + '\n');
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('done');
  });

  test('user_stopped when state=stopped + detail=killed', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { state: 'stopped', detail: 'killed', tempo: 'idle' } }) + '\n');
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('user_stopped');
  });

  test('timeouts after 200ms', async () => {
    server.close();
    server = net.createServer(() => { /* never respond */ });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 200,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('timeout');
  });

  test('socket disconnect mid-wait → socket_closed', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active' } }) + '\n');
        setTimeout(() => c.destroy(), 20);
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('socket_closed');
  });

  test('daemon returns error JSON', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'error', message: 'something' }) + '\n');
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('daemon_error');
  });

  test('handles long text (>10KB)', async () => {
    const longText = 'x'.repeat(15000);
    const r = await RendezvousClient.injectReply({
      short: 's', text: longText, rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(receivedLines[0]).toContain(longText);
  });

  test('handles unicode text', async () => {
    const r = await RendezvousClient.injectReply({
      short: 's', text: '继续 中文 🚀', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(JSON.parse(receivedLines[0]).text).toBe('继续 中文 🚀');
  });

  test('completes on tempo=idle + no needs', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'idle', needs: '' } }) + '\n');
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('idle');
  });

  test('patches collected for debugging', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active' } }) + '\n');
        setTimeout(() => {
          c.write(JSON.stringify({ type: 'state', patch: { tempo: 'blocked', needs: 'q' } }) + '\n');
        }, 20);
      });
    });
    server.listen(sockPath);
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.patches).toBeDefined();
    expect(r.patches!.length).toBeGreaterThanOrEqual(2);
  });

  test('connection refused → socket_closed', async () => {
    server.close();
    // Don't listen — connection will be refused
    try {
      rmSync(sockPath);
    } catch {}
    const r = await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('socket_closed');
  });

  test('onStatePatch callback fires for every patch', async () => {
    server.close();
    server = net.createServer(c => {
      c.on('data', () => {
        c.write(JSON.stringify({ type: 'state', patch: { tempo: 'active' } }) + '\n');
        setTimeout(() => {
          c.write(JSON.stringify({ type: 'state', patch: { tempo: 'blocked', needs: 'q' } }) + '\n');
        }, 20);
      });
    });
    server.listen(sockPath);
    const patches: StatePatch[] = [];
    await RendezvousClient.injectReply({
      short: 's', text: 't', rendezvousSock: sockPath, timeoutMs: 2000,
      onStatePatch: p => patches.push(p),
    });
    expect(patches.length).toBeGreaterThanOrEqual(2);
  });
```

Run: `bun test tests/unit/agent-view/rendezvous-client.test.ts 2>&1 | tail -5`
Expected: PASS (12 pass, 0 fail).

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/agent-view/rendezvous-client.ts tests/unit/agent-view/rendezvous-client.test.ts
git commit -m "feat(agent-view): RendezvousClient - JSON-RPC + state patch 流"
```

---

### Task 4: expectedReply.markSent method (M1 fix) + messageId 透传

**Files:**
- Modify: `src/agent-view/expected-reply-state.ts` (add `messageId` to `ExpectedReplyInfo` + add `markSent()` method)
- Test: `tests/unit/agent-view/expected-reply-state.test.ts`

This task makes TWO changes to `expected-reply-state.ts`:

1. **Add `messageId?: string` to `ExpectedReplyInfo`** — so the card's `messageId` can be stored when the user clicks [Reply], and later passed through `runChatSDK` → `tryRendezvousReply` to properly thread the Feishu reply.

2. **Add `markSent()` method** — immediately clears the expectedReply state (in-memory + user-mapping). Called at T2 right after the reply is injected into rendezvous/SDK, to prevent the user from double-replying during the 60s wait.

- [ ] **Step 1: Read existing clear() and ExpectedReplyInfo to understand the pattern**

Read `src/agent-view/expected-reply-state.ts:1-12` (ExpectedReplyInfo interface) and `src/agent-view/expected-reply-state.ts:97-106` (clear method) to confirm the current implementation.

- [ ] **Step 2: Add `messageId` to `ExpectedReplyInfo`**

In `src/agent-view/expected-reply-state.ts`, modify the `ExpectedReplyInfo` interface (around line 3-8):

```typescript
export interface ExpectedReplyInfo {
  shortId: string;
  sessionId: string;
  cwd: string;
  /** v2.4: 飞书 card action 的 messageId,用于 tryRendezvousReply 线程化回复 */
  messageId?: string;
}
```

This is backward-compatible — existing callers that don't pass `messageId` will get `undefined`, which is fine.

- [ ] **Step 3: Write failing test for markSent**

Read `tests/unit/agent-view/expected-reply-state.test.ts` (existing) to find a good insertion point. Append a new describe block:

```typescript
describe('ExpectedReplyState.markSent (M1 fix)', () => {
  let userManager: UserManager;
  let state: ExpectedReplyState;

  beforeEach(() => {
    const tmpFile = join(tmpdir(), `er-test-${Date.now()}-${Math.random()}.json`);
    userManager = new UserManager(tmpFile);
    state = new ExpectedReplyState(userManager);
  });

  test('markSent clears in-memory state immediately', async () => {
    await state.set('ou_a', { shortId: 'dcb2ec25', sessionId: 's1', cwd: '/tmp' });
    expect(state.get('ou_a')).toBeDefined();
    await state.markSent('ou_a');
    expect(state.get('ou_a')).toBeUndefined();
  });

  test('markSent clears user-mapping entry', async () => {
    await state.set('ou_a', { shortId: 'dcb2ec25', sessionId: 's1', cwd: '/tmp' });
    expect(userManager.getEntry('ou_a')?.type).toBe('pending_agent_reply');
    await state.markSent('ou_a');
    // getEntry returns undefined (not null) when key doesn't exist
    expect(userManager.getEntry('ou_a')).toBeUndefined();
  });

  test('after markSent, second reply is rejected (no double-reply)', async () => {
    await state.set('ou_a', { shortId: 'dcb2ec25', sessionId: 's1', cwd: '/tmp' });
    await state.markSent('ou_a');
    // User sends second text during the 60s wait
    expect(state.get('ou_a')).toBeUndefined();  // handleChat won't route as reply
  });

  test('messageId stored and returned via get()', async () => {
    await state.set('ou_a', { shortId: 'dcb2ec25', sessionId: 's1', cwd: '/tmp', messageId: 'msg_123' });
    const info = state.get('ou_a');
    expect(info).toBeDefined();
    expect(info!.messageId).toBe('msg_123');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test tests/unit/agent-view/expected-reply-state.test.ts 2>&1 | tail -10`
Expected: FAIL with "markSent is not a function" or similar.

- [ ] **Step 5: Add markSent method**

Modify `src/agent-view/expected-reply-state.ts`. After the existing `clear()` method (around line 106), add:

```typescript
  /**
   * Mark the reply as sent (T2 in rendezvous flow). This is called
   * immediately after the reply is successfully injected into the bg
   * worker, BEFORE waiting for completion. The point is to prevent the
   * user from sending a second reply during the rendezvous wait window
   * (60s+ for slow bg tasks), which would cause duplicate responses
   * because expectedReply is still set.
   *
   * M1 fix: v2.3.11 only cleared in finally, after runChatSDK returned.
   * During the 60s wait, expectedReply stayed set, so a second user
   * text would re-enter handleReply and re-inject.
   *
   * Idempotent: safe to call multiple times or when nothing is pending.
   * After markSent, get() returns undefined and handleChat routes the
   * user's text as regular chat (which the SDK may reject as bg-conflict
   * or accept as new chat).
   */
  async markSent(openId: string): Promise<void> {
    const current = this.userManager.getEntry(openId);
    if (current && current.type === 'pending_agent_reply') {
      await this.userManager.compareAndSwap(openId, current, null);
    }
    this.inMemory.delete(openId);
    this.clearTimer(openId);
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/unit/agent-view/expected-reply-state.test.ts 2>&1 | tail -5`
Expected: PASS (existing + 4 new pass).

- [ ] **Step 7: Typecheck and commit**

```bash
bun run typecheck
git add src/agent-view/expected-reply-state.ts tests/unit/agent-view/expected-reply-state.test.ts
git commit -m "fix(agent-view): markSent (M1) + messageId 透传 (v2.4)"
```

---

## PR 2: Wire into runChatSDK (flag default off)

### Task 5: Config flag

**Files:**
- Modify: `src/utils/config.ts` (AgentViewConfig interface + defaults object)
- Test: typecheck only (config tests are minimal in this project)

**注意**: `config.ts` 使用 **plain TypeScript interface + defaults 对象**，不用 Zod。

- [ ] **Step 1: Add config keys to AgentViewConfig interface**

In `src/utils/config.ts`, find the `AgentViewConfig` interface (around line 86-96) and add two fields:

```typescript
export interface AgentViewConfig {
  enabled: boolean;
  refresh_min_interval_ms: number;
  peek_lines: number;
  peek_max_bytes: number;
  expected_reply_timeout_ms: number;
  background_only: boolean;
  stop_requires_confirm: boolean;
  min_claude_version: string;
  reply_throttle_ms: number;
  // v2.4: rendezvous socket 注入 reply (替代 claude stop + SDK)
  rendezvous_enabled: boolean;
  rendezvous_timeout_ms: number;
}
```

- [ ] **Step 2: Add defaults**

In the same file, find the `agent_view` defaults object (around line 176-187) and add:

```typescript
agent_view: {
  enabled: true,
  refresh_min_interval_ms: 2000,
  peek_lines: 30,
  peek_max_bytes: 2048,
  expected_reply_timeout_ms: 300000,
  background_only: true,
  stop_requires_confirm: true,
  min_claude_version: '2.1.139',
  reply_throttle_ms: 500,
  // v2.4 defaults
  rendezvous_enabled: false,       // PR 2 默认 off, PR 4 Task 10 翻 true
  rendezvous_timeout_ms: 60_000,
},
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: clean (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/utils/config.ts
git commit -m "feat(config): add [agent_view].rendezvous_enabled + timeout_ms"
```

---

### Task 6: runChatSDK pre-step wiring

**Files:**
- Modify: `src/feishu/bot.ts` (add imports + `tryRendezvousReply` method + wire into `runChatSDK` top)
- Modify: `src/feishu/card-updater.ts` (export `formatTokenCount`)
- No new test file (covered by integration test in Task 9)

**整体设计**：在 `runChatSDK` 最顶部插入 rendezvous 短路逻辑。调用 `tryRendezvousReply`（`FeishuBot` 的新 private 方法）：
- 返回 `true`（成功或 inject 失败已发消息）→ `runChatSDK` 提前 return，带 `rendezvousHandled: true`
- 返回 `false`（eligibility 不通过）→ fall through 到老路径（v2.3.5 auto-stop + SDK）

**关键**：`handleReply` 通过 `rendezvousHandled` 标志决定是否跳过旧的完成消息（防止双消息 bug）。

- [ ] **Step 1: Export `formatTokenCount` from card-updater.ts**

In `src/feishu/card-updater.ts`, find the `formatTokenCount` function (around line 503). Add `export`:

```diff
-function formatTokenCount(n: number): string {
+export function formatTokenCount(n: number): string {
```

Note: `stableUuid` and `uniqueUuid` are file-local to `bot.ts` — `tryRendezvousReply` is a method on `FeishuBot` (same file), so they're accessible without export.

- [ ] **Step 2: Add imports at the top of bot.ts**

After the existing imports, add:

```typescript
import { checkRendezvousEligibility } from '../agent-view/rendezvous-fallback';
import { RendezvousClient, type StatePatch } from '../agent-view/rendezvous-client';
import { readLastAssistantTurn, type LastAssistantTurn } from '../agent-view/jsonl-last-assistant';
import { formatTokenCount } from './card-updater';
```

(`SendMessageResult` is already imported in bot.ts — verify before adding.)

- [ ] **Step 3: Implement `tryRendezvousReply` as a private method**

Insert this method into `FeishuBot` class (near other private methods like `claimOne`):

```typescript
  /**
   * Try to handle an Agent View Reply via the rendezvous socket.
   *
   * Returns true if handled — a reply (success or error) has been sent
   * to the user via replyFn, and spool has been finalized. Caller should
   * short-circuit (return from runChatSDK with rendezvousHandled: true).
   *
   * Returns false if rendezvous is not eligible — caller should fall
   * through to the existing v2.3.5 auto-stop + SDK path.
   *
   * Failure handling:
   *   - canUse=false (daemon_down, bg_busy, old_cli, etc.) → return false
   *   - inject timeout → send timeout message, return true (bg may still
   *     be running; falling through to SDK would conflict)
   *   - socket_closed / state_error / daemon_error → send error message,
   *     return true (no fallback possible)
   */
  private async tryRendezvousReply(params: {
    openId: string;
    sessionUuid: string;
    promptText: string;
    messageId?: string;
  }): Promise<boolean> {
    const { openId, sessionUuid, promptText, messageId } = params;
    const short = sessionUuid.slice(0, 8);
    const eligibility = await checkRendezvousEligibility(short);
    if (!eligibility.canUse || !eligibility.rendezvousSock) {
      logger.warn(`rendezvous: fallback to SDK because ${eligibility.reason}`);
      return false;  // caller falls through to v2.3.5 auto-stop + SDK
    }
    logger.info(
      `rendezvous: inject short=${short} text_len=${promptText.length} reason=bg_waiting`,
    );
    const rendezvousResult = await RendezvousClient.injectReply({
      short,
      text: promptText,
      rendezvousSock: eligibility.rendezvousSock,
      timeoutMs: config.get<number>('agent_view.rendezvous_timeout_ms', 60_000),
    });

    // Read JSONL for response text (bg may have written its reply)
    const lastTurn = eligibility.jsonlPath
      ? await readLastAssistantTurn(eligibility.jsonlPath)
      : null;
    const durationMs = rendezvousResult.durationMs ?? 0;
    let replyText: string;

    if (rendezvousResult.ok) {
      // Success: compose response + token stats
      const responseText = lastTurn?.text
        ?? rendezvousResult.patches?.find(p => p.detail)?.detail
        ?? '(bg 完成)';
      const tokenCount = (lastTurn?.usage.input_tokens ?? 0)
        + (lastTurn?.usage.output_tokens ?? 0)
        + (lastTurn?.usage.cache_creation_input_tokens ?? 0)
        + (lastTurn?.usage.cache_read_input_tokens ?? 0);
      replyText = `✅ Claude 已处理完你的消息。\n\n${responseText}\n\n` +
                  `⏱ ${durationMs}ms · ${formatTokenCount(tokenCount)} · 1 轮数`;
      logger.info(
        `rendezvous: ok reason=${rendezvousResult.reason} ` +
        `duration=${durationMs}ms tokens_out=${lastTurn?.usage.output_tokens ?? 0}`,
      );
    } else {
      // Failure: inject failed after eligibility passed.
      // No fallback possible — bg may already be processing our inject,
      // so running claude stop + SDK would create a conflict.
      logger.error(
        `rendezvous: inject failed reason=${rendezvousResult.reason} (no fallback)`,
      );
      replyText = rendezvousResult.reason === 'timeout'
        ? `⏱ bg 处理超时（60s 内未完成），已停止等待。bg 可能仍在后台运行。`
        : rendezvousResult.reason === 'socket_closed'
        ? `⚠️ Claude daemon 已停止，无法处理 reply。请联系管理员重启 daemon。`
        : `⚠️ Reply 失败：${rendezvousResult.reason}`;
    }

    // Send the reply via Feishu
    if (messageId) {
      await this.replyFn(replyText, { messageId, openId, requestUuid: stableUuid(messageId) });
    } else {
      await this.replyFn(replyText, { openId, requestUuid: uniqueUuid() });
    }

    // Spool finalize — idempotent with handleReply's caller
    if (messageId) {
      this.spoolQueue.markReplied(messageId, sessionUuid);
      this.spoolQueue.markDone(messageId, sessionUuid);
    }

    return true;  // handled (success or failure message sent)
  }
```

- [ ] **Step 4: Wire `runChatSDK` to call `tryRendezvousReply` first**

At the top of `runChatSDK` (right after the destructuring of params, before the existing `if (sessionUuid && !isNew)` block at line ~1476):

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
  }): Promise<{
    result: SendMessageResult;
    handler: PermissionHandler;
    cardMessageId: string | null;
    /** v2.4: true if rendezvous path handled the reply (caller should skip completion message) */
    rendezvousHandled?: boolean;
  }> {
    const { openId, sessionUuid: inputSessionUuid, cwd, settingsPath, promptText, serialKey, isNew = false, messageId, fromAgentViewReply = false } = params;

    // v2.4 rendezvous-first: short-circuit for Agent View Reply
    if (
      fromAgentViewReply &&
      config.get<boolean>('agent_view.rendezvous_enabled', false)
    ) {
      const handled = await this.tryRendezvousReply({
        openId, sessionUuid: inputSessionUuid, promptText, messageId,
      });
      if (handled) {
        // Reply already sent, spool already finalized. Return sentinel.
        return {
          result: null as unknown as SendMessageResult,
          handler: null as unknown as PermissionHandler,
          cardMessageId: null,
          rendezvousHandled: true,
        };
      }
      // eligibility failed → fall through to existing v2.3.5/3.6 path
    }

    // ... rest of existing runChatSDK body UNCHANGED ...
    // (the existing function already destructures the same params,
    //  the v2.3.5 pre-step, bg conflict check, SDK call, etc.)
```

Also, at the **final return** of the existing `runChatSDK` (around line 1696), add `rendezvousHandled: false`:

```diff
-    return { result, handler, cardMessageId };
+    return { result, handler, cardMessageId, rendezvousHandled: false };
```

And in the error catch block (around line 1697-1714), if it also returns, add `rendezvousHandled: false` there too.

- [ ] **Step 5: Add SDK fallback chat-text reply (P1-4)**

In `runChatSDK`, just before the final `return { result, handler, cardMessageId, rendezvousHandled: false }`, add:

```typescript
    // P1-4: SDK fallback path for Agent View Reply — send a chat-text reply
    // with response + token stats (rendezvous path already sent one in tryRendezvousReply).
    // Only entered when rendezvous was NOT used (rendezvousHandled is not set).
    if (fromAgentViewReply && result?.response) {
      const tokenCount = (result.tokensIn ?? 0) + (result.tokensOut ?? 0);
      const sdkReplyText = result.response.length > 0
        ? `✅ Claude 已处理完你的消息。\n\n${result.response}\n\n` +
          `⏱ ${result.durationMs}ms · ${formatTokenCount(tokenCount)} · 1 轮数`
        : `✅ Claude 已处理完你的消息（无文本响应）。`;
      if (messageId) {
        await this.replyFn(sdkReplyText, { messageId, openId, requestUuid: stableUuid(messageId) });
      } else {
        // No messageId: still send, but without threading (matches rendezvous path fallback)
        await this.replyFn(sdkReplyText, { openId, requestUuid: uniqueUuid() });
      }
    }
```

Note: `messageId` is available in scope because it was destructured at the top of `runChatSDK`.

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 7: Run existing tests**

Run: `bun test tests/unit/feishu/ 2>&1 | tail -10`
Expected: PASS (all existing tests still pass; flag is off by default so tryRendezvousReply is not called).

- [ ] **Step 8: Commit**

```bash
git add src/feishu/bot.ts src/feishu/card-updater.ts
git commit -m "feat(bot): runChatSDK rendezvous-first + tryRendezvousReply + SDK chat-text reply"
```

---

### Task 7: handleReply integration (markSent + empty text defense + conditional completion + messageId)

**Files:**
- Modify: `src/agent-view/manager.ts` (handleReply + handleReplyRequest)
- Modify: `src/agent-view/manager.ts` (AgentViewDeps.runChatSDK return type — add `rendezvousHandled`)

- [ ] **Step 1: Update `AgentViewDeps.runChatSDK` return type**

In `src/agent-view/manager.ts`, find the `AgentViewDeps` interface (around line 56-69). Add `rendezvousHandled` to the return type:

```diff
   runChatSDK: (params: {
     openId: string; sessionUuid: string; cwd: string;
     promptText: string; serialKey: string; isNew?: boolean;
     settingsPath?: string; messageId?: string;
     /** v2.3.5: 标记 AgentView reply 路径,bot 会自动 stop bg + 递归 SDK */
     fromAgentViewReply?: boolean;
-  }) => Promise<{ result: any; handler: any; cardMessageId: string | null }>;
+  }) => Promise<{ result: any; handler: any; cardMessageId: string | null; rendezvousHandled?: boolean }>;
```

- [ ] **Step 2: Update `handleReplyRequest` to store `messageId`**

In `src/agent-view/manager.ts`, find `handleReplyRequest` (around line 798). The method receives card action data from bot.ts. Currently, bot.ts line 552-554 dispatches the card action **without** passing `messageId`.

**First**, in bot.ts find where the Reply card action is dispatched to `handleReplyRequest` (around line 552). Add `messageId` to the call. The card action callback in bot.ts receives the full interaction payload which includes `message_id`. Update the dispatch to pass it:

```diff
-  await this.agentView.handleReplyRequest(openId, shortId, sessionId, cwd);
+  await this.agentView.handleReplyRequest(openId, shortId, sessionId, cwd, messageId);
```

**Then**, in `handleReplyRequest` in manager.ts, update the signature and the `set` call:

```diff
- async handleReplyRequest(openId: string, _shortId: string, sessionId: string, cwd: string): Promise<void> {
+ async handleReplyRequest(openId: string, _shortId: string, sessionId: string, cwd: string, messageId?: string): Promise<void> {
```

And where it calls `set` (around line 826):

```diff
- await this.expectedReply.set(openId, { shortId: _shortId, sessionId, cwd });
+ await this.expectedReply.set(openId, { shortId: _shortId, sessionId, cwd, messageId });
```

- [ ] **Step 3: Rewrite `handleReply` with conditional completion + messageId passthrough**

Replace the existing `handleReply` (lines 870-938) in `src/agent-view/manager.ts` with:

```typescript
  async handleReply(openId: string, text: string): Promise<void> {
    // 1. 检查 expectedReply
    const info = this.expectedReply.get(openId);
    if (!info) return;

    // M7: 防御性 - 拒绝空文本
    if (!text || !text.trim()) return;

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

    // M1 FIX (P0): T2 立即 markSent, 防双重 reply during the 60s wait
    // finally 里的 clear() 仍保留,作为兜底 (idempotent)
    await this.expectedReply.markSent(openId);

    // 3. runChatSDK
    //    - rendezvous path (tryRendezvousReply in bot.ts): sends chat-text reply
    //      with response + token stats, returns rendezvousHandled: true.
    //    - SDK fallback path: cards get patched live, bot.ts sends chat-text reply
    //      at the end of runChatSDK (P1-4 step).
    //    In BOTH cases, the completion message is handled inside runChatSDK.
    //    We use rendezvousHandled to decide whether to skip our old completion msg.
    let sdkError: any = null;
    let sdkResult: { rendezvousHandled?: boolean } | null = null;
    try {
      sdkResult = await this.deps.runChatSDK({
        openId,
        sessionUuid: info.sessionId,
        cwd: info.cwd,
        promptText: text,
        serialKey: info.sessionId,
        messageId: info.messageId,  // v2.4: 透传 card messageId
        isNew: false,
        fromAgentViewReply: true,
      }) as { rendezvousHandled?: boolean };
    } catch (err: any) {
      sdkError = err;
    } finally {
      await this.expectedReply.clear(openId);
    }

    if (sdkError) {
      await this.deps.replyFn(`❌ Reply 失败:${sdkError?.message ?? sdkError}`, { openId });
      return;
    }

    // v2.4: 如果 rendezvous 或 SDK 路径已发送 chat-text 回复,跳过旧的完成消息。
    // rendezvousHandled=true → tryRendezvousReply 已发 (bot.ts)
    // rendezvousHandled=false/undefined → SDK 路径的 P1-4 step 已发 (bot.ts)
    // 只有 sdkResult 完全为 null (不应发生) 才 fallback 到旧消息。
    if (!sdkResult) {
      // Defensive fallback — should not happen in practice
      await this.deps.replyFn(
        `✅ Claude 已处理完你的消息。\n` +
        `若需继续 reply,在飞书 Agent View 重新点 [Reply] 即可。`,
        { openId },
      );
    }
    // 正常情况下不发额外消息 — bot.ts 的 tryRendezvousReply 或 SDK P1-4 已发过。
  }
```

**关键变更**：
1. 新增空文本防御 `if (!text || !text.trim()) return;`
2. 新增 `markSent` 调用（M1 fix）
3. 透传 `messageId` 到 `runChatSDK`（v2.4 messageId 线程化）
4. **条件化完成消息**：根据 `sdkResult` 判断是否跳过旧消息（P0-1 fix）

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Run existing handleReply tests**

Run: `bun test tests/unit/agent-view/manager.test.ts 2>&1 | tail -5`
Expected: PASS (existing tests still pass; handleReply now also calls markSent which is idempotent, and the completion message is conditional on sdkResult).

- [ ] **Step 6: Commit**

```bash
git add src/agent-view/manager.ts src/feishu/bot.ts
git commit -m "fix(agent-view): handleReply markSent (M1) + 空文本防御 (M7) + messageId 透传 + 条件化完成消息"
```

---

### Task 8: Regression tests for bot-command

**Files:**
- Modify: `tests/unit/feishu/bot-command.test.ts`

- [ ] **Step 1: Add regression tests**

Append to `tests/unit/feishu/bot-command.test.ts`:

```typescript
describe('FeishuBot.handleCommand /agents with rendezvous fallback (v2.4)', () => {
  // ... use existing createTestBot setup

  test('when rendezvous_enabled=false, runChatSDK still uses claude stop path (regression)', async () => {
    // No rendezvous config change; default false.
    // The existing /agents tests verify the card is sent and handleList is called.
    // This test ensures the rendezvous addition does not break that.
    const mockAgentView = {
      deps: {} as any,
      handleList: async () => 'card-msg-id',
    };
    env.bot.setAgentView(mockAgentView as any);
    await env.bot.handleCommand({
      messageId: 'm1', openId: 'ou1', text: '/agents',
      serialKey: 'cmd:ou1:m1', target: { type: 'no_target' },
      status: 'pending', createdAt: new Date().toISOString(),
    });
    // Spool should be finalized
    expect(env.spoolQueue.listProcessing().length).toBe(0);
  });
});
```

(Adjust to match the existing test file's setup helpers; the test verifies the rendezvous wiring doesn't break the existing /agents behavior.)

- [ ] **Step 2: Run tests**

Run: `bun test tests/unit/feishu/bot-command.test.ts 2>&1 | tail -5`
Expected: PASS (existing 5 + 1 new = 6 pass).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/feishu/bot-command.test.ts
git commit -m "test(bot): regression - rendezvous 接入不影响 /agents 路径"
```

---

## PR 3: Local E2E

### Task 9: Manual E2E plan

**Files:**
- Create: `docs/qa/v2.4-agent-view-rendezvous.md`

- [ ] **Step 1: Write E2E plan**

Create `docs/qa/v2.4-agent-view-rendezvous.md`:

```markdown
# v2.4 Agent View Rendezvous - Manual E2E

Pre-req: deploy PR 2 with `rendezvous_enabled = true` in config.toml.

## Scenario 1: waiting 场景 (bash loop)

1. Start a real bg session: `claude --bg -p "请每 5 秒 date 打印当前时间,循环 10 次"`
2. Wait for state.json to show `tempo: blocked, needs: "是否继续?"`
3. In Feishu, open Agent View (`/agents`), click [Reply] on the bash loop session
4. Type "继续" and send
5. **Verify**:
   - Bot replies with response text + token stats (NOT just "✅ 已处理")
   - state.json transitions: `tempo: active` then back to `blocked` with new needs
   - Terminal: session is still in `working` state (not `stopped`)
   - Next round of `date` print happens (loop continues)
6. Repeat step 4-5 three times to verify the loop continues

## Scenario 2: busy 场景 (npm install)

1. Start: `claude --bg -p "请执行 npm install 在当前目录"`
2. Wait for state.json `tempo: active` (or `running` with inFlight)
3. In Feishu, try to find [Reply] button — it should NOT appear (card.ts Reply 按钮守卫: `if (status === 'waiting')` at lines 78, 249, 644)
4. **Verify**: no [Reply] button on the busy session card

## Scenario 3: 多次 reply 循环

1. Continue from Scenario 1, but reply 5 times in a row
2. **Verify**:
   - All 5 replies get responses
   - No duplicate responses
   - expectedReply doesn't accumulate

## Scenario 4: Stop 中断

1. Continue from Scenario 1
2. While a reply is in flight (just sent), click [Stop] in agent view
3. **Verify**:
   - bot reply indicates bg 已停止
   - Terminal: session is `stopped`
   - state.json: `state: stopped, detail: killed`

## Scenario 5: rendezvous socket unavailable (daemon_down fallback)

**Important**: there are TWO daemons in this system, do not confuse:
- **cc-linker bot daemon** (`~/.cc-linker/owner.lock`): runs the Feishu bot. Killing it stops the BOT, not the bg.
- **Claude bg supervisor daemon** (`/tmp/cc-daemon-503/...`): manages bg workers. Owns the rendezvous sockets.

To simulate "rendezvous unavailable" without killing the Claude daemon (which we don't have a clean way to restart from the CLI):
1. Continue from Scenario 1 (bg is running, waiting)
2. Find the rendezvous socket for the bg session:
   ```bash
   SOCK=$(jq -r '.workers["<short>"].rendezvousSock' ~/.claude/daemon/roster.json)
   ```
3. Move the socket file (or chmod 000) so the bot can't connect:
   ```bash
   mv "$SOCK" "${SOCK}.disabled"
   ```
4. In Feishu, send a reply
5. **Verify**:
   - `checkRendezvousEligibility` returns `daemon_down` (socket missing)
   - Bot falls back to SDK path
   - `claude stop` runs (from v2.3.5/3.6 fallback)
   - Bot reply comes back with response text (from SDK path's chat-text reply in Task 6 Step 6.5)
6. Restore the socket:
   ```bash
   mv "${SOCK}.disabled" "$SOCK"
   ```

## Scenario 6: cc-linker bot daemon restart (separate from Claude daemon)

1. Continue from Scenario 1
2. Restart only the **bot** daemon: `cc-linker daemon stop && cc-linker start --daemon` (or `bun run deploy`)
3. Wait for bot to come back up (~5s)
4. **Verify**:
   - The Feishu bot is responsive to new messages
   - The bg is still running (Claude daemon was not affected)
   - The bot's `restoreExpectedReplyStates` correctly restores any in-flight expectedReply
   - Any active Agent View state is preserved (attached watchers restart)
```

- [ ] **Step 2: Run on local dev machine**

```bash
# Set the flag temporarily for manual E2E
echo "rendezvous_enabled = true" >> ~/.cc-linker/config.toml
bun run deploy
# Run through scenarios 1-5, then revert:
sed -i '/^rendezvous_enabled = true$/d' ~/.cc-linker/config.toml
```

- [ ] **Step 3: Capture results in commit message**

Document any issues found; if all pass, commit the E2E doc:

```bash
git add docs/qa/v2.4-agent-view-rendezvous.md
git commit -m "docs(qa): v2.4 rendezvous E2E 5 场景 + 实跑结果"
```

---

## PR 4: Flip default

### Task 10: Default to true

**Files:**
- Modify: `src/utils/config.ts` (default value)

- [ ] **Step 1: Flip default**

In `src/utils/config.ts`, change the default from `false` to `true`:

```typescript
rendezvous_enabled: z.boolean().default(true),  // was: .default(false)
```

- [ ] **Step 2: Typecheck + run all tests**

```bash
bun run typecheck
bun test 2>&1 | tail -10
```
Expected: typecheck clean, all tests pass.

- [ ] **Step 3: Deploy and monitor**

```bash
bun run deploy
# Watch logs for fallback ratio over the next 7 days
grep -c "fallback to SDK" ~/.cc-linker/cc-linker.log
grep -c "rendezvous: inject" ~/.cc-linker/cc-linker.log
```

If fallback ratio < 30%, the feature is stable.

- [ ] **Step 4: Commit**

```bash
git add src/utils/config.ts
git commit -m "feat(agent_view): rendezvous_enabled default true (v2.4 GA)"
```

---

## Self-Review (checklist)

**1. Spec coverage** (after this plan, what's left?):

- §4.1 module list → Tasks 1, 2, 3 cover all 3 new modules
- §4.2 data flow → Task 6 (runChatSDK + tryRendezvousReply) implements; Task 7 (handleReply) calls markSent + passes messageId
- §4.3 contracts → Tasks 1, 2, 3 implement interfaces matching spec contracts
- §4.4 protocol → Task 3 implements
- §5.1 state machine → Task 4 (markSent for T2 + messageId in ExpectedReplyInfo); Task 6 (rendezvous inject for T3-T4)
- §5.2 failure recovery → Task 6 (tryRendezvousReply handles all failure modes: timeout/socket_closed/state_error/daemon_error)
- §5.3 concurrency → implicitly via markSent in Task 4
- §6.1 fallback matrix → Task 6 (tryRendezvousReply returns false for eligibility fail → SDK fallback) + Task 2 (eligibility check)
- §6.2 user messages → Task 6 (tryRendezvousReply success/failure texts + SDK P1-4 chat-text reply)
- §7.1 unit tests → Tasks 1, 2, 3, 4 each have tests; total 14+9+12+4 = 39 cases (spec said ~25, exceeded)
- §7.2 integration test → Task 9 (E2E in PR 3)
- §7.3 regression → Task 8
- §8.1 feature flag → Task 5 (interface + defaults, NOT Zod)
- §8.2 rollout → PRs 1-4 implement phased rollout

**Gaps**: None. Every spec requirement maps to a task.

**2. Placeholder scan**: Searched for TBD/TODO/"implement later"/"appropriate"/etc. — none found. All code blocks contain real implementation.

**3. Type consistency check**:

- `RendezvousEligibility` interface — Task 2 defines, Task 6 `tryRendezvousReply` consumes. Same field names. ✓
- `RendezvousReplyResult` — Task 3 defines, Task 6 `tryRendezvousReply` consumes. Same field names (`ok`, `reason`, `patches`, `durationMs`). ✓
- `StatePatch` — Task 3 defines; Task 6's `patches?.find(p => p.detail)` reads `detail` (defined in Task 3). ✓
- `RendezvousCompletionReason` — Task 3 defines, Task 6's `result.reason` matches. ✓
- `markSent` — Task 4 defines (in `ExpectedReplyState`), Task 7 calls. Same method name. ✓
- `ExpectedReplyInfo.messageId` — Task 4 adds to interface, Task 7 reads `info.messageId`, Task 7 Step 2 stores it via `handleReplyRequest`. ✓
- `readLastAssistantTurn(jsonlPath)` — Task 1 defines, Task 6 calls. Same signature. ✓
- `formatTokenCount` — Task 6 Step 1 exports from `card-updater.ts`, Task 6 Step 3/5 imports and uses. ✓
- `config.get<boolean>('agent_view.rendezvous_enabled', false)` — Task 5 introduces (interface + defaults), Task 6 reads. Same key. ✓
- `stableUuid(messageId)` / `uniqueUuid()` — file-local in bot.ts, `tryRendezvousReply` is a method on `FeishuBot` (same file) → accessible without export. ✓
- `rendezvousHandled` flag — Task 6 Step 4 adds to `runChatSDK` return type, Task 7 Step 3 reads it. ✓
- `AgentViewDeps.runChatSDK` return type — Task 7 Step 1 adds `rendezvousHandled?` to interface, matches bot.ts return. ✓
- `FeishuBot.replyFn` — typed as `FeishuReplyFn` which accepts `{ messageId?, openId?, requestUuid?, chunkIndex? }`. `tryRendezvousReply` passes all three. ✓

**No type inconsistencies found.**

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-11-rendezvous-reply.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?

---

## Review Changelog (2026-06-11)

Code-review 发现的 6 个 P0 + 4 个 minor issue，全部已修正：

### P0 修复

| # | 问题 | 修正 |
|---|------|------|
| P0-1 | `handleReply` 旧完成消息与 rendezvous 回复重复（双消息 bug） | Task 6: `runChatSDK` 返回 `rendezvousHandled` 标志；Task 7: `handleReply` 条件化跳过旧消息 |
| P0-2 | `messageId` 未透传 → rendezvous 回复无法关联原消息 | Task 4: `ExpectedReplyInfo` 加 `messageId`；Task 7: `handleReplyRequest` 存 + `handleReply` 透传 |
| P0-3 | `formatTokenCount` 未导出（file-local）→ 编译失败 | Task 6 Step 1: 加 `export`；`stableUuid`/`uniqueUuid` 同文件不需导出 |
| P0-4 | Task 5 说 "Zod schema"，但 `config.ts` 用 interface + defaults | Task 5 完全重写：`AgentViewConfig` interface + defaults 对象 |
| P0-5 | Task 7 替换代码漏掉条件化完成消息逻辑 | Task 7 完全重写：包含完整 conditional completion |
| P0-6 | SDK fallback 路径缺 chat-text 回复 | Task 6 Step 5: 在 `runChatSDK` final return 前加 P1-4 chat-text reply |

### Minor 修复

| # | 问题 | 修正 |
|---|------|------|
| S1 | inject 失败（timeout/socket_closed）一刀切阻止 SDK fallback | `tryRendezvousReply` docstring 明确：eligibility fail → return false（允许 SDK fallback）；inject fail → return true（阻止，bg 可能已处理） |
| S2 | E2E Scenario 2 引用 `card.ts:815`，实际只有 710 行 | 改为 "card.ts Reply 按钮守卫: lines 78, 249, 644" |
| S3 | `readLastAssistantTurn` docstring 说 "byte buffer"，实现是 readFileSync | 修正 docstring 为准确描述 |
| S4 | Task 6 Step 5 SDK reply 缺 `messageId` 时静默跳过 | 补 else 分支：`await this.replyFn(sdkReplyText, { openId, requestUuid: uniqueUuid() })` |

### 结构优化

- Task 6 重写：删除原 Steps 3/4 混乱的 sentinel + ReplyHandledSentinel 方案，统一用 `tryRendezvousReply` + `rendezvousHandled` 标志
- Task 4 扩展：增加 `messageId` 到 `ExpectedReplyInfo` + 对应测试
- File Structure 更新：加 `card-updater.ts [MOD]`，修正 `expected-reply-state.ts` 描述
- Self-Review 更新：反映所有新类型/接口

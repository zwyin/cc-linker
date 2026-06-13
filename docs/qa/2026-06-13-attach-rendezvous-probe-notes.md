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

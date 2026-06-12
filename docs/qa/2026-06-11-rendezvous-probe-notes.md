# Rendezvous Socket — Empirical Probe Notes (2026-06-11)

## Test environment

- Claude CLI 2.1.163 (Mach-O 64-bit arm64, /usr/local/bin/claude)
- OS: macOS Darwin 24.6.0
- Test session: dcb2ec25 (bash loop script, intent: "请每 5 秒 date 打印当前时间,循环 10 次")

## Probe 1: roster.json structure reveals 2 IPC sockets per bg worker

Roster snapshot at `~/.claude/daemon/roster.json` (excerpt):
```json
"workers": {
  "dcb2ec25": {
    "pid": 5367,
    "rendezvousSock": "/tmp/cc-daemon-503/02d85b02/rv/dcb2ec25.sock",
    "ptySock":        "/tmp/cc-daemon-503/02d85b02/spare/173620cc.pty.sock",
    "cliVersion": "2.1.163",
    "dispatch": { ... }
  }
}
```

Two sockets per bg worker:
- `rendezvousSock` — control + message injection (JSON-RPC NDJSON)
- `ptySock` — terminal emulation (lower-level byte stream)

Plus a supervisor-level `control.sock` in `/tmp/cc-daemon-503/02d85b02/`.

## Probe 2: rendezvous socket accepts reply and emits state patches

```bash
echo '{"type":"reply","text":"hello from probe"}' | nc -U <rendezvousSock>
```

Response (single line, immediately):
```json
{"type":"state","patch":{"tempo":"active","needs":""}}
```

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

```bash
echo "hello" | nc -U <ptySock>
```

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

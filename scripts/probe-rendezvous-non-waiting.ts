/**
 * Probe: 在 bg 非 waiting 状态下注入 rendezvous reply，验证 daemon 是否 respawn。
 *
 * 背景：v2.4 的 Reply 路径只在 bg=waiting 时走 rendezvous（rendezvous-fallback.ts:77-85）。
 * 计划改造 Attach + chat 路径也走 rendezvous，但需要先确认：bg 在 idle/done/stopped
 * 状态下注入 reply，daemon 是 respawn 处理、ack+close、还是忽略？
 *
 * 已有证据：
 *   - Probe 3（docs/qa/2026-06-11-rendezvous-probe-notes.md:45-53）：stopped + reply → respawn
 *   - Probe 5：协议只认 {type:"reply",text}，其他 type 静默丢
 *   - Probe 没测：idle / done
 *
 * 用法：
 *   bun run scripts/probe-rendezvous-non-waiting.ts                       # dry-run, 列出候选 + 测试 socket 通
 *   bun run scripts/probe-rendezvous-non-waiting.ts --inject              # 真注入 + 等 10s 看 respawn
 *   bun run scripts/probe-rendezvous-non-waiting.ts --short abc12345     # 只测特定 short
 *   bun run scripts/probe-rendezvous-non-waiting.ts --states idle,done   # 筛选状态
 *   bun run scripts/probe-rendezvous-non-waiting.ts --wait-ms 30000       # 注入后等 30s
 *
 * 默认 dry-run 是安全的：只 connect + write + 等 200ms 看 ack + close，不读 state.json 后续变化。
 * 加 --inject 才会真等 respawn。每次注入都会带 sentinel 字符串，搜索 JSONL 能立刻识别。
 */

import * as net from 'node:net';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expandPath, CLAUDE_JOBS_DIR } from '../src/utils/paths';
import { readJobState, listJobShorts } from '../src/agent-view/job-state';

// ─── 参数解析 ────────────────────────────────────────────────────────────────

interface ProbeOptions {
  inject: boolean;
  waitMs: number;
  states: Set<string>;
  short: string | null;
  sentinel: string;
}

function parseArgs(argv: string[]): ProbeOptions {
  const opts: ProbeOptions = {
    inject: false,
    waitMs: 10_000,
    states: new Set(['idle', 'done', 'stopped']),
    short: null,
    sentinel: `__PROBE_SENTINEL_${Date.now().toString(36)}__`,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--inject') opts.inject = true;
    else if (a === '--short') opts.short = argv[++i];
    else if (a === '--wait-ms') opts.waitMs = parseInt(argv[++i], 10);
    else if (a === '--states') {
      opts.states = new Set(argv[++i].split(',').map(s => s.trim()));
    } else if (a === '--sentinel') opts.sentinel = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: bun run scripts/probe-rendezvous-non-waiting.ts [options]\n' +
        '  --inject         真注入 + 等 respawn (default: dry-run)\n' +
        '  --short <hash>   只测特定 short\n' +
        '  --states <list>  候选状态筛选 (idle,done,stopped,running,working,blocked)\n' +
        '  --wait-ms <ms>   注入后等待 respawn 的毫秒数 (default: 10000)\n' +
        '  --sentinel <txt> 自定义 sentinel 字符串 (JSONL 中搜得到)',
      );
      process.exit(0);
    }
  }
  return opts;
}

// ─── 数据收集 ────────────────────────────────────────────────────────────────

interface Candidate {
  short: string;
  state: string;
  tempo: string | null;
  detail: string | null;
  needs: string | null;
  rendezvousSock: string | null;
  linkScanPath: string | null;
  cliVersion: string | null;
  source: string | null;
  mtimeMs: number;
}

function readRosterJson(): Record<string, any> {
  const path = join(expandPath('~'), '.claude', 'daemon', 'roster.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

async function collectCandidates(opts: ProbeOptions): Promise<Candidate[]> {
  const roster = readRosterJson();
  const shorts = new Set<string>(listJobShorts());

  // 同时把 roster 里有的也加进来（可能 state.json 已清但 roster 还有痕迹）
  for (const short of Object.keys(roster.workers ?? {})) shorts.add(short);

  const candidates: Candidate[] = [];
  for (const short of shorts) {
    if (opts.short && short !== opts.short) continue;

    const env = await readJobState(short);
    const state = env?.state?.state ?? 'unknown';
    if (!opts.states.has(state)) continue;

    const w = roster.workers?.[short];
    candidates.push({
      short,
      state,
      tempo: env?.state?.tempo ?? null,
      detail: env?.state?.detail ?? null,
      needs: env?.state?.needs ?? null,
      rendezvousSock: w?.rendezvousSock ?? null,
      linkScanPath: env?.state?.linkScanPath ?? null,
      cliVersion: w?.cliVersion ?? null,
      source: w?.dispatch?.source ?? null,
      mtimeMs: env?.mtimeMs ?? 0,
    });
  }
  return candidates;
}

// ─── Socket 注入 ─────────────────────────────────────────────────────────────

interface InjectResult {
  connected: boolean;
  acked: boolean;
  /** daemon close 之前的第一个有效 JSON 行 (通常是 state patch) */
  firstPatch: any | null;
  error: string | null;
  durationMs: number;
}

/**
 * 把 reply 行写进 rendezvous sock。等 200ms 看 ack 后 close。
 * 与 rendezvous-client.ts:submitReplyInternal 行为一致，但额外回采 ack 内容。
 */
function injectReply(sock: string, text: string): Promise<InjectResult> {
  return new Promise(resolve => {
    const start = Date.now();
    const result: InjectResult = {
      connected: false,
      acked: false,
      firstPatch: null,
      error: null,
      durationMs: 0,
    };
    const socket = net.createConnection(sock);
    let resolved = false;
    let buf = '';
    const finish = () => {
      if (resolved) return;
      resolved = true;
      try { socket.destroy(); } catch { /* ignore */ }
      result.durationMs = Date.now() - start;
      resolve(result);
    };
    const timer = setTimeout(finish, 200);

    socket.on('connect', () => {
      result.connected = true;
      socket.write(JSON.stringify({ type: 'reply', text }) + '\n');
    });
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        if (line) {
          try {
            const env = JSON.parse(line);
            if (env.type === 'state' && env.patch) {
              result.acked = true;
              result.firstPatch = env.patch;
            } else if (env.type === 'error') {
              result.error = String(env.message ?? env.error ?? 'unknown');
            }
          } catch {
            // torn JSON, ignore
          }
        }
      }
    });
    socket.on('close', () => {
      clearTimeout(timer);
      finish();
    });
    socket.on('error', err => {
      result.error = err.message;
      clearTimeout(timer);
      finish();
    });
  });
}

// ─── Respawn 判定 ────────────────────────────────────────────────────────────

async function waitForStateChange(short: string, preMtimeMs: number, waitMs: number): Promise<{
  changed: boolean;
  postState: string | null;
  postTempo: string | null;
  postMtimeMs: number;
}> {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    const env = await readJobState(short);
    if (env && env.mtimeMs > preMtimeMs) {
      return {
        changed: true,
        postState: env.state.state,
        postTempo: env.state.tempo ?? null,
        postMtimeMs: env.mtimeMs,
      };
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return {
    changed: false,
    postState: null,
    postTempo: null,
    postMtimeMs: preMtimeMs,
  };
}

/** 抓 JSONL 末次 assistant turn 看 sentinel 是否出现 (respawn 真正处理了的硬证据) */
async function checkJsonlForSentinel(linkScanPath: string | null, sentinel: string): Promise<{
  found: boolean;
  lastTurnSnippet: string | null;
}> {
  if (!linkScanPath || !existsSync(linkScanPath)) {
    return { found: false, lastTurnSnippet: null };
  }
  try {
    const raw = readFileSync(linkScanPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    let lastAssistant: string | null = null;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant') {
          const content = obj.message?.content ?? [];
          const textBlock = Array.isArray(content)
            ? content.find((b: any) => b?.type === 'text')?.text
            : (typeof content === 'string' ? content : null);
          if (textBlock) lastAssistant = textBlock;
        }
      } catch {
        // skip torn lines
      }
    }
    const found = !!lastAssistant && lastAssistant.includes(sentinel);
    return {
      found,
      lastTurnSnippet: lastAssistant ? lastAssistant.slice(0, 200) : null,
    };
  } catch {
    return { found: false, lastTurnSnippet: null };
  }
}

// ─── 输出 ────────────────────────────────────────────────────────────────────

function fmtState(state: string, tempo: string | null): string {
  if (tempo) return `${state}/${tempo}`;
  return state;
}

function printCandidates(candidates: Candidate[]): void {
  console.log(`\n找到 ${candidates.length} 个候选 bg session:\n`);
  if (candidates.length === 0) {
    console.log('  (无)');
    return;
  }
  // 简单表格输出
  const rows: Array<{ label: string; value: string }> = [];
  for (const c of candidates) {
    rows.push({
      label: c.short,
      value:
        `state=${fmtState(c.state, c.tempo)}  ` +
        `sock=${c.rendezvousSock ? '✓' : '✗'}  ` +
        `cli=${c.cliVersion ?? '?'}  ` +
        `source=${c.source ?? '?'}  ` +
        `detail=${c.detail ?? ''}`,
    });
  }
  // 按 short 字母序打印,直接进 argv 选 --short
  for (const r of rows) {
    console.log(`  ${r.label.padEnd(10)} ${r.value}`);
  }
  console.log();
}

interface ProbeRecord {
  short: string;
  preState: string;
  preTempo: string | null;
  sockExists: boolean;
  connected: boolean;
  acked: boolean;
  firstPatch: any | null;
  error: string | null;
  injectDurationMs: number;
  postState: string | null;
  postTempo: string | null;
  respawned: boolean;
  jsonlFoundSentinel: boolean;
  verdict: string;
}

function makeVerdict(r: Omit<ProbeRecord, 'verdict'>): string {
  if (!r.sockExists) return 'SOCKET_MISSING';
  if (!r.connected) return 'CONNECT_FAIL: ' + r.error;
  if (r.injectDurationMs >= 200 && !r.acked) return 'INJECT_TIMEOUT (daemon 无应答)';
  if (!r.acked) return 'DAEMON_IGNORED (写成功但无 state patch)';
  if (r.error) return 'DAEMON_ERROR: ' + r.error;
  // 真注入才看 respawn
  if (r.respawned && r.jsonlFoundSentinel) return '✅ RESPAWN + PROCESSED';
  if (r.respawned) return '⚠️ RESPAWN 但 JSONL 找不到 sentinel';
  // 未等够 (dry-run 也算): 已知 daemon 是 fire-and-forget, state.json 可能在 close 后才更新。
  // 返回"待二次确认"而不是直接 NO_RESPAWN。
  return opts.inject
    ? `❌ NO RESPAWN (等满 ${r.injectDurationMs}ms 后 state.json 没动)`
    : 'ACKED (dry-run 未等 respawn —— 加 --inject 才能验证)';
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║ Probe: 在 bg 非 waiting 状态下注入 rendezvous reply             ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`模式:        ${opts.inject ? '⚠️  INJECT (真注入 + 等 respawn)' : '✓ DRY-RUN (只 connect + 看 ack)'}`);
  console.log(`等待时间:    ${opts.waitMs} ms (仅 --inject 模式生效)`);
  console.log(`候选状态:    ${[...opts.states].join(', ')}`);
  console.log(`短 hash 筛选: ${opts.short ?? '(无)'}`);
  console.log(`Sentinel:    ${opts.sentinel}`);

  const candidates = await collectCandidates(opts);
  printCandidates(candidates);

  if (candidates.length === 0) {
    console.log('❌ 没有候选 bg session。可选项：');
    console.log('   1) 跑 --states 后加 running/working/blocked 看其他状态');
    console.log('   2) 启动一个 bg 进程后重跑 (e.g. claude --bg -p "请打印日期并退出")');
    return;
  }

  if (!opts.inject) {
    console.log('当前是 dry-run 模式。Socket 通就只会 connect + write + 等 200ms ack + close，不会真注入。');
    console.log('要真注入 + 等 respawn，加 --inject 旗标。\n');
  } else {
    console.log('⚠️  --inject 模式：每次注入后 bg 可能被 daemon respawn 并消耗 token。');
    console.log('   已嵌入 sentinel 文本：' + opts.sentinel);
    console.log('   按 Ctrl+C 可中止本次运行。3 秒后开始...\n');
    await new Promise(r => setTimeout(r, 3000));
  }

  const records: ProbeRecord[] = [];
  for (const c of candidates) {
    console.log(`─── ${c.short} (${c.state}/${c.tempo ?? '-'}) ───`);

    if (!c.rendezvousSock) {
      console.log(`  跳过: roster 中无 rendezvousSock (旧 CLI 或已退出 daemon)`);
      continue;
    }
    if (!existsSync(c.rendezvousSock)) {
      console.log(`  跳过: socket 文件不存在 (${c.rendezvousSock})`);
      continue;
    }
    try {
      if (!statSync(c.rendezvousSock).isSocket()) {
        console.log(`  跳过: 不是 socket 文件`);
        continue;
      }
    } catch {
      console.log(`  跳过: stat 失败`);
      continue;
    }

    const preMtimeMs = c.mtimeMs;
    const injectResult = await injectReply(c.rendezvousSock, opts.sentinel);
    console.log(
      `  inject  : connected=${injectResult.connected} ` +
      `acked=${injectResult.acked} ` +
      `patch=${JSON.stringify(injectResult.firstPatch)} ` +
      `dur=${injectResult.durationMs}ms ` +
      (injectResult.error ? `err=${injectResult.error}` : ''),
    );

    let respawned = false;
    let postState: string | null = null;
    let postTempo: string | null = null;
    let jsonlFoundSentinel = false;

    if (opts.inject && injectResult.acked) {
      console.log(`  waiting : 观察 state.json 变化 (最多 ${opts.waitMs} ms)...`);
      const change = await waitForStateChange(c.short, preMtimeMs, opts.waitMs);
      respawned = change.changed;
      postState = change.postState;
      postTempo = change.postTempo;
      console.log(
        `  post    : state=${postState ?? '(没变)'} tempo=${postTempo ?? '-'} ` +
        `changed=${change.changed}`,
      );

      if (respawned) {
        // 重新读 linkScanPath（respawn 后可能更新）
        const env = await readJobState(c.short);
        const newLink = env?.state?.linkScanPath ?? null;
        console.log(`  jsonl   : linkScanPath=${newLink ?? '(空)'}`);
        const jsonlResult = await checkJsonlForSentinel(newLink, opts.sentinel);
        jsonlFoundSentinel = jsonlResult.found;
        console.log(`  sentinel: found=${jsonlResult.found}`);
        if (jsonlResult.lastTurnSnippet) {
          console.log(`  snippet : ${jsonlResult.lastTurnSnippet.slice(0, 120).replace(/\n/g, ' ')}...`);
        }
      }
    }

    const partial: Omit<ProbeRecord, 'verdict'> = {
      short: c.short,
      preState: c.state,
      preTempo: c.tempo,
      sockExists: true,
      connected: injectResult.connected,
      acked: injectResult.acked,
      firstPatch: injectResult.firstPatch,
      error: injectResult.error,
      injectDurationMs: injectResult.durationMs,
      postState,
      postTempo,
      respawned,
      jsonlFoundSentinel,
    };
    const verdict = makeVerdict(partial);
    console.log(`  VERDICT : ${verdict}\n`);

    records.push({ ...partial, verdict });
  }

  // 汇总
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('汇总:');
  console.log('═══════════════════════════════════════════════════════════════════');
  for (const r of records) {
    console.log(`  ${r.short.padEnd(10)} ${r.preState.padEnd(10)} → ${r.verdict}`);
  }
  console.log();
  console.log('结论速读:');
  const connOk = records.filter(r => r.connected).length;
  const ackOk = records.filter(r => r.acked).length;
  const respawn = records.filter(r => r.respawned).length;
  const processed = records.filter(r => r.jsonlFoundSentinel).length;
  console.log(`  - socket 可连: ${connOk}/${records.length}`);
  if (opts.inject) {
    console.log(`  - daemon 返回 ack: ${ackOk}/${records.length}`);
    console.log(`  - state.json 变化 (respawn 信号): ${respawn}/${records.length}`);
    console.log(`  - JSONL 出现 sentinel (真处理了): ${processed}/${records.length}`);
  } else {
    console.log(`  - 协议层 ack: ${ackOk}/${records.length}`);
    console.log(`  (加 --inject 才能看 respawn 和 JSONL)`);
  }
  console.log();
  console.log('下一步建议:');
  if (!opts.inject) {
    console.log('  1) 如果上面 acked 数 ≥ 1，daemon 协议层在非 waiting 也接 reply');
    console.log('  2) 加 --inject 重跑看 respawn + JSONL 才是硬证据');
  } else {
    const anyRespawn = records.some(r => r.respawned);
    const anyProcessed = records.some(r => r.jsonlFoundSentinel);
    if (anyProcessed) {
      console.log('  ✅ 结论：rendezvous 注入在非 waiting bg 上能 respawn + 真处理。');
      console.log('     可以进入方案 β Step 2：扩展 eligibility + 改造 Attach 路径。');
    } else if (anyRespawn) {
      console.log('  ⚠️ 结论：能 respawn 但 JSONL 没看到 sentinel。可能:');
      console.log('     - bg respawn 后第一件事不是 echo 输入(在干活)');
      console.log('     - sentinel 文本太短被忽略');
      console.log('     建议：等更久 + 重新跑一次确认。');
    } else {
      console.log('  ❌ 结论：daemon 接 ack 但不 respawn。Probe 3 stopped 的成功没复现。');
      console.log('     rendezvous 协议无法用于非 waiting bg，方案 β 不可行；');
      console.log('     退化到方案 α（仅 waiting 用 rendezvous）或方案 γ（UX 改造）。');
    }
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

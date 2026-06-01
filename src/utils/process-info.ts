import { readFileSync, readdirSync, statSync, readlinkSync } from 'fs';

export interface ProcessInfo {
  pid: number;
  cwd: string;
  command: string;
}

/**
 * 读取自己进程的 cwd（用于探测 macOS 权限）
 */
export function getOwnCwd(): string {
  if (process.platform === 'linux') {
    try {
      return readlinkSync('/proc/self/cwd');
    } catch {
      return process.cwd();
    }
  }
  return process.cwd();
}

export function getLinuxClaudeProcesses(uid: number): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  let procDirs: string[];
  try {
    procDirs = readdirSync('/proc').filter(d => /^\d+$/.test(d));
  } catch {
    return [];
  }
  for (const pidStr of procDirs) {
    const pid = parseInt(pidStr, 10);
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      if (comm !== 'claude') continue;

      const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .replace(/\0/g, ' ').trim();
      const cwd = readlinkSync(`/proc/${pid}/cwd`);

      // 过滤
      if (command.includes(' -p ') || command.includes('--output-format')) continue;
      if (command.includes('/sdk/') || command.includes('claude-agent-sdk')) continue;

      const stat = statSync(`/proc/${pid}`);
      if (stat.uid !== uid) continue;

      result.push({ pid, cwd, command });
    } catch {
      // 进程在我们读取时退出，跳过
    }
  }
  return result;
}

export function getDarwinClaudeProcesses(uid: number): ProcessInfo[] {
  try {
    // 1. 单次 lsof 拿所有 claude 进程的 cwd
    const lsofResult = Bun.spawnSync([
      'lsof', '-u', String(uid), '-c', 'claude', '-a', '-d', 'cwd', '-Fn'
    ]);
    if (lsofResult.exitCode !== 0) return [];

    const lines = new TextDecoder().decode(lsofResult.stdout).split('\n');
    const pidToCwd = new Map<number, string>();
    let currentPid: number | null = null;
    for (const line of lines) {
      if (line.startsWith('p')) {
        currentPid = parseInt(line.slice(1), 10);
      } else if (line.startsWith('n') && currentPid !== null) {
        pidToCwd.set(currentPid, line.slice(1));
        currentPid = null;
      }
    }

    // 2. 单独取 command（再开一个 ps 调用）
    const psResult = Bun.spawnSync(['ps', '-u', String(uid), '-o', 'pid=,command=']);
    const pidToCommand = new Map<number, string>();
    if (psResult.exitCode === 0) {
      for (const line of new TextDecoder().decode(psResult.stdout).split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (m) pidToCommand.set(parseInt(m[1], 10), m[2].trim());
      }
    }

    // 3. 合并 + 过滤
    const out: ProcessInfo[] = [];
    for (const [pid, cwd] of pidToCwd) {
      const command = pidToCommand.get(pid) ?? '';
      if (command.includes(' -p ') || command.includes('--output-format')) continue;
      if (command.includes('/sdk/') || command.includes('claude-agent-sdk')) continue;
      out.push({ pid, cwd, command });
    }
    return out;
  } catch {
    // 权限不足（macOS 上 lsof 看其他用户需要 root）
    return [];
  }
}

export function getClaudeProcessesByCwd(targetCwd: string): ProcessInfo[] {
  const uid = process.getuid?.() ?? 0;
  const procs = process.platform === 'linux'
    ? getLinuxClaudeProcesses(uid)
    : process.platform === 'darwin'
      ? getDarwinClaudeProcesses(uid)
      : [];
  return procs.filter(p => p.cwd === targetCwd);
}

export function getProcessCPUTimeSeconds(pid: number): Promise<number> {
  if (process.platform === 'linux') {
    return Promise.resolve(getLinuxCPUTime(pid));
  }
  if (process.platform === 'darwin') {
    return Promise.resolve(getDarwinCPUTime(pid));
  }
  return Promise.reject(new Error(`Unsupported platform: ${process.platform}`));
}

function getLinuxCPUTime(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const lastParen = stat.lastIndexOf(')');
    const after = stat.slice(lastParen + 2);
    const parts = after.split(' ');
    const utime = parseInt(parts[11], 10);
    const stime = parseInt(parts[12], 10);
    let clkTck = 100;
    try {
      const t = readFileSync('/proc/sys/kernel/clk_tck', 'utf8').trim();
      clkTck = parseInt(t, 10) || 100;
    } catch {}
    return (utime + stime) / clkTck;
  } catch {
    return 0;
  }
}

function getDarwinCPUTime(pid: number): number {
  try {
    const result = Bun.spawnSync(['ps', '-o', 'time=', '-p', String(pid)]);
    if (result.exitCode !== 0) return 0;
    const timeStr = new TextDecoder().decode(result.stdout).trim();
    return parsePsTimeToSeconds(timeStr);
  } catch {
    return 0;
  }
}

export function parsePsTimeToSeconds(timeStr: string): number {
  if (!timeStr) return 0;
  let days = 0;
  let rest = timeStr;
  if (rest.includes('-')) {
    const dashIdx = rest.indexOf('-');
    days = parseInt(rest.slice(0, dashIdx), 10) || 0;
    rest = rest.slice(dashIdx + 1);
  }
  const parts = rest.split(':');
  if (parts.length === 3) {
    return days * 86400
      + parseInt(parts[0], 10) * 3600
      + parseInt(parts[1], 10) * 60
      + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return days * 86400 + parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(rest);
}

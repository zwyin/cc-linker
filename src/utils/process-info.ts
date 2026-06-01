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

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

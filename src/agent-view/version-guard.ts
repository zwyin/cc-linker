import { execFileSync } from 'node:child_process';

const MIN_VERSION = '2.1.139';

export interface VersionCheckResult {
  ok: boolean;
  version?: string;
  reason?: string;
}

export const VersionGuard = {
  async check(): Promise<VersionCheckResult> {
    let raw: string;
    try {
      raw = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { ok: false, reason: 'Claude CLI not installed' };
      }
      return { ok: false, reason: `Failed to get version: ${err.message}` };
    }
    const m = raw.match(/(\d+\.\d+\.\d+)/);
    if (!m) {
      return { ok: false, reason: `Cannot parse version: ${raw.slice(0, 100)}` };
    }
    const version = m[1];
    if (compareVersions(version, MIN_VERSION) < 0) {
      return { ok: false, version, reason: `Requires ${MIN_VERSION}+, got ${version}` };
    }
    return { ok: true, version };
  },
};

function compareVersions(a: string, b: string): number {
  const [a1, a2, a3] = a.split('.').map(Number);
  const [b1, b2, b3] = b.split('.').map(Number);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

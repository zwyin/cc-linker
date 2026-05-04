import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { execFileSync } from 'child_process';
import { HOOK_LOG_PATH } from '../utils/paths';

export function hookSessionStart(): void {
  try {
    const sessionId = detectSessionId();
    if (!sessionId) {
      logHook('WARN', '无法获取 session ID，跳过注册');
      return;
    }

    const cwd = process.env.PWD || process.cwd();

    execFileSync('cc-bridge', ['register', sessionId, '--origin', 'cli', '--cwd', cwd, '--source', 'terminal'], {
      stdio: 'pipe',
      timeout: 5000,
    });

    logHook('INFO', `已注册会话 ${sessionId} (cwd: ${cwd})`);
  } catch (err: any) {
    logHook('ERROR', `Hook 执行失败: ${err.message}`);
  }
}

function detectSessionId(): string | null {
  const candidates = [
    'CLAUDE_CODE_SESSION_ID',
    'SESSION_ID',
    'CLAUDE_SESSION_ID',
  ];

  for (const name of candidates) {
    const value = process.env[name];
    if (value && isValidUUID(value)) {
      return value;
    }
  }

  return null;
}

function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function logHook(level: string, message: string): void {
  try {
    mkdirSync(dirname(HOOK_LOG_PATH), { recursive: true });
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    appendFileSync(HOOK_LOG_PATH, line);
  } catch {
    // Silently fail
  }
}

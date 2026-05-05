import { execFileSync } from 'child_process';
import { logger } from '../utils/logger';
import { isValidUUID } from '../utils/validation';

export function hookSessionStart(): void {
  try {
    const sessionId = detectSessionId();
    if (!sessionId) {
      logger.hook('warn', '无法获取 session ID，跳过注册');
      return;
    }

    const cwd = process.env.PWD || process.cwd();
    const origin = detectOrigin();

    execFileSync('cc-bridge', ['register', sessionId, '--origin', origin, '--cwd', cwd, '--source', origin === 'cc-connect' ? 'cc-connect' : 'terminal'], {
      stdio: 'pipe',
      timeout: 5000,
    });

    logger.hook('info', `已注册会话 ${sessionId} (origin: ${origin}, cwd: ${cwd})`);
  } catch (err: any) {
    logger.hook('error', `Hook 执行失败: ${err.message}`);
  }
}

export function detectSessionId(): string | null {
  // 仅接受带明确 Claude 前缀的环境变量名，避免与 tmux/screen/iTerm 等工具的 SESSION_ID 冲突
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

/** 通过环境变量判别来源，优先于 Scanner 的主判别（cc-connect 权威集） */
export function detectOrigin(): string {
  // 主判别：entrypoint 环境变量
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    ?? process.env.ENTRYPOINT
    ?? process.env.CLAUDE_ENTRYPOINT;
  if (entrypoint === 'sdk-cli') return 'cc-connect';

  // 辅助判别：cc-connect 特有环境变量
  if (process.env.CC_CONNECT_SESSION_ID) return 'cc-connect';

  // 兜底：cli
  return 'cli';
}

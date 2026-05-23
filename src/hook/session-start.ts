import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { RUNTIME_SESSION_EVENTS_DIR } from '../utils/paths';
import { logger } from '../utils/logger';
import { isValidUUID } from '../utils/validation';

/**
 * 会话启动 Hook：将 session 发现事件写入 runtime/session-events/ 目录，
 * 供 Round 5 Reconciler 在启动时归并。不再调用 `cc-linker register`。
 */
export function hookSessionStart(): void {
  try {
    const sessionId = detectSessionId();
    if (!sessionId) {
      logger.hook('warn', '无法获取 session ID，跳过事件写入');
      return;
    }

    const cwd = process.env.PWD || process.cwd();

    // 写入事件文件
    const eventFile = `${sessionId}.json`;
    const eventPath = join(RUNTIME_SESSION_EVENTS_DIR, eventFile);

    mkdirSync(RUNTIME_SESSION_EVENTS_DIR, { recursive: true, mode: 0o700 });

    const event = {
      sessionId,
      cwd,
      discoveredAt: new Date().toISOString(),
    };

    writeFileSync(eventPath, JSON.stringify(event, null, 2), { mode: 0o600 });

    logger.hook('info', `已写入 session 事件: ${eventPath}`);
  } catch (err: any) {
    logger.hook('error', `Hook 执行失败: ${err.message}`);
  }
}

export function detectSessionId(): string | null {
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

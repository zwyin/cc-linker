import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { CCConnectSessionSchema, type CCConnectSession } from '../registry/types';
import type { RegistryManager } from '../registry/registry';
import { logger } from '../utils/logger';
import { normalizeOwner } from '../utils/owner';

export class CCConnectScanner {
  private registry: RegistryManager;
  private sessionsDir: string;

  constructor(registry: RegistryManager, homeDir?: string) {
    this.registry = registry;
    // 使用 process.env.HOME 而非 homedir()，以支持测试中的 HOME 环境变量覆盖
    // 注意：homeDir 参数是用户主目录路径（含 .cc-connect 子目录），不是 sessions 目录
    const actualHomeDir = homeDir ?? (process.env.HOME ?? homedir());
    this.sessionsDir = join(actualHomeDir, '.cc-connect', 'sessions');
  }

  scan(): { uuids: Set<string>; sids: Set<string> } {
    if (!existsSync(this.sessionsDir)) {
      return { uuids: new Set(), sids: new Set() };
    }

    const uuids = new Set<string>();
    const sids = new Set<string>();

    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = join(this.sessionsDir, file);
        const raw = readFileSync(filePath, 'utf8');
        const data = CCConnectSessionSchema.parse(JSON.parse(raw));
        const platform = this.detectPlatform(file);

        const sidToUser = new Map<string, string>();
        for (const [userKey, userSids] of Object.entries(data.user_sessions ?? {})) {
          for (const sid of userSids) {
            sidToUser.set(sid, userKey);
          }
        }
        for (const [userKey, sid] of Object.entries(data.active_session ?? {})) {
          if (!sidToUser.has(sid)) sidToUser.set(sid, userKey);
        }

        for (const [sid, session] of Object.entries(data.sessions ?? {})) {
          const agentId = session.agent_session_id;
          if (!agentId) continue;

          uuids.add(agentId);
          sids.add(sid);

          const userKey = sidToUser.get(sid) ?? null;

          this.registry.upsert(agentId, {
            origin: 'cc-connect',
            source: userKey ?? sid,
            platform,
            owner: userKey ? normalizeOwner(userKey) : null,
            owner_user_key: userKey,
            cc_connect_session_id: sid,
            cc_connect_session_file: filePath,
          });
        }
      } catch (err) {
        logger.warn(`解析 cc-connect session 文件失败: ${file}: ${err}`);
      }
    }

    this.cleanStaleMappings(sids);

    return { uuids, sids };
  }

  private cleanStaleMappings(activeSids: Set<string>): void {
    for (const [uuid, entry] of Object.entries(this.registry.sessions)) {
      if (entry.cc_connect_session_id && !activeSids.has(entry.cc_connect_session_id)) {
        // 映射已失效，清除 cc-connect 相关字段
        this.registry.upsert(uuid, {
          cc_connect_session_id: null,
          cc_connect_session_file: null,
        });
      }
    }
  }

  private detectPlatform(filename: string): string | null {
    for (const p of ['feishu', 'weixin', 'dingtalk', 'slack']) {
      if (filename.toLowerCase().includes(p)) return p;
    }
    return null;
  }
}

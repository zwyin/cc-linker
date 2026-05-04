import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { CCConnectSessionSchema, type CCConnectSession } from '../registry/types';
import type { RegistryManager } from '../registry/registry';
import { logger } from '../utils/logger';

export class CCConnectScanner {
  private registry: RegistryManager;
  private sessionsDir: string;

  constructor(registry: RegistryManager, ccConnectDir?: string) {
    this.registry = registry;
    // ccConnectDir is the base directory containing .cc-connect/ (e.g. /home/user or /tmp/test)
    // When not provided, defaults to homedir()
    this.sessionsDir = join(ccConnectDir ?? homedir(), '.cc-connect', 'sessions');
  }

  async scan(): Promise<{ uuids: Set<string>; sids: Set<string> }> {
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

          await this.registry.upsert(agentId, {
            origin: 'cc-connect',
            source: userKey ?? sid,
            platform,
            owner: this.publicOwner(userKey),
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
    for (const entry of Object.values(this.registry.sessions)) {
      if (entry.cc_connect_session_id && !activeSids.has(entry.cc_connect_session_id)) {
        entry.cc_connect_session_id = null;
        entry.cc_connect_session_file = null;
      }
    }
    // Note: no explicit save needed here — the caller (syncBeforeCommand) will
    // save the registry after all scanners complete
  }

  private detectPlatform(filename: string): string | null {
    for (const p of ['feishu', 'weixin', 'dingtalk', 'slack']) {
      if (filename.toLowerCase().includes(p)) return p;
    }
    return null;
  }

  private publicOwner(userKey: string | null): string | null {
    if (!userKey) return null;
    const parts = userKey.split(':');
    return parts.length >= 3 ? `${parts[0]}:${parts[parts.length - 1]}` : userKey;
  }
}

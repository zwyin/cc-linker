import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, unlinkSync, symlinkSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { RegistrySchema, type Registry, type SessionEntry } from './types';
import { withLock, withReadLock } from '../utils/lock';
import { logger } from '../utils/logger';
import { CCBridgeError } from '../utils/errors';
import { CC_BRIDGE_DIR } from '../utils/paths';
import { config } from '../utils/config';

const MAX_BACKUPS = 3;

/** Migrate v1 registry to v2 schema */
function migrateV1toV2(parsed: any): void {
  if (parsed.version !== 1) return;
  const now = new Date().toISOString();
  for (const entry of Object.values(parsed.sessions ?? {})) {
    const e = entry as Record<string, unknown>;
    delete e.source;
    delete e.platform;
    delete e.owner;
    delete e.owner_user_key;
    delete e.cc_connect_session_id;
    delete e.cc_connect_session_file;
    delete e.visibility;
    delete e.shared_with;
    e.jsonl_path = e.jsonl_path ?? null;
    e.project_dir = e.project_dir ?? null;
    e.pending_jsonl_resolve = undefined;
    e.last_error = e.last_error ?? null;
    e.feishu_session_id = e.feishu_session_id ?? null;
    e.feishu_user_id = e.feishu_user_id ?? null;
    e.origin = e.origin ?? 'cli';
    e.cwd = e.cwd ?? '';
    e.project_name = e.project_name ?? null;
    e.created_at = e.created_at ?? now;
    e.last_active = e.last_active ?? now;
    e.title = e.title ?? null;
    e.message_count = e.message_count ?? 0;
    e.last_message_preview = e.last_message_preview ?? '';
    e.status = e.status ?? 'active';
  }
  parsed.version = 2;
}

export class RegistryManager {
  private data: Registry;
  private basePath: string;
  private registryPath: string;
  private backupDir: string;
  private dirtySessions = new Map<string, Partial<SessionEntry>>();
  private removedSessions = new Set<string>();

  constructor(basePath?: string) {
    if (basePath) {
      this.basePath = basePath;
      this.registryPath = join(this.basePath, 'registry.json');
    } else {
      const configuredPath = this.expandPath(
        config.get<string>('general.registry_path', join(CC_BRIDGE_DIR, 'registry.json'))
      );
      this.registryPath = configuredPath;
      this.basePath = dirname(configuredPath);
    }
    this.backupDir = join(this.basePath, 'backups');

    this.ensureDir();
    this.data = this.load();
    this.clearDirtyState();
  }

  private ensureDir(): void {
    mkdirSync(this.basePath, { recursive: true, mode: 0o700 });
    mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
  }

  private load(): Registry {
    if (!existsSync(this.registryPath)) {
      return this.createEmpty();
    }

    try {
      const raw = readFileSync(this.registryPath, 'utf8');
      let parsed = JSON.parse(raw);

      migrateV1toV2(parsed);
      return RegistrySchema.parse(parsed);
    } catch (err) {
      logger.warn('Registry 损坏，尝试从备份恢复...');
      return this.restoreFromBackup() ?? this.createEmpty();
    }
  }

  private expandPath(path: string): string {
    if (path === '~') return process.env.HOME ?? homedir();
    if (path.startsWith('~/')) {
      return join(process.env.HOME ?? homedir(), path.slice(2));
    }
    return path;
  }

  /** 运行时重新加载 registry（带读锁），用于需要确保读取一致性的场景 */
  async reload(): Promise<void> {
    await withReadLock(async () => {
      if (!existsSync(this.registryPath)) {
        this.data = this.createEmpty();
        return;
      }
      const raw = readFileSync(this.registryPath, 'utf8');
      let parsed = JSON.parse(raw);
      migrateV1toV2(parsed);
      this.data = RegistrySchema.parse(parsed);
    });
  }

  private createEmpty(): Registry {
    const empty = this.emptyRegistry();
    this.saveSync(empty);
    this.clearDirtyState();
    return empty;
  }

  private emptyRegistry(): Registry {
    return {
      version: 2,
      updated_at: new Date().toISOString(),
      sessions: {},
    };
  }

  private saveSync(data: Registry): void {
    data.updated_at = new Date().toISOString();
    const tmp = this.registryPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.registryPath);
    this.data = data;
  }

  async save(data?: Registry): Promise<void> {
    if (data) {
      this.data = data;
      this.dirtySessions = new Map(
        Object.entries(data.sessions).map(([uuid, entry]) => [uuid, { ...entry }])
      );
      this.removedSessions.clear();
    }

    if (this.dirtySessions.size === 0 && this.removedSessions.size === 0) {
      return;
    }

    await withLock(this.registryPath, async () => {
      const merged = this.readLatestState();

      for (const uuid of this.removedSessions) {
        delete merged.sessions[uuid];
      }

      for (const [uuid, patch] of this.dirtySessions) {
        const existing = merged.sessions[uuid];
        if (existing) {
          Object.assign(existing, patch);
        } else {
          merged.sessions[uuid] = this.buildSessionEntry(patch);
        }
      }

      this.rotateBackup();
      this.saveSync(merged);
      this.clearDirtyState();
    });
  }

  /** 显式保存当前内存状态到磁盘（带锁 + 备份）。Scanner 批量操作后调用。 */
  async flush(): Promise<void> {
    await this.save();
  }

  get sessions(): Record<string, SessionEntry> {
    return this.data.sessions;
  }

  get path(): string {
    return this.registryPath;
  }

  has(uuid: string): boolean {
    return uuid in this.data.sessions;
  }

  get(uuid: string): SessionEntry | undefined {
    return this.data.sessions[uuid];
  }

  findByPrefix(prefix: string): [string, SessionEntry] | null {
    const matches = Object.entries(this.data.sessions)
      .filter(([uuid]) => uuid.startsWith(prefix));

    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];

    throw new CCBridgeError('E006', `前缀 "${prefix}" 匹配到 ${matches.length} 个会话，请输入更长的前缀`);
  }

  /** 内存中 upsert，不写磁盘。Scanner 批量操作用，完成后调用 flush()。
   *  对于已有条目，只覆盖非 null/undefined 的字段，避免 Scanner 之间的数据互相覆盖。
   */
  upsert(uuid: string, entry: Partial<SessionEntry>): void {
    const existing = this.data.sessions[uuid];

    if (existing) {
      // 过滤掉 undefined 值，避免覆盖已有字段
      // null 值是有意的（如 jsonl_path: null 表示清除路径），保留
      const filtered: Record<string, any> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (value !== undefined) {
          filtered[key] = value;
        }
      }
      Object.assign(existing, filtered);
      // 仅在调用方未提供 last_active 时才用当前时间兜底
      // 例如 register 命令只传 uuid 和 origin，需要自动设置 last_active
      if (existing.last_active === undefined || existing.last_active === null) {
        existing.last_active = new Date().toISOString();
        filtered.last_active = existing.last_active;
      }
      this.markDirty(uuid, filtered);
    } else {
      // 新建条目：同样过滤 undefined，避免覆盖 defaults
      const filtered: Record<string, any> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (value !== undefined) {
          filtered[key] = value;
        }
      }
      const created = this.buildSessionEntry(filtered);
      this.data.sessions[uuid] = created;
      this.markDirty(uuid, created);
    }
  }

  /** 从 registry 中移除指定会话并保存。 */
  async remove(uuid: string): Promise<void> {
    delete this.data.sessions[uuid];
    this.dirtySessions.delete(uuid);
    this.removedSessions.add(uuid);
    await this.save();
  }

  /** 批量移除多个会话并保存（只获取一次锁）。 */
  async removeBatch(uuids: string[]): Promise<void> {
    for (const uuid of uuids) {
      delete this.data.sessions[uuid];
      this.dirtySessions.delete(uuid);
      this.removedSessions.add(uuid);
    }
    await this.save();
  }

  private rotateBackup(): void {
    const backups = readdirSync(this.backupDir)
      .filter(f => f.startsWith('registry.') && f.endsWith('.json'))
      .sort();

    while (backups.length >= MAX_BACKUPS) {
      const oldest = backups.shift()!;
      unlinkSync(join(this.backupDir, oldest));
    }

    // 生成 YYYYMMDD_HHMMSS 格式时间戳
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    // 同秒冲突时追加序号
    let backupPath = join(this.backupDir, `registry.${timestamp}.json`);
    let counter = 0;
    while (existsSync(backupPath)) {
      counter++;
      backupPath = join(this.backupDir, `registry.${timestamp}_${counter}.json`);
    }

    // 从磁盘复制当前 registry 文件（而非内存状态），确保备份反映真实磁盘内容
    if (existsSync(this.registryPath)) {
      copyFileSync(this.registryPath, backupPath);
    }

    const bakPath = this.registryPath + '.bak';
    try {
      unlinkSync(bakPath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
    symlinkSync(backupPath, bakPath);
  }

  private readLatestState(): Registry {
    if (!existsSync(this.registryPath)) {
      return this.emptyRegistry();
    }

    try {
      let parsed = JSON.parse(readFileSync(this.registryPath, 'utf8'));
      migrateV1toV2(parsed);
      return RegistrySchema.parse(parsed);
    } catch {
      return this.restoreFromBackup() ?? this.emptyRegistry();
    }
  }

  private buildSessionEntry(entry: Partial<SessionEntry>): SessionEntry {
    return {
      origin: 'cli',
      cwd: '',
      project_name: null,
      jsonl_path: null,
      project_dir: null,
      created_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
      title: null,
      message_count: 0,
      last_message_preview: '',
      status: 'active',
      ...entry,
    };
  }

  private markDirty(uuid: string, patch: Partial<SessionEntry>): void {
    const existing = this.dirtySessions.get(uuid) ?? {};
    this.dirtySessions.set(uuid, { ...existing, ...patch });
    this.removedSessions.delete(uuid);
  }

  private clearDirtyState(): void {
    this.dirtySessions.clear();
    this.removedSessions.clear();
  }

  private restoreFromBackup(): Registry | null {
    const bakPath = this.registryPath + '.bak';
    if (!existsSync(bakPath)) return null;

    try {
      const raw = readFileSync(bakPath, 'utf8');
      return RegistrySchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }
}

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, unlinkSync, symlinkSync } from 'fs';
import { join } from 'path';
import { RegistrySchema, type Registry, type SessionEntry } from './types';
import { withLock } from '../utils/lock';
import { logger } from '../utils/logger';
import { CCBridgeError } from '../utils/errors';

const MAX_BACKUPS = 3;

export class RegistryManager {
  private data: Registry;
  private basePath: string;
  private registryPath: string;
  private backupDir: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? join(process.env.HOME ?? '~', '.cc-bridge');
    this.registryPath = join(this.basePath, 'registry.json');
    this.backupDir = join(this.basePath, 'backups');

    this.ensureDir();
    this.data = this.load();
  }

  private ensureDir(): void {
    mkdirSync(this.basePath, { recursive: true, mode: 0o700 });
    mkdirSync(this.backupDir, { recursive: true });
  }

  private load(): Registry {
    if (!existsSync(this.registryPath)) {
      return this.createEmpty();
    }

    try {
      const raw = readFileSync(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      return RegistrySchema.parse(parsed);
    } catch (err) {
      logger.warn('Registry 损坏，尝试从备份恢复...');
      return this.restoreFromBackup() ?? this.createEmpty();
    }
  }

  private createEmpty(): Registry {
    const empty: Registry = {
      version: 1,
      updated_at: new Date().toISOString(),
      sessions: {},
    };
    this.saveSync(empty);
    return empty;
  }

  private saveSync(data: Registry): void {
    data.updated_at = new Date().toISOString();
    const tmp = this.registryPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.registryPath);
    this.data = data;
  }

  async save(data?: Registry): Promise<void> {
    const toSave = data ?? this.data;
    await withLock(this.registryPath, async () => {
      this.rotateBackup();
      this.saveSync(toSave);
    });
  }

  get sessions(): Record<string, SessionEntry> {
    return this.data.sessions;
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

  async upsert(uuid: string, entry: Partial<SessionEntry>): Promise<void> {
    const existing = this.data.sessions[uuid];

    if (existing) {
      Object.assign(existing, {
        ...entry,
        last_active: entry.last_active ?? new Date().toISOString(),
      });
    } else {
      this.data.sessions[uuid] = {
        origin: 'cli',
        source: 'terminal',
        platform: null,
        owner: null,
        owner_user_key: null,
        cwd: '',
        project_name: null,
        jsonl_path: '',
        project_dir: null,
        cc_connect_session_id: null,
        cc_connect_session_file: null,
        created_at: new Date().toISOString(),
        last_active: new Date().toISOString(),
        title: null,
        message_count: 0,
        last_message_preview: '',
        status: 'active',
        ...entry,
      };
    }

    await this.save();
  }

  async remove(uuid: string): Promise<void> {
    delete this.data.sessions[uuid];
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

    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const backupPath = join(this.backupDir, `registry.${timestamp}.json`);
    writeFileSync(backupPath, JSON.stringify(this.data, null, 2));

    const bakPath = this.registryPath + '.bak';
    if (existsSync(bakPath)) unlinkSync(bakPath);
    symlinkSync(backupPath, bakPath);
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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { CC_BRIDGE_DIR } from './paths';
import { logger } from './logger';
import { Database } from 'bun:sqlite';

export type ProviderSource = 'manual' | 'cc-switch' | 'none';

export interface ProviderConfig {
  alias: string;
  name: string;
  path: string;
  isTemp: boolean;
}

function expandPath(p: string): string {
  if (p === '~') return process.env.HOME ?? '';
  if (p.startsWith('~/')) return join(process.env.HOME ?? '', p.slice(2));
  return p;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await Bun.file(path).stat();
    return stat.isDirectory();
  } catch { return false; }
}

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

export class ProviderManager {
  private providers = new Map<string, ProviderConfig>();
  private source: ProviderSource = 'none';
  private readonly autoProviderDir = join(CC_BRIDGE_DIR, 'auto-providers');

  getSource(): ProviderSource { return this.source; }

  list(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  resolve(aliasOrIndex: string): ProviderConfig | null {
    const direct = this.providers.get(aliasOrIndex);
    if (direct) return direct;

    const idx = parseInt(aliasOrIndex, 10);
    if (!Number.isNaN(idx) && idx >= 1) {
      const list = this.list();
      return list[idx - 1] ?? null;
    }

    return null;
  }

  resolveByIndex(index: number): ProviderConfig | null {
    const list = this.list();
    return list[index] ?? null;
  }

  async scan(): Promise<void> {
    this.providers.clear();

    const manualDir = expandPath('~/.claude/providers');
    if (await dirExists(manualDir)) {
      await this.scanDirectory(manualDir, false);
      this.source = 'manual';
      return;
    }

    const ccSwitchDb = expandPath('~/.cc-switch/cc-switch.db');
    if (await fileExists(ccSwitchDb)) {
      await this.generateFromCcSwitch(ccSwitchDb);
      await this.scanDirectory(this.autoProviderDir, true);
      this.source = 'cc-switch';
      return;
    }

    this.source = 'none';
  }

  private async scanDirectory(dir: string, isTemp: boolean): Promise<void> {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const path = join(dir, file);
      const rawAlias = basename(file, '.json');
      const alias = this.sanitizeName(rawAlias);
      try {
        const content = JSON.parse(readFileSync(path, 'utf8'));
        const name = content.name ?? rawAlias;
        this.providers.set(alias, { alias, name, path, isTemp });
      } catch (err) {
        logger.warn(`Skipping invalid provider config: ${path}`);
      }
    }
  }

  private async generateFromCcSwitch(dbPath: string): Promise<void> {
    try { rmSync(this.autoProviderDir, { recursive: true, force: true }); } catch {}
    mkdirSync(this.autoProviderDir, { recursive: true, mode: 0o700 });

    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const rows = db.query(`
        SELECT name, settings_config
        FROM providers
        WHERE app_type = 'claude'
        ORDER BY sort_index ASC
      `).all() as Array<{ name: string; settings_config: string }>;

      for (const row of rows) {
        try {
          const cleanConfig = this.sanitizeSettingsConfig(row.settings_config);
          const alias = this.sanitizeName(row.name);
          const filePath = join(this.autoProviderDir, `${alias}.json`);
          const tmpPath = filePath + '.tmp';
          writeFileSync(tmpPath, JSON.stringify(cleanConfig, null, 2), { mode: 0o600 });
          renameSync(tmpPath, filePath);
          this.providers.set(alias, { alias, name: row.name, path: filePath, isTemp: true });
        } catch (err) {
          logger.warn(`Skipping CC Switch provider "${row.name}": ${err}`);
        }
      }
    } finally {
      if (db) db.close();
    }
  }

  private sanitizeSettingsConfig(raw: string): object {
    const parsed = JSON.parse(raw);
    const env = parsed.env ?? {};

    const allowedEnvKeys = [
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_REASONING_MODEL',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'API_TIMEOUT_MS',
    ];

    const filteredEnv: Record<string, string> = {};
    for (const key of allowedEnvKeys) {
      if (env[key] !== undefined) {
        filteredEnv[key] = String(env[key]);
      }
    }

    return {
      model: parsed.model ?? 'opus',
      env: filteredEnv,
    };
  }

  private sanitizeName(name: string): string {
    return name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}

export const providerManager = new ProviderManager();

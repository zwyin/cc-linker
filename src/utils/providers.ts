import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { CC_BRIDGE_DIR, expandPath } from './paths';
import { logger } from './logger';
import { Database } from 'bun:sqlite';

export type ProviderSource = 'manual' | 'cc-switch' | 'none';

export interface ProviderConfig {
  alias: string;
  name: string;
  path: string;
  isTemp: boolean;
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
      if (this.providers.size > 0) {
        this.source = 'manual';
        return;
      }
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
      try {
        const content = JSON.parse(readFileSync(path, 'utf8'));
        // Prefer user-defined alias; otherwise generate short alias from filename
        // For temp files (CC Switch generated), the filename is already the short alias
        const baseAlias = content.alias
          ? this.sanitizeName(content.alias)
          : isTemp
            ? rawAlias
            : this.generateShortAlias(rawAlias);
        const alias = this.resolveAliasConflict(baseAlias);
        const name = content.name ?? rawAlias;
        if (this.providers.has(alias)) {
          const existing = this.providers.get(alias)!;
          logger.warn(`Provider alias conflict: "${alias}" from ${path} overrides existing from ${existing.path}`);
        }
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
          const baseAlias = cleanConfig.alias
            ? this.sanitizeName(cleanConfig.alias)
            : this.generateShortAlias(row.name);
          // Ensure unique file path to avoid overwriting
          let alias = baseAlias;
          let filePath = join(this.autoProviderDir, `${alias}.json`);
          let counter = 2;
          while (existsSync(filePath)) {
            alias = `${baseAlias}-${counter}`;
            filePath = join(this.autoProviderDir, `${alias}.json`);
            counter++;
          }
          const tmpPath = filePath + '.tmp';
          // Include name for display; Claude CLI ignores unknown fields in settings files
          const configWithName = { ...cleanConfig, name: row.name, alias: cleanConfig.alias };
          writeFileSync(tmpPath, JSON.stringify(configWithName, null, 2), { mode: 0o600 });
          renameSync(tmpPath, filePath);
        } catch (err) {
          logger.warn(`Skipping CC Switch provider "${row.name}": ${err}`);
        }
      }
    } finally {
      if (db) db.close();
    }
  }

  private sanitizeSettingsConfig(raw: string): { model: string; alias?: string; env: Record<string, string> } {
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
      if (env[key] !== undefined && env[key] !== null) {
        filteredEnv[key] = String(env[key]);
      }
    }

    return {
      model: parsed.model ?? 'opus',
      alias: parsed.alias,
      env: filteredEnv,
    };
  }

  private sanitizeName(name: string): string {
    return name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Generate a short alias from filename for better UX.
   * Rules:
   * 1. Strip common suffixes (plus, pro, max, latest, etc.)
   * 2. Strip platform/brand prefixes (bailian, aliyun, etc.)
   * 3. Remove stopwords (for, with, and, etc.)
   * 4. If still long (>10 chars), take the first segment
   */
  private generateShortAlias(filename: string): string {
    let name = this.sanitizeName(filename);

    // Step 1: Strip common suffixes
    const suffixes = ['plus', 'pro', 'max', 'latest', 'default', 'standard', 'preview', 'beta', 'alpha', 'lite', 'tiny'];
    for (const suffix of suffixes) {
      if (name.endsWith(`-${suffix}`)) {
        name = name.slice(0, -(suffix.length + 1));
        break;
      }
    }

    let parts = name.split('-').filter(p => p.length > 0);

    // Step 2: Strip platform/brand prefixes
    const platforms = ['bailian', 'aliyun', 'tencent', 'baidu', 'volcano', 'doubao', 'aws', 'azure', 'gcp'];
    if (platforms.includes(parts[0]) && parts.length > 2) {
      parts = parts.slice(1);
    }

    // Step 3: Remove stopwords
    const stopwords = ['for', 'with', 'and', 'the', 'a', 'an'];
    parts = parts.filter(p => !stopwords.includes(p));

    // Step 4: Rejoin
    name = parts.join('-');

    // Step 5: If still long AND more than 2 segments, take first segment
    // For 2 segments, keep as-is (brand + model/version usually)
    if (name.length > 12 && parts.length > 2) {
      name = parts[0];
    }

    // Step 6: Restore dots in version numbers (e.g., qwen3-6 → qwen3.6, m2-7 → m2.7)
    name = name.replace(/(\d)-(\d)/g, '$1.$2');

    return name;
  }

  /**
   * Resolve alias conflicts by appending numeric suffixes.
   * Returns a unique alias not present in this.providers.
   */
  private resolveAliasConflict(baseAlias: string): string {
    if (!this.providers.has(baseAlias)) return baseAlias;

    let counter = 2;
    let candidate = `${baseAlias}-${counter}`;
    while (this.providers.has(candidate)) {
      counter++;
      candidate = `${baseAlias}-${counter}`;
    }
    logger.warn(`Provider alias "${baseAlias}" 冲突，自动调整为 "${candidate}"`);
    return candidate;
  }
}

export const providerManager = new ProviderManager();

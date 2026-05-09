import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse } from '@iarna/toml';
import { CONFIG_PATH, REGISTRY_PATH } from './paths';

interface ConfigData {
  general: {
    registry_path: string;
    log_level: string;
    log_path: string | null;
    claude_bin: string;
  };
  scanner: {
    max_file_size: number;
    incremental: boolean;
  };
  feishu_bot: {
    app_id: string;
    app_secret: string;
    owner_user_id: string;
  };
  runtime: {
    stale_timeout_ms: number;
    hard_timeout_ms: number;
    max_concurrent_sessions: number;
    idle_timeout_ms: number;
  };
  security: {
    allowed_roots: string[];
    denied_roots: string[];
    confirm_risky_actions: boolean;
  };
  queue: {
    max_queue_size: number;
    archive_done_after_hours: number;
    archive_failed_after_days: number;
  };
  cli_proxy: {
    enabled: boolean;
  };
  hook: {
    log_path: string;
    timeout: number;
  };
}

const DEFAULTS: ConfigData = {
  general: {
    registry_path: REGISTRY_PATH,
    log_level: 'info',
    log_path: null,
    claude_bin: 'claude',
  },
  scanner: {
    max_file_size: 100 * 1024 * 1024,
    incremental: true,
  },
  feishu_bot: {
    app_id: '',
    app_secret: '',
    owner_user_id: '',
  },
  runtime: {
    stale_timeout_ms: 5 * 60 * 1000,
    hard_timeout_ms: 30 * 60 * 1000,
    max_concurrent_sessions: 2,
    idle_timeout_ms: 30 * 60 * 1000,
  },
  security: {
    allowed_roots: [],
    denied_roots: [],
    confirm_risky_actions: true,
  },
  queue: {
    max_queue_size: 100,
    archive_done_after_hours: 24,
    archive_failed_after_days: 7,
  },
  cli_proxy: {
    enabled: false,
  },
  hook: {
    log_path: '~/.cc-bridge/hook.log',
    timeout: 10,
  },
};

function cloneDefaults(): ConfigData {
  return {
    general: { ...DEFAULTS.general },
    scanner: { ...DEFAULTS.scanner },
    feishu_bot: { ...DEFAULTS.feishu_bot },
    runtime: { ...DEFAULTS.runtime },
    security: { ...DEFAULTS.security },
    queue: { ...DEFAULTS.queue },
    cli_proxy: { ...DEFAULTS.cli_proxy },
    hook: { ...DEFAULTS.hook },
  };
}

export class ConfigManager {
  private data: ConfigData;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? CONFIG_PATH;
    this.data = cloneDefaults();

    if (existsSync(this.configPath)) {
      try {
        const fileData = parse(readFileSync(this.configPath, 'utf8'));
        this.merge(fileData);
      } catch (err) {
        console.warn(`配置文件解析失败: ${err}`);
      }
    }

    this.loadEnv();
  }

  private merge(data: any): void {
    for (const [section, values] of Object.entries(data)) {
      if (this.data[section as keyof ConfigData] && typeof values === 'object') {
        Object.assign(this.data[section as keyof ConfigData], values);
      }
    }
  }

  private loadEnv(): void {
    const mappings: [string, keyof ConfigData, string][] = [
      ['CC_BRIDGE_REGISTRY_PATH', 'general', 'registry_path'],
      ['CC_BRIDGE_LOG_LEVEL', 'general', 'log_level'],
      ['CC_BRIDGE_LOG_PATH', 'general', 'log_path'],
      ['CC_BRIDGE_FEISHU_APP_ID', 'feishu_bot', 'app_id'],
      ['CC_BRIDGE_FEISHU_APP_SECRET', 'feishu_bot', 'app_secret'],
      ['CC_BRIDGE_FEISHU_OWNER_USER_ID', 'feishu_bot', 'owner_user_id'],
      ['CC_BRIDGE_MAX_CONCURRENT_SESSIONS', 'runtime', 'max_concurrent_sessions'],
      ['CC_BRIDGE_MAX_QUEUE_SIZE', 'queue', 'max_queue_size'],
      ['CC_BRIDGE_CONFIRM_RISKY_ACTIONS', 'security', 'confirm_risky_actions'],
    ];

    for (const [envKey, section, key] of mappings) {
      const value = process.env[envKey];
      if (value !== undefined) {
        const target = this.data[section] as Record<string, any>;
        // Convert string env values to appropriate types
        if (typeof target[key] === 'number') {
          target[key] = Number(value);
        } else if (typeof target[key] === 'boolean') {
          target[key] = value.toLowerCase() === 'true';
        } else {
          target[key] = value;
        }
      }
    }
  }

  get<T>(path: string, fallback: T): T {
    const parts = path.split('.');
    let current: any = this.data;
    for (const part of parts) {
      if (current == null) return fallback;
      current = current[part];
    }
    return current ?? fallback;
  }
}

export const config = new ConfigManager();

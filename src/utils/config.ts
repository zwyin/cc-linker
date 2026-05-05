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
  bridge: {
    api_url: string;
    token: string;
    timeout: number;
    restart_delay: number;
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
  bridge: {
    api_url: 'http://localhost:9810',
    token: '',
    timeout: 30,
    restart_delay: 5,
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
    bridge: { ...DEFAULTS.bridge },
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
      ['CC_BRIDGE_TOKEN', 'bridge', 'token'],
      ['CC_BRIDGE_API_URL', 'bridge', 'api_url'],
    ];

    for (const [envKey, section, key] of mappings) {
      const value = process.env[envKey];
      if (value) {
        (this.data[section] as any)[key] = value;
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

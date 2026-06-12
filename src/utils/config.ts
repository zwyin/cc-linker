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
    owner_open_id: string;
    allow_auto_bind_owner: boolean;
    default_cwd: string;
  };
  runtime: {
    stale_timeout_ms: number;
    hard_timeout_ms: number;
    max_concurrent_sessions: number;
    idle_timeout_ms: number;
    session_lock_timeout_ms: number;
    // Session activity sync (v1.2)
    cli_process_detection_enabled: boolean;
    activity_cache_ttl_ms: number;
    activity_marker_ttl_ms: number;
    activity_detection_timeout_ms: number;
  };
  security: {
    allowed_roots: string[];
    denied_roots: string[];
    confirm_risky_actions: boolean;
  };
  queue: {
    max_pending: number;
    worker_concurrency: number;
    done_retention_hours: number;
    done_max_files: number;
    failed_retention_days: number;
    failed_max_files: number;
    delivery_retention_days: number;
    receipt_retention_days: number;
    list_snapshot_ttl_minutes: number;
  };
  cli_proxy: {
    enabled: boolean;
  };
  hook: {
    log_path: string;
    timeout: number;
  };
  stream: {
    enabled: boolean;
    throttle_ms: number;
    show_thinking: boolean;
    max_card_bytes: number;
    fallback_to_text: boolean;
  };
  claude: {
    permission_mode: string;
    allowed_tools: string[];
    disallowed_tools: string[];
  };
  sdk: {
    enabled: boolean;
    permission_mode: string;
    timeout_ms: number;
    claude_executable: string;
  };
  images: {
    enabled: boolean;
    max_size_bytes: number;
    cleanup_max_age_hours: number;
  };
  agent_view: AgentViewConfig;
}

export interface AgentViewConfig {
  enabled: boolean;
  refresh_min_interval_ms: number;
  peek_lines: number;
  peek_max_bytes: number;
  expected_reply_timeout_ms: number;
  background_only: boolean;
  stop_requires_confirm: boolean;
  min_claude_version: string;
  reply_throttle_ms: number;
  // v2.4: rendezvous socket 注入 reply (替代 claude stop + SDK)
  rendezvous_enabled: boolean;
  rendezvous_timeout_ms: number;
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
    owner_open_id: '',
    allow_auto_bind_owner: false,
    default_cwd: '',
  },
  runtime: {
    stale_timeout_ms: 10 * 60 * 1000,
    hard_timeout_ms: 3 * 60 * 60 * 1000,
    max_concurrent_sessions: 5,
    idle_timeout_ms: 30 * 60 * 1000,
    session_lock_timeout_ms: 10 * 60 * 1000,
    cli_process_detection_enabled: true,
    activity_cache_ttl_ms: 10_000,
    activity_marker_ttl_ms: 30 * 60 * 1000,
    activity_detection_timeout_ms: 3_000,
  },
  security: {
    allowed_roots: [],
    denied_roots: [],
    confirm_risky_actions: true,
  },
  queue: {
    max_pending: 100,
    worker_concurrency: 5,
    done_retention_hours: 24,
    done_max_files: 1000,
    failed_retention_days: 7,
    failed_max_files: 200,
    delivery_retention_days: 7,
    receipt_retention_days: 7,
    list_snapshot_ttl_minutes: 10,
  },
  cli_proxy: {
    enabled: false,
  },
  hook: {
    log_path: '~/.cc-linker/hook.log',
    timeout: 10,
  },
  stream: {
    enabled: true,
    throttle_ms: 1500,
    show_thinking: true,
    max_card_bytes: 25000,
    fallback_to_text: true,
  },
  claude: {
    permission_mode: 'acceptEdits',
    allowed_tools: [],
    disallowed_tools: [],
  },
  sdk: {
    enabled: true,
    permission_mode: 'acceptEdits',
    timeout_ms: 600_000,
    // Empty string means "use SDK-bundled Claude binary" instead of
    // looking up `claude` in PATH (which may be a globally-installed
    // version incompatible with this SDK release).
    claude_executable: '',
  },
  images: {
    enabled: true,
    max_size_bytes: 10 * 1024 * 1024,
    cleanup_max_age_hours: 24,
  },
  agent_view: {
    enabled: true,
    refresh_min_interval_ms: 2000,
    peek_lines: 30,
    peek_max_bytes: 2048,
    expected_reply_timeout_ms: 300000,
    background_only: true,
    stop_requires_confirm: true,
    min_claude_version: '2.1.139',
    reply_throttle_ms: 500,
    // v2.4 defaults
    rendezvous_enabled: true,        // v2.4 GA
    rendezvous_timeout_ms: 60_000,
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
    stream: { ...DEFAULTS.stream },
    claude: { ...DEFAULTS.claude },
    sdk: { ...DEFAULTS.sdk },
    images: { ...DEFAULTS.images },
    agent_view: { ...DEFAULTS.agent_view },
  };
}

export class ConfigManager {
  private data: ConfigData;
  private configPath: string;
  private runtimeOverrides = new Map<string, any>();

  constructor(configPath?: string) {
    this.configPath = configPath ?? CONFIG_PATH;
    this.data = cloneDefaults();

    if (existsSync(this.configPath)) {
      try {
        const fileData = parse(readFileSync(this.configPath, 'utf8'));
        this.merge(fileData);
        this.normalizeCompatKeys(fileData);
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

  private normalizeCompatKeys(data?: any): void {
    const rawFeishu = data?.feishu_bot ?? {};
    if (!this.data.feishu_bot.owner_open_id && typeof rawFeishu.owner_user_id === 'string') {
      this.data.feishu_bot.owner_open_id = rawFeishu.owner_user_id;
    }

    const rawQueue = data?.queue ?? {};
    if (rawQueue.max_queue_size !== undefined && this.data.queue.max_pending === DEFAULTS.queue.max_pending) {
      this.data.queue.max_pending = Number(rawQueue.max_queue_size);
    }
    if (rawQueue.archive_done_after_hours !== undefined && this.data.queue.done_retention_hours === DEFAULTS.queue.done_retention_hours) {
      this.data.queue.done_retention_hours = Number(rawQueue.archive_done_after_hours);
    }
    if (rawQueue.archive_failed_after_days !== undefined && this.data.queue.failed_retention_days === DEFAULTS.queue.failed_retention_days) {
      this.data.queue.failed_retention_days = Number(rawQueue.archive_failed_after_days);
    }
  }

  private loadEnv(): void {
    const mappings: [string, keyof ConfigData, string][] = [
      ['CC_LINKER_REGISTRY_PATH', 'general', 'registry_path'],
      ['CC_LINKER_LOG_LEVEL', 'general', 'log_level'],
      ['CC_LINKER_LOG_PATH', 'general', 'log_path'],
      ['CC_LINKER_FEISHU_APP_ID', 'feishu_bot', 'app_id'],
      ['CC_LINKER_FEISHU_APP_SECRET', 'feishu_bot', 'app_secret'],
      ['CC_LINKER_FEISHU_OWNER_OPEN_ID', 'feishu_bot', 'owner_open_id'],
      ['CC_LINKER_FEISHU_DEFAULT_CWD', 'feishu_bot', 'default_cwd'],
      ['CC_LINKER_MAX_CONCURRENT_SESSIONS', 'runtime', 'max_concurrent_sessions'],
      ['CC_LINKER_SESSION_LOCK_TIMEOUT_MS', 'runtime', 'session_lock_timeout_ms'],
      ['CC_LINKER_MAX_QUEUE_SIZE', 'queue', 'max_pending'],
      ['CC_LINKER_CONFIRM_RISKY_ACTIONS', 'security', 'confirm_risky_actions'],
      ['CC_LINKER_STREAM_ENABLED', 'stream', 'enabled'],
      ['CC_LINKER_STREAM_THROTTLE_MS', 'stream', 'throttle_ms'],
      ['CC_LINKER_STREAM_SHOW_THINKING', 'stream', 'show_thinking'],
      ['CC_LINKER_STREAM_MAX_CARD_BYTES', 'stream', 'max_card_bytes'],
      ['CC_LINKER_STREAM_FALLBACK_TO_TEXT', 'stream', 'fallback_to_text'],
      ['CC_LINKER_CLAUDE_PERMISSION_MODE', 'claude', 'permission_mode'],
      ['CC_LINKER_SDK_ENABLED', 'sdk', 'enabled'],
      ['CC_LINKER_SDK_PERMISSION_MODE', 'sdk', 'permission_mode'],
      ['CC_LINKER_SDK_TIMEOUT_MS', 'sdk', 'timeout_ms'],
      ['CC_LINKER_SDK_CLAUDE_EXECUTABLE', 'sdk', 'claude_executable'],
      ['CC_LINKER_IMAGES_ENABLED', 'images', 'enabled'],
      ['CC_LINKER_IMAGES_MAX_SIZE', 'images', 'max_size_bytes'],
      ['CC_LINKER_IMAGES_CLEANUP_HOURS', 'images', 'cleanup_max_age_hours'],
      ['CC_LINKER_AGENT_VIEW_ENABLED', 'agent_view', 'enabled'],
      ['CC_LINKER_AGENT_VIEW_REFRESH_MIN_INTERVAL_MS', 'agent_view', 'refresh_min_interval_ms'],
      ['CC_LINKER_AGENT_VIEW_PEEK_LINES', 'agent_view', 'peek_lines'],
      ['CC_LINKER_AGENT_VIEW_PEEK_MAX_BYTES', 'agent_view', 'peek_max_bytes'],
      ['CC_LINKER_AGENT_VIEW_EXPECTED_REPLY_TIMEOUT_MS', 'agent_view', 'expected_reply_timeout_ms'],
      ['CC_LINKER_AGENT_VIEW_BACKGROUND_ONLY', 'agent_view', 'background_only'],
      ['CC_LINKER_AGENT_VIEW_STOP_REQUIRES_CONFIRM', 'agent_view', 'stop_requires_confirm'],
      ['CC_LINKER_AGENT_VIEW_REPLY_THROTTLE_MS', 'agent_view', 'reply_throttle_ms'],
    ];

    // Parse array env vars for Claude tools
    const allowedToolsEnv = process.env.CC_LINKER_CLAUDE_ALLOWED_TOOLS;
    if (allowedToolsEnv !== undefined) {
      this.data.claude.allowed_tools = allowedToolsEnv.split(',').map(s => s.trim()).filter(Boolean);
    }
    const disallowedToolsEnv = process.env.CC_LINKER_CLAUDE_DISALLOWED_TOOLS;
    if (disallowedToolsEnv !== undefined) {
      this.data.claude.disallowed_tools = disallowedToolsEnv.split(',').map(s => s.trim()).filter(Boolean);
    }

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

    const legacyOwner = process.env.CC_LINKER_FEISHU_OWNER_USER_ID;
    if (legacyOwner && !this.data.feishu_bot.owner_open_id) {
      this.data.feishu_bot.owner_open_id = legacyOwner;
    }
  }

  get<T>(path: string, fallback: T): T {
    if (this.runtimeOverrides.has(path)) {
      return this.runtimeOverrides.get(path) as T;
    }
    const parts = path.split('.');
    let current: any = this.data;
    for (const part of parts) {
      if (current == null) return fallback;
      current = current[part];
    }
    return current ?? fallback;
  }

  setRuntimeOverride(key: string, value: any): void {
    this.runtimeOverrides.set(key, value);
    const [section, k] = key.split('.');
    if (this.data[section as keyof ConfigData]) {
      (this.data[section as keyof ConfigData] as any)[k] = value;
    }
  }
}

export const config = new ConfigManager();

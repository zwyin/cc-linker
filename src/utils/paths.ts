import { join } from 'path';
import { homedir } from 'os';

function getHome(): string {
  return process.env.HOME ?? homedir();
}

// Lazily-computed paths that respect HOME env var override (for testing)
// Use getter functions or recompute when needed; these are convenience
// constants for the default (non-test) case.
export const HOME = getHome();
export const CC_BRIDGE_DIR = process.env.CC_BRIDGE_DIR ?? join(HOME, '.cc-bridge');
export const REGISTRY_PATH = process.env.CC_BRIDGE_REGISTRY_PATH ?? join(CC_BRIDGE_DIR, 'registry.json');
export const BACKUP_DIR = join(CC_BRIDGE_DIR, 'backups');
export const SCAN_CACHE_PATH = join(CC_BRIDGE_DIR, 'scan_cache.json');
export const HOOK_LOG_PATH = join(CC_BRIDGE_DIR, 'hook.log');
export const CONFIG_PATH = process.env.CC_BRIDGE_CONFIG_PATH ?? join(CC_BRIDGE_DIR, 'config.toml');

export const CC_CONNECT_SESSIONS_DIR = join(HOME, '.cc-connect', 'sessions');
export const CLAUDE_PROJECTS_DIR = join(HOME, '.claude', 'projects');
export const CLAUDE_SETTINGS_PATH = join(HOME, '.claude', 'settings.json');

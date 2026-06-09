import { join } from 'path';
import { homedir } from 'os';

function getHome(): string {
  return process.env.HOME ?? homedir();
}

export const HOME = getHome();
export const CC_LINKER_DIR = process.env.CC_LINKER_DIR ?? join(HOME, '.cc-linker');
export const REGISTRY_PATH = process.env.CC_LINKER_REGISTRY_PATH ?? join(CC_LINKER_DIR, 'registry.json');
export const BACKUP_DIR = join(CC_LINKER_DIR, 'backups');
export const SCAN_CACHE_PATH = join(CC_LINKER_DIR, 'scan_cache.json');
export const IMAGES_DIR = join(CC_LINKER_DIR, 'images');
export const HOOK_LOG_PATH = join(CC_LINKER_DIR, 'hook.log');
export const CONFIG_PATH = process.env.CC_LINKER_CONFIG_PATH ?? join(CC_LINKER_DIR, 'config.toml');

// Feishu Bot paths
export const USER_MAPPING_PATH = join(CC_LINKER_DIR, 'user-mapping.json');
export const LIST_SNAPSHOT_PATH = join(CC_LINKER_DIR, 'list-snapshot.json');

// Agent View: shortId → display name cache (populated from active `claude agents --json`,
// used to recover name for settled sessions after daemon clears its roster entry).
export const AGENT_NAMES_CACHE_PATH = join(CC_LINKER_DIR, 'agent-names-cache.json');

// Runtime paths
export const RUNTIME_OWNER_LOCK_PATH = join(CC_LINKER_DIR, 'owner.lock');
export const RUNTIME_SESSION_EVENTS_DIR = join(CC_LINKER_DIR, 'session-events');
export const RUNTIME_PID_FILE = join(CC_LINKER_DIR, 'cc-linker.pid');
export const RUNTIME_LOG_FILE = join(CC_LINKER_DIR, 'cc-linker.log');

// Session activity sidecar files (one per session, see session-activity-sync spec)
export const ACTIVITY_DIR = join(CC_LINKER_DIR, 'activity');

// Spool queue paths
export const SPOOL_DIR = join(CC_LINKER_DIR, 'spool');
export const SPOOL_PENDING_DIR = join(SPOOL_DIR, 'pending');
export const SPOOL_PROCESSING_DIR = join(SPOOL_DIR, 'processing');
export const SPOOL_REPLIED_DIR = join(SPOOL_DIR, 'replied');
export const SPOOL_DONE_DIR = join(SPOOL_DIR, 'done');
export const SPOOL_FAILED_DIR = join(SPOOL_DIR, 'failed');
export const SPOOL_RECEIPTS_DIR = join(SPOOL_DIR, 'receipts');
export const SPOOL_DELIVERIES_DIR = join(SPOOL_DIR, 'deliveries');

/** Expand ~/ to absolute path */
export function expandPath(p: string): string {
  if (p === '~') return process.env.HOME ?? '';
  if (p.startsWith('~/')) return join(process.env.HOME ?? '', p.slice(2));
  return p;
}

// Claude paths
export const CLAUDE_PROJECTS_DIR = join(HOME, '.claude', 'projects');
export const CLAUDE_SETTINGS_PATH = join(HOME, '.claude', 'settings.json');
/** ~/.claude/jobs/<short>/state.json — Claude CLI's authoritative bg-job state machine (v2.3+ Agent View primary source). */
export const CLAUDE_JOBS_DIR = join(HOME, '.claude', 'jobs');

import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { formatTable, formatJson, formatCsv, formatTimeAgo, formatOrigin } from '../output';

interface ListOptions {
  project?: string;
  origin?: string;
  active?: boolean;
  archived?: boolean;
  format?: string;
  limit?: string;
  sort?: string;
}

export async function list(registry: RegistryManager, opts: ListOptions): Promise<void> {
  let sessions = Object.entries(registry.sessions);

  // 默认仅显示 active 会话；--archived 显示 archived/corrupted；不存在 status 字段视为 active（向后兼容）
  if (!opts.archived) {
    sessions = sessions.filter(([_, s]) => !s.status || s.status === 'active');
  } else {
    sessions = sessions.filter(([_, s]) => s.status === 'archived' || s.status === 'corrupted' || s.status === 'degraded' || s.status === 'provisioning');
  }

  // Apply filters
  if (opts.project) {
    sessions = sessions.filter(([_, s]) => s.project_name?.includes(opts.project!));
  }
  if (opts.origin) {
    sessions = sessions.filter(([_, s]) => s.origin === opts.origin);
  }
  if (opts.active) {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    sessions = sessions.filter(([_, s]) => s.last_active > twoHoursAgo);
  }

  // Sort
  const sortField = opts.sort ?? 'last_active';
  sessions.sort((a, b) => {
    if (sortField === 'created_at') return b[1].created_at.localeCompare(a[1].created_at);
    if (sortField === 'message_count') return b[1].message_count - a[1].message_count;
    return b[1].last_active.localeCompare(a[1].last_active);
  });

  // Limit
  const limit = parseInt(opts.limit ?? '20', 10);
  sessions = sessions.slice(0, limit);

  // Output
  const format = opts.format ?? 'table';
  if (format === 'json') {
    console.log(formatJson(sessions));
  } else if (format === 'csv') {
    console.log(formatCsv(sessions));
  } else {
    if (sessions.length === 0) {
      console.log(chalk.yellow('没有找到会话'));
      return;
    }

    console.log(formatTable(sessions));
    console.log(`\n共 ${sessions.length} 个会话。使用 cc-bridge resume <Ref> 或完整 UUID 恢复会话。`);
  }
}

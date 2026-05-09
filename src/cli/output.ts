import Table from 'cli-table3';
import chalk from 'chalk';
import type { SessionEntry } from '../registry';

export function formatTimeAgo(isoDate: string): string {
  const now = new Date();
  const date = new Date(isoDate);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return '刚刚';
  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 30) return `${diffDays} 天前`;
  return date.toLocaleDateString('zh-CN');
}

export function formatOrigin(origin: string): string {
  return origin === 'feishu' ? chalk.green('飞书') : chalk.blue('终端');
}

export function formatTable(sessions: Array<[string, SessionEntry]>): string {
  const table = new Table({
    head: ['Ref', '标题', '来源', '项目', '消息', '最后活跃'],
    colWidths: [10, 30, 10, 15, 8, 15],
  });

  for (const [uuid, s] of sessions) {
    table.push([
      uuid.slice(0, 8),
      s.title?.slice(0, 28) ?? 'Untitled',
      formatOrigin(s.origin),
      s.project_name?.slice(0, 13) ?? '?',
      s.message_count.toString(),
      formatTimeAgo(s.last_active),
    ]);
  }

  return table.toString();
}

export function formatJson(sessions: Array<[string, SessionEntry]>): string {
  return JSON.stringify(
    sessions.map(([uuid, s]) => ({
      ref: uuid.slice(0, 8),
      uuid,
      title: s.title,
      origin: s.origin,
      project_name: s.project_name,
      cwd: s.cwd,
      message_count: s.message_count,
      last_active: s.last_active,
    })),
    null,
    2
  );
}

function sanitizeCsvField(value: string): string {
  // Prevent CSV injection by prefixing formula characters with single quote
  if (/^[=+\-@\t\r]/.test(value)) {
    return "'" + value;
  }
  // Escape double quotes and wrap in quotes
  return `"${value.replace(/"/g, '""')}"`;
}

export function formatCsv(sessions: Array<[string, SessionEntry]>): string {
  const header = 'ref,uuid,title,origin,project_name,cwd,message_count,last_active';
  const rows = sessions.map(([uuid, s]) =>
    [uuid.slice(0, 8), uuid, sanitizeCsvField(s.title ?? ''), s.origin, sanitizeCsvField(s.project_name ?? ''), sanitizeCsvField(s.cwd), s.message_count, s.last_active].join(',')
  );
  return [header, ...rows].join('\n');
}

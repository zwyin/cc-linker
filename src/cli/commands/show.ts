import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { CCBridgeError } from '../../utils/errors';
import { formatOrigin, formatTimeAgo } from '../output';

export async function show(registry: RegistryManager, target: string): Promise<void> {
  const match = registry.findByPrefix(target);
  if (!match) {
    throw new CCBridgeError('E002', `未找到匹配 "${target}" 的会话`);
  }

  const [uuid, s] = match;

  console.log(chalk.bold('会话详情'));
  console.log('─'.repeat(40));
  console.log(`UUID:        ${uuid}`);
  console.log(`标题:        ${s.title ?? 'Untitled'}`);
  console.log(`来源:        ${formatOrigin(s.origin)} (${s.source})`);
  console.log(`项目:        ${s.project_name ?? '?'}`);
  console.log(`工作目录:    ${s.cwd}`);
  console.log(`状态:        ${s.status ?? 'active'}`);
  console.log(`创建时间:    ${new Date(s.created_at).toLocaleString('zh-CN')}`);
  console.log(`最后活跃:    ${formatTimeAgo(s.last_active)}`);
  console.log(`消息数:      ${s.message_count}`);
  console.log(`\nJSONL 文件: ${s.jsonl_path}`);
  console.log(`\n操作:`);
  console.log(`  cc-bridge resume ${uuid.slice(0, 8)}   恢复此会话`);
}

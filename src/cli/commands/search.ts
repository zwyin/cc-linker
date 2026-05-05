import { createReadStream, existsSync, statSync } from 'fs';
import { createInterface } from 'readline';
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { formatTable } from '../output';
import { logger } from '../../utils/logger';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

interface SearchOptions {
  inTitle?: boolean;
  inContent?: boolean;
  limit?: string;
}

export async function search(
  registry: RegistryManager,
  query: string,
  opts: SearchOptions = {}
): Promise<void> {
  const lowerQuery = query.toLowerCase();

  let matches = Object.entries(registry.sessions)
    .filter(([_, s]) => {
      if (opts.inTitle) {
        return s.title?.toLowerCase().includes(lowerQuery);
      }
      return s.title?.toLowerCase().includes(lowerQuery) ||
        (s.last_message_preview ?? '').toLowerCase().includes(lowerQuery);
    });

  // --in-content: 搜索 JSONL 文件内容
  if (opts.inContent && matches.length === 0) {
    console.log(chalk.blue('搜索 JSONL 内容中（可能较慢）...'));
    const contentMatches: Array<[string, typeof registry.sessions[string]]> = [];

    for (const [uuid, entry] of Object.entries(registry.sessions)) {
      if (!entry.jsonl_path || !existsSync(entry.jsonl_path)) continue;
      try {
        const stat = statSync(entry.jsonl_path);
        if (stat.size > MAX_FILE_SIZE) {
          logger.warn(`跳过过大的 JSONL 文件 (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${entry.jsonl_path}`);
          continue;
        }
      } catch {
        continue;
      }

      const fileStream = createReadStream(entry.jsonl_path, { encoding: 'utf8' });
      try {
        const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
        let found = false;
        for await (const line of rl) {
          if (line.toLowerCase().includes(lowerQuery)) {
            found = true;
            break;
          }
        }
        if (found) contentMatches.push([uuid, entry]);
      } catch {
        // 跳过读取失败的文件
      } finally {
        fileStream.destroy();
      }
    }
    matches = contentMatches;
  }

  if (matches.length === 0) {
    console.log(chalk.yellow(`未找到包含 "${query}" 的会话`));
    return;
  }

  const total = matches.length;
  const limit = opts.limit ? parseInt(opts.limit, 10) : 20;
  if (matches.length > limit) {
    matches = matches.slice(0, limit);
  }

  if (total > limit) {
    console.log(`找到 ${total} 个匹配（显示前 ${limit} 个，使用 --limit 调整）:\n`);
  } else {
    console.log(`找到 ${total} 个匹配:\n`);
  }
  console.log(formatTable(matches));
}

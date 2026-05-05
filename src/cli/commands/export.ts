import { createReadStream, createWriteStream, statSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { CCBridgeError } from '../../utils/errors';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB

interface ExportOptions {
  format?: string;
  output?: string;
  includeThinking?: boolean;
  includeTools?: boolean;
  maxMessages?: string;
}

export async function exportSession(
  registry: RegistryManager,
  target: string,
  opts: ExportOptions = {}
): Promise<void> {
  const match = registry.findByPrefix(target);
  if (!match) {
    throw new CCBridgeError('E002', `未找到匹配 "${target}" 的会话`);
  }

  const [uuid, entry] = match;
  const format = opts.format ?? 'markdown';
  const outputFile = opts.output ?? `./export-${uuid.slice(0, 8)}.${format === 'markdown' ? 'md' : format === 'json' ? 'json' : 'txt'}`;
  const maxMessages = opts.maxMessages ? (() => {
    const n = parseInt(opts.maxMessages, 10);
    if (isNaN(n)) throw new CCBridgeError('E005', `无效的消息数: ${opts.maxMessages}`);
    return n;
  })() : undefined;

  // 安全防护：检查 JSONL 文件存在
  if (!existsSync(entry.jsonl_path)) {
    throw new CCBridgeError('E002', `JSONL 文件不存在: ${entry.jsonl_path}`);
  }

  // 检查文件大小
  const stat = statSync(entry.jsonl_path);
  if (stat.size > MAX_FILE_SIZE) {
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: `文件大小 ${sizeMB}MB，导出可能需要较长时间。继续？`,
      default: false,
    }]);
    if (!confirmed) return;
  }

  console.log(chalk.blue(`导出会话: ${entry.title ?? uuid}`));

  const fileStream = createReadStream(entry.jsonl_path, { encoding: 'utf8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  const writeStream = createWriteStream(outputFile);
  const jsonEntries: any[] = [];

  let writeError: string | null = null;
  writeStream.on('error', (err) => {
    writeError = err.message;
  });

  // Write header for markdown format
  if (format === 'markdown') {
    const created = entry.created_at ? new Date(entry.created_at).toLocaleString('zh-CN') : 'Unknown';
    const platform = entry.platform ? ` (${entry.platform})` : '';
    writeStream.write(`# ${entry.title ?? 'Untitled'}\n\n`);
    writeStream.write(`> Session: ${uuid}\n`);
    writeStream.write(`> Source: ${entry.origin}${platform}\n`);
    writeStream.write(`> Created: ${created}\n`);
    writeStream.write(`> Messages: ${entry.message_count}\n\n`);
    writeStream.write(`---\n\n`);
  }

  let count = 0;
  for await (const line of rl) {
    if (maxMessages && count >= maxMessages) break;

    try {
      const item = JSON.parse(line);

      if (item.type === 'user' || item.type === 'assistant') {
        count++;
        const time = new Date(item.timestamp).toLocaleTimeString('zh-CN');
        const role = item.type === 'user' ? 'User' : 'Assistant';

        const parts: string[] = [];
        if (item.type === 'user') {
          const msgContent = item.message?.content;
          if (typeof msgContent === 'string') {
            parts.push(truncate(msgContent));
          } else if (Array.isArray(msgContent)) {
            for (const block of msgContent) {
              if (block.type === 'text') {
                parts.push(truncate(block.text));
              } else if (block.type === 'tool_result' && opts.includeTools) {
                const resultText = typeof block.content === 'string'
                  ? block.content
                  : block.content?.map?.((c: any) => c.text).filter(Boolean).join('\n') ?? '';
                parts.push(`[tool_result: ${truncate(resultText)}]`);
              }
            }
          }
        } else {
          for (const block of (item.message?.content ?? [])) {
            if (block.type === 'text') {
              parts.push(truncate(block.text));
            } else if (block.type === 'thinking' && opts.includeThinking) {
              parts.push(`[thinking] ${truncate(block.thinking)}`);
            } else if (block.type === 'tool_use' && opts.includeTools) {
              const input = block.input ? JSON.stringify(block.input).slice(0, 200) : '';
              parts.push(`[tool_use: ${block.name}(${input})]`);
            }
          }
        }

        const text = parts.join('\n') || '';

        if (format === 'markdown') {
          writeStream.write(`**${role}** (${time}): ${text}\n\n`);
        } else if (format === 'json') {
          jsonEntries.push({ role, time, text });
        } else {
          writeStream.write(`[${time}] ${role}: ${text}\n`);
        }

        // 定期刷新缓冲区
        if (count % 100 === 0) {
          writeStream.write('');
        }
      }
    } catch {
      // Silently skip malformed JSON lines
    }
  }

  // Write JSON footer if needed
  if (format === 'json') {
    writeStream.write(JSON.stringify({
      session: uuid,
      title: entry.title,
      origin: entry.origin,
      platform: entry.platform,
      created_at: entry.created_at,
      message_count: count,
      messages: jsonEntries,
    }, null, 2));
  }

  writeStream.end();

  // Wait for stream to finish writing
  await new Promise<void>((resolve, reject) => {
    writeStream.on('close', () => {
      if (writeError) reject(new CCBridgeError('E010', `写入文件失败: ${writeError}`));
      else resolve();
    });
    writeStream.on('error', reject);
  });

  console.log(chalk.green(`导出完成: ${outputFile} (${count} 条消息)`));
}

function truncate(text: string | undefined): string {
  if (!text) return '';
  if (text.length > MAX_MESSAGE_SIZE) {
    return text.slice(0, MAX_MESSAGE_SIZE) + ' [truncated]';
  }
  return text;
}

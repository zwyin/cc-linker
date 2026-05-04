import { createReadStream, createWriteStream } from 'fs';
import { createInterface } from 'readline';
import chalk from 'chalk';
import { RegistryManager } from '../../registry';
import { CCBridgeError } from '../../utils/errors';

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
  const outputFile = opts.output ?? `./export-${uuid.slice(0, 8)}.${format === 'markdown' ? 'md' : format}`;
  const maxMessages = opts.maxMessages ? parseInt(opts.maxMessages, 10) : undefined;

  console.log(chalk.blue(`导出会话: ${entry.title ?? uuid}`));

  const fileStream = createReadStream(entry.jsonl_path, { encoding: 'utf8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  const writeStream = createWriteStream(outputFile);

  if (format === 'markdown') {
    writeStream.write(`# ${entry.title ?? 'Untitled'}\n\n> Session: ${uuid}\n> Source: ${entry.origin}\n\n---\n\n`);
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

        let text = '';
        if (item.type === 'user') {
          text = typeof item.message?.content === 'string'
            ? item.message.content
            : item.message?.content?.[0]?.text ?? '';
        } else {
          const textBlock = item.message?.content?.find((b: any) => b.type === 'text');
          text = textBlock?.text ?? '';
        }

        if (format === 'markdown') {
          writeStream.write(`**${role}** (${time}): ${text}\n\n`);
        } else {
          writeStream.write(`[${time}] ${role}: ${text}\n`);
        }
      }
    } catch {
      // Silently skip malformed JSON lines
    }
  }

  writeStream.end();
  console.log(chalk.green(`导出完成: ${outputFile} (${count} 条消息)`));
}

import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import type { RegistryManager, SessionEntry, Origin } from '../registry';
import type { FileCache } from './cache';
import { logger } from '../utils/logger';

export class JSONLScanner {
  private registry: RegistryManager;
  private ccConnectUuids: Set<string>;
  private fileCache: FileCache;
  private claudeDir: string;

  constructor(
    registry: RegistryManager,
    ccConnectUuids: Set<string>,
    fileCache: FileCache,
    claudeDir?: string
  ) {
    this.registry = registry;
    this.ccConnectUuids = ccConnectUuids;
    this.fileCache = fileCache;
    this.claudeDir = claudeDir ?? join(homedir(), '.claude');
  }

  async scan(): Promise<void> {
    const projectsDir = join(this.claudeDir, 'projects');
    if (!existsSync(projectsDir)) return;

    for (const projectDir of readdirSync(projectsDir)) {
      const fullPath = join(projectsDir, projectDir);
      try {
        if (!statSync(fullPath).isDirectory()) continue;
      } catch {
        continue;
      }

      for (const file of readdirSync(fullPath)) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = join(fullPath, file);
        const sessionId = file.replace('.jsonl', '');

        try {
          const stat = statSync(filePath);
          const mtime = stat.mtimeMs;

          const cachedMtime = this.fileCache.get(filePath);
          if (cachedMtime && mtime <= cachedMtime) continue;

          if (!this.registry.has(sessionId)) {
            const meta = this.parseFull(filePath, sessionId);
            await this.registry.upsert(sessionId, {
              ...meta,
              jsonl_path: filePath,
              source: 'terminal',
            });
          } else {
            const meta = this.parseTail(filePath);
            await this.registry.upsert(sessionId, meta);
          }

          this.fileCache.set(filePath, mtime);
        } catch (err) {
          logger.warn(`解析 JSONL 文件失败: ${filePath}: ${err}`);
        }
      }
    }
  }

  private parseFull(filePath: string, sessionId: string): Partial<SessionEntry> {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);

    let entrypoint: string | null = null;
    let cwd: string | null = null;
    let aiTitle: string | null = null;
    let lastPrompt: string | null = null;

    for (let i = 0; i < Math.min(lines.length, 20); i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (!entrypoint && entry.entrypoint) entrypoint = entry.entrypoint;
        if (!cwd && entry.cwd) cwd = entry.cwd;
        if (entry.type === 'ai-title' && !aiTitle) aiTitle = entry.aiTitle;
        if (entry.type === 'last-prompt' && !lastPrompt) lastPrompt = entry.lastPrompt;
      } catch {
        // Silently skip malformed JSON lines
      }
    }

    let lastActive: string | null = null;
    let preview = '';
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if ((entry.type === 'assistant' || entry.type === 'user') && !lastActive) {
          lastActive = entry.timestamp;
        }
        if (entry.type === 'assistant' && !preview) {
          const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
          if (textBlock) preview = textBlock.text.slice(0, 100);
        }
      } catch {
        // Silently skip malformed JSON lines
      }
    }

    const origin: Origin = this.ccConnectUuids.has(sessionId)
      ? 'cc-connect'
      : entrypoint === 'sdk-cli'
        ? 'cc-connect'
        : 'cli';

    const title = aiTitle
      ?? (lastPrompt ? lastPrompt.slice(0, 50) + (lastPrompt.length > 50 ? '...' : '') : null)
      ?? `Untitled (${sessionId.slice(0, 8)})`;

    return {
      origin,
      cwd: cwd ?? homedir(),
      project_name: this.inferProjectName(cwd ?? homedir()),
      title,
      message_count: lines.length,
      last_active: lastActive ?? new Date().toISOString(),
      last_message_preview: preview || lastPrompt?.slice(0, 100) || '[无内容]',
      status: 'active',
    };
  }

  private parseTail(filePath: string): Partial<SessionEntry> {
    const stat = statSync(filePath);
    const readSize = Math.min(4096, stat.size);
    const fd = openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      readSync(fd, buffer, 0, readSize, stat.size - readSize);

      const tail = buffer.toString('utf8');
      const lines = tail.split('\n').filter(Boolean).slice(-10);

      let lastActive: string | null = null;
      let preview = '';

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'assistant' || entry.type === 'user') {
            if (!lastActive) lastActive = entry.timestamp;
          }
          if (entry.type === 'assistant' && !preview) {
            const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
            if (textBlock) preview = textBlock.text.slice(0, 100);
          }
        } catch {
          // Silently skip malformed JSON lines
        }
      }

      // message_count is intentionally omitted — it's set correctly in parseFull
      // and doesn't need to be recalculated on every incremental scan
      return {
        last_active: lastActive ?? undefined,
        last_message_preview: preview || undefined,
      };
    } finally {
      closeSync(fd);
    }
  }

  private inferProjectName(cwd: string): string | null {
    if (!cwd || cwd === homedir()) return 'Home';
    return basename(cwd);
  }
}

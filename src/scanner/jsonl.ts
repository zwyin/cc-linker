import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { parse as parseToml } from '@iarna/toml';
import type { RegistryManager, SessionEntry, Origin } from '../registry';
import type { FileCache } from './cache';
import { logger } from '../utils/logger';
import { config } from '../utils/config';

const PROJECT_NAME_FILES = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml'];
const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export class JSONLScanner {
  private registry: RegistryManager;
  private fileCache: FileCache;
  private claudeDir: string;

  constructor(
    registry: RegistryManager,
    fileCache: FileCache,
    claudeDir?: string
  ) {
    this.registry = registry;
    this.fileCache = fileCache;
    // 使用 process.env.HOME 而非 homedir()，以支持测试中的 HOME 环境变量覆盖
    this.claudeDir = claudeDir ?? join(process.env.HOME ?? homedir(), '.claude');
  }

  scan(): void {
    const projectsDir = join(this.claudeDir, 'projects');
    if (!existsSync(projectsDir)) return;

    const maxFileSize = config.get<number>('scanner.max_file_size', DEFAULT_MAX_FILE_SIZE);

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

          // Skip files that are too large to parse
          if (stat.size > maxFileSize) {
            logger.warn(`跳过过大的 JSONL 文件 (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${filePath}`);
            continue;
          }

          const cachedMtime = this.fileCache.get(filePath);
          if (cachedMtime && mtime <= cachedMtime) {
            continue;
          }

          if (!this.registry.has(sessionId)) {
            const meta = this.parseFull(filePath, sessionId);
            this.registry.upsert(sessionId, {
              ...meta,
              jsonl_path: filePath,
            });
          } else {
            // 已注册会话：检查是否已有 JSONL 元数据（如标题）
            const existing = this.registry.get(sessionId);
            const hasJsonlMeta = existing && existing.title && existing.cwd;
            const isUntitled = existing?.title?.startsWith('Untitled');
            if (!hasJsonlMeta || isUntitled) {
              // 首次遇到此文件 或 标题是 Untitled，完整解析以提取标题
              const meta = this.parseFull(filePath, sessionId);
              this.registry.upsert(sessionId, {
                ...meta,
                jsonl_path: filePath,
              });
            } else {
              // 已有元数据，只更新活跃信息
              const meta = this.parseTail(filePath);
              // 若此前因 JSONL 缺失被标记为 corrupted，现在文件恢复则自动重置
              if (existing?.status === 'corrupted') {
                (meta as any).status = 'active';
              }
              this.registry.upsert(sessionId, meta);
            }
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

    let cwd: string | null = null;
    let aiTitle: string | null = null;
    let lastPrompt: string | null = null;
    let firstUserMessage: string | null = null;
    let createdAt: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (!cwd && entry.cwd) cwd = entry.cwd;
        if (entry.type === 'ai-title' && !aiTitle) aiTitle = entry.aiTitle;
        if (entry.type === 'last-prompt' && !lastPrompt) lastPrompt = entry.lastPrompt;
        // 从第一个用户消息中提取标题（作为 ai-title 和 last-prompt 的备选）
        if (!firstUserMessage && entry.type === 'user') {
          const content = entry.message?.content;
          if (typeof content === 'string' && content.length > 0) {
            firstUserMessage = content;
          } else if (Array.isArray(content)) {
            const textBlock = content.find((b: any) => b.type === 'text');
            if (textBlock?.text) firstUserMessage = textBlock.text;
          }
        }
        // 提取创建时间：取最早的时间戳（首条有 timestamp 的记录）
        if (!createdAt && entry.timestamp) createdAt = entry.timestamp;
        // Early exit: once we have all metadata, no need to keep scanning
        if (cwd && aiTitle && lastPrompt && firstUserMessage && createdAt) break;
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

    // 自建方案下，JSONLScanner 扫描的均为 CLI 会话
    const origin: Origin = 'cli';

    // 标题优先级：ai-title > last-prompt > 第一条用户消息 > Untitled
    const title = aiTitle
      ?? (lastPrompt ? lastPrompt.slice(0, 50) + (lastPrompt.length > 50 ? '...' : '') : null)
      ?? (firstUserMessage ? firstUserMessage.slice(0, 50) + (firstUserMessage.length > 50 ? '...' : '') : null)
      ?? `Untitled (${sessionId.slice(0, 8)})`;

    // project_dir: 从 jsonl_path 提取 Claude Code project 目录名
    const jsonlPath = filePath;
    const projectDirMatch = jsonlPath.match(/\/([^/]+)\/[^/]+\.jsonl$/);
    const project_dir = projectDirMatch ? projectDirMatch[1] : null;

    return {
      origin,
      cwd: cwd ?? (process.env.HOME ?? homedir()),
      project_name: this.inferProjectName(cwd ?? (process.env.HOME ?? homedir())),
      project_dir,
      title,
      message_count: lines.length,
      created_at: createdAt ?? new Date().toISOString(),
      last_active: lastActive ?? new Date().toISOString(),
      last_message_preview: preview || lastPrompt?.slice(0, 100) || '[无内容]',
      status: 'active',
    };
  }

  private parseTail(filePath: string): Partial<SessionEntry> {
    const stat = statSync(filePath);

    // 读取文件末尾最多 4KB 用于提取 last_active 和 preview
    const readSize = Math.min(4096, stat.size);
    const fd = openSync(filePath, 'r');
    let lastActive: string | null = null;
    let preview = '';
    let lineCount = 0;

    try {
      if (stat.size > 4096) {
        // 大文件：只读尾部来提取活跃信息和行数估算
        const buffer = Buffer.alloc(readSize);
        readSync(fd, buffer, 0, readSize, stat.size - readSize);
        const tail = buffer.toString('utf8');
        const tailLines = tail.split('\n').filter(Boolean).slice(-10);

        for (let i = tailLines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(tailLines[i]);
            if (entry.type === 'assistant' || entry.type === 'user') {
              if (!lastActive) lastActive = entry.timestamp;
            }
            if (entry.type === 'assistant' && !preview) {
              const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
              if (textBlock) preview = textBlock.text.slice(0, 100);
            }
          } catch {}
        }

        // 行数估算：总大小 / 平均行长度(用尾部估算)
        // 对于只需要更新活跃信息的场景，不需要精确行数
        lineCount = 0; // 不可精确获取，保留原值
      } else {
        // 小文件：直接读全部
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        lineCount = lines.length;

        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
          try {
            const entry = JSON.parse(lines[i]);
            if (entry.type === 'assistant' || entry.type === 'user') {
              if (!lastActive) lastActive = entry.timestamp;
            }
            if (entry.type === 'assistant' && !preview) {
              const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
              if (textBlock) preview = textBlock.text.slice(0, 100);
            }
          } catch {}
        }
      }

      return {
        ...(lineCount > 0 ? { message_count: lineCount } : {}),
        ...(lastActive ? { last_active: lastActive } : {}),
        ...(preview ? { last_message_preview: preview } : {}),
      };
    } finally {
      closeSync(fd);
    }
  }

  private inferProjectName(cwd: string): string | null {
    const homeDir = process.env.HOME ?? homedir();
    if (!cwd || cwd === homeDir) return 'Home';

    // 尝试从项目配置文件中读取 name
    for (const nameFile of PROJECT_NAME_FILES) {
      const fp = join(cwd, nameFile);
      if (!existsSync(fp)) continue;
      const name = this.extractNameFromFile(fp, nameFile);
      if (name) return name;
    }

    // fallback: 目录名
    return basename(cwd);
  }

  private extractNameFromFile(filePath: string, fileType: string): string | null {
    try {
      const content = readFileSync(filePath, 'utf8');

      if (fileType === 'package.json') {
        const parsed = JSON.parse(content);
        return parsed.name ?? null;
      }

      if (fileType === 'Cargo.toml') {
        const parsed = parseToml(content) as any;
        return parsed?.package?.name ?? null;
      }

      if (fileType === 'go.mod') {
        for (const line of content.split('\n')) {
          if (line.startsWith('module ')) {
            return line.trim().split('/').pop() ?? null;
          }
        }
        return null;
      }

      if (fileType === 'pyproject.toml') {
        // 简单提取 [project].name 或 [tool.poetry].name
        const lines = content.split('\n');
        let inProject = false;
        let inPoetry = false;
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '[project]') { inProject = true; inPoetry = false; continue; }
          if (trimmed === '[tool.poetry]') { inPoetry = true; inProject = false; continue; }
          if (trimmed.startsWith('[')) { inProject = false; inPoetry = false; continue; }
          if ((inProject || inPoetry) && trimmed.startsWith('name')) {
            const match = trimmed.match(/name\s*=\s*"([^"]+)"/);
            if (match) return match[1];
          }
        }
        return null;
      }
    } catch {
      // 文件读取/解析失败，跳过
    }
    return null;
  }
}

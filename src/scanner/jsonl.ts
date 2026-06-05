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

const NON_MESSAGE_TYPES = new Set([
  'ai-title',
  'last-prompt',
  'queue-operation',
  'file-history-snapshot',
  'mode',
  'permission-mode',
  'agent-name',
  // 兼容旧版 cc-linker 写入的 JSONL marker
  'activity_marker',
]);

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
              // 新建 entry：RegistryManager.buildSessionEntry 默认 status='active'
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
                // 复用 parseTail 路径的逻辑：corrupted → active（文件已可读）
                // 其他 status（degraded/provisioning/active）由 Object.assign 不写即保留。
                // 详见 review finding #6。
                ...(existing?.status === 'corrupted' ? { status: 'active' } : {}),
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

  /**
   * Extract text content from a JSONL message content field.
   * Handles both `string` content and `Array<{type, text}>` content forms.
   * Returns null if the content is neither (e.g., image-only, tool_result, etc.)
   */
  private static extractTextContent(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const block = content.find((b: any) => b?.type === 'text');
      return block?.text ?? null;
    }
    return null;
  }

  /**
   * 清理 markdown 结构化噪声（standard 级别）
   *
   * 规则：
   * - 行首标题符号（##、### 等）        去掉井号（仅 `**` 双星号，不处理 `__` 下划线加粗）
   * - 双星号（**成对或孤立**）          去掉所有双星号
   * - 行内代码 + 代码块边界（反引号）   去掉所有反引号
   *
   * 保留：标题文字、代码内容、列表 -、链接 [text](url)、blockquote >
   */
  private static stripMarkdownNoise(text: string): string {
    return text
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '');
  }

  /**
   * 截断到 maxLength，按行边界回退
   *
   * 规则：
   * - 如果原文长度 ≤ maxLength，直接返回
   * - 否则按 \n 分割，找累积长度 ≤ maxLength 的最后一个行边界
   * - 截断后追加 '...'
   *
   * 例：
   * - maxLength=240，文本 250 字符无 \n → slice(0, 240) + '...'
   * - maxLength=240，文本 300 字符（10 行，每行 30）在第 9 行结束 → 截到第 9 行 + '...'
   * - 截断后保留 < 50% maxLength → 仍按字符截（不强行按行）
   */
  private static truncateByLine(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    const truncated = text.slice(0, maxLength);
    const lastNewline = truncated.lastIndexOf('\n');
    if (lastNewline > maxLength * 0.5) {
      return truncated.slice(0, lastNewline) + '...';
    }
    return truncated + '...';
  }

  /**
   * 从 assistant message 数组中提取 cleaned final-answer text
   *
   * 算法（与 JSDoc 严格对应）：
   * 1. 倒序遍历 messages
   * 2. 跳过非 assistant message
   * 3. 跳过 content 不是数组的（防御性，覆盖损坏 / 异常 JSONL 形态）
   * 4. 跳过中间态（has tool_use）
   * 5. 跳过无 text 块的（自然过滤 thinking-only / tool_use-only）
   * 6. 合并该 message 的所有 text 块（用 \n 连接）
   * 7. markdown 清理（standard 级别）
   * 8. 截断 maxLength 字符，按行边界回退
   *
   * 边界处理：
   * - 没找到符合的 → 返回 null
   * - text 块全空 → 返回 null（被 step 5 过滤）
   */
  private static cleanAssistantText(
    messages: Array<{ type: string; message?: { content?: unknown } }>,
    maxLength: number = 240,
  ): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const entry = messages[i];
      if (entry.type !== 'assistant') continue;

      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;

      const hasToolUse = content.some((b: any) => b?.type === 'tool_use');
      if (hasToolUse) continue;

      const textBlocks = content
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text);
      if (textBlocks.length === 0) continue;

      const raw = textBlocks.join('\n').trim();
      if (raw.length === 0) continue;  // 全是空白 / 空字符串 → 跳过这条，往前找
      const cleaned = JSONLScanner.stripMarkdownNoise(raw);
      const truncated = JSONLScanner.truncateByLine(cleaned, maxLength);

      return truncated;
    }
    return null;
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
          const text = JSONLScanner.extractTextContent(entry.message?.content);
          if (text && text.length > 0) firstUserMessage = text;
        }
        // 提取创建时间：取最早的时间戳（首条有 timestamp 的记录）
        if (!createdAt && entry.timestamp) createdAt = entry.timestamp;
        // Early exit: once we have core metadata, no need to keep scanning.
        // lastPrompt 故意不在 break 条件内——有些 JSONL 没有 last-prompt marker，
        // 没有它会强制遍历全部行（性能 bug，详见 review finding #2）。
        if (cwd && aiTitle && firstUserMessage && createdAt) break;
      } catch {
        // Silently skip malformed JSON lines
      }
    }

    let lastActive: string | null = null;
    let preview = '';
    let lastUserPreview = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        // 收集 last-prompt marker（必须在 NON_MESSAGE_TYPES 跳过前，否则被 continue 漏掉）。
        // 第一个 forward loop 在 ai-title + firstUserMessage + createdAt 拿到后即 break，
        // 不会到达文件末尾的 last-prompt marker；这里从尾部找避免漏掉。
        // 详见 review finding "lastPrompt regression"（第二轮 review）。
        if (entry.type === 'last-prompt' && !lastPrompt && entry.lastPrompt) {
          lastPrompt = entry.lastPrompt;
        }
        if (NON_MESSAGE_TYPES.has(entry.type)) continue;
        if ((entry.type === 'assistant' || entry.type === 'user') && !lastActive) {
          lastActive = entry.timestamp;
        }
        if (entry.type === 'assistant' && !preview) {
          const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
          if (textBlock) preview = textBlock.text.slice(0, 100);
        }
        if (entry.type === 'user' && !lastUserPreview) {
          const text = JSONLScanner.extractTextContent(entry.message?.content);
          if (text) lastUserPreview = text.slice(0, 100);
        }
        // 三个字段都拿到就 break 提升性能
        if (lastActive && preview && lastUserPreview) break;
      } catch {
        // Silently skip malformed JSON lines
      }
    }

    // 自建方案下，JSONLScanner 扫描的均为 CLI 会话
    const origin: Origin = 'cli';

    // 标题优先级：ai-title > last-prompt > 第一条用户消息 > Untitled
    // 所有来源统一截断到 50 字符（保留 '...' 3 字符），防止 aiTitle 超长撑爆 Feishu 卡片 4KB 限制。
    // 详见 review finding "title 截断"（第三轮 review BUG-1）。
    const truncateTitle = (s: string): string =>
      s.length > 50 ? s.slice(0, 50) + '...' : s;
    const title = aiTitle
      ? truncateTitle(aiTitle)
      : lastPrompt
        ? truncateTitle(lastPrompt)
        : firstUserMessage
          ? truncateTitle(firstUserMessage)
          : `Untitled (${sessionId.slice(0, 8)})`;

    // project_dir: 从 jsonl_path 提取 Claude Code project 目录名
    const jsonlPath = filePath;
    const projectDirMatch = jsonlPath.match(/\/([^/]+)\/[^/]+\.jsonl$/);
    const project_dir = projectDirMatch ? projectDirMatch[1] : null;

    const messageLines = lines.filter(line => {
      try {
        const entry = JSON.parse(line);
        return !NON_MESSAGE_TYPES.has(entry.type);
      } catch {
        return true; // 解析失败保留（兼容旧数据）
      }
    });

    return {
      origin,
      cwd: cwd ?? (process.env.HOME ?? homedir()),
      project_name: this.inferProjectName(cwd ?? (process.env.HOME ?? homedir())),
      project_dir,
      title,
      message_count: messageLines.length,
      created_at: createdAt ?? new Date().toISOString(),
      last_active: lastActive ?? new Date().toISOString(),
      // 三字段并存：last_message_preview 保留 100 字符（向后兼容 CLI/bot 多处复用）
      last_message_preview: preview || lastPrompt?.slice(0, 100) || '[无内容]',
      // 新增 80 字符版（bot overview 卡片用）
      last_assistant_preview: preview ? preview.slice(0, 80) : undefined,
      last_user_preview: lastUserPreview ? lastUserPreview.slice(0, 80) : undefined,
      // 注意：parseFull 不再硬编码 status: 'active'。由调用方根据 existing.status 决定
      // 保留（degraded/provisioning）或重置（corrupted → active）。详见 review finding #6。
    };
  }

  private parseTail(filePath: string): Partial<SessionEntry> {
    const stat = statSync(filePath);

    // 读取文件末尾最多 4KB 用于提取 last_active 和 preview
    const readSize = Math.min(4096, stat.size);
    const fd = openSync(filePath, 'r');
    let lastActive: string | null = null;
    let preview = '';
    let lastUserPreview = '';  // 新增：必须在函数顶部声明，让 if/else 两个分支都能访问
    let lastPrompt = '';  // 与 parseFull 一致：3-tier fallback 需要 lastPrompt
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
            // 收集 last-prompt marker（在 NON_MESSAGE_TYPES 跳过前），从尾部找避免漏掉
            if (entry.type === 'last-prompt' && !lastPrompt && entry.lastPrompt) {
              lastPrompt = entry.lastPrompt;
            }
            if (NON_MESSAGE_TYPES.has(entry.type)) continue;
            if (entry.type === 'assistant' || entry.type === 'user') {
              if (!lastActive) lastActive = entry.timestamp;
            }
            if (entry.type === 'assistant' && !preview) {
              const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
              if (textBlock) preview = textBlock.text.slice(0, 100);
            }
            if (entry.type === 'user' && !lastUserPreview) {
              const text = JSONLScanner.extractTextContent(entry.message?.content);
              if (text) lastUserPreview = text.slice(0, 100);
            }
          } catch {}
        }

        // 4KB 内找不到 user preview 时全量重读（fallback）
        if (!lastUserPreview && stat.size > 4096) {
          try {
            const fullContent = readFileSync(filePath, 'utf8');
            const allLines = fullContent.split('\n').filter(Boolean);
            for (let i = allLines.length - 1; i >= 0; i--) {
              try {
                const entry = JSON.parse(allLines[i]);
                if (entry.type === 'user') {
                  const text = JSONLScanner.extractTextContent(entry.message?.content);
                  if (text) {
                    lastUserPreview = text.slice(0, 100);
                    break;
                  }
                }
                // 全量 fallback 时也顺便收集 lastPrompt（如果 4KB 内没拿到）
                if (entry.type === 'last-prompt' && !lastPrompt && entry.lastPrompt) {
                  lastPrompt = entry.lastPrompt;
                }
              } catch {}
            }
          } catch (err) {
            logger.warn(`parseTail 全量 fallback 失败: ${filePath}: ${err}`);
          }
        }

        // 行数估算：总大小 / 平均行长度(用尾部估算)
        // 对于只需要更新活跃信息的场景，不需要精确行数
        lineCount = 0; // 不可精确获取，保留原值
      } else {
        // 小文件：直接读全部
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        lineCount = lines.length;

        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]);
            // 收集 last-prompt marker（在 NON_MESSAGE_TYPES 跳过前），从尾部找
            if (entry.type === 'last-prompt' && !lastPrompt && entry.lastPrompt) {
              lastPrompt = entry.lastPrompt;
            }
            if (NON_MESSAGE_TYPES.has(entry.type)) continue;
            if (entry.type === 'assistant' || entry.type === 'user') {
              if (!lastActive) lastActive = entry.timestamp;
            }
            if (entry.type === 'assistant' && !preview) {
              const textBlock = entry.message?.content?.find((b: any) => b.type === 'text');
              if (textBlock) preview = textBlock.text.slice(0, 100);
            }
            if (entry.type === 'user' && !lastUserPreview) {
              const text = JSONLScanner.extractTextContent(entry.message?.content);
              if (text) lastUserPreview = text.slice(0, 100);
            }
            // 三个字段都拿到就 break（小文件无 4KB fallback 但仍可早退）
            if (lastActive && preview && lastUserPreview) break;
          } catch {}
        }
      }

      // 3-tier fallback 与 parseFull 一致：preview || lastPrompt || '[无内容]'
      // 详见 review finding "parseFull/parseTail 3-tier fallback inconsistency"（第二轮 review）。
      const lastMessagePreview = preview || lastPrompt?.slice(0, 100) || '[无内容]';

      return {
        ...(lineCount > 0 ? { message_count: lineCount } : {}),
        ...(lastActive ? { last_active: lastActive } : {}),
        // 保留 100 字符（向后兼容 CLI/bot 多处复用）
        ...(lastMessagePreview ? { last_message_preview: lastMessagePreview } : {}),
        // 新增 80 字符版（bot overview 卡片用）—— 与 parseFull 行为对齐
        ...(preview ? { last_assistant_preview: preview.slice(0, 80) } : {}),
        ...(lastUserPreview ? { last_user_preview: lastUserPreview.slice(0, 80) } : {}),
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

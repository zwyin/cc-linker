import { readFileSync, writeFileSync } from 'fs';

interface JsonlEntry {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  sessionId?: string;
  isMeta?: boolean;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  [key: string]: any;
}

function extractTextFromEntry(entry: JsonlEntry): string {
  if (!entry.message) return '';
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b: any) => b.type === 'text');
    return textBlock?.text || '';
  }
  return '';
}

export function isCommandOutput(text: string): boolean {
  return text.includes('<local-command-stdout>') ||
    text.includes('<command-name>') ||
    text.includes('<local-command-caveat>');
}

/**
 * Repair JSONL last-prompt to point to the latest user message and its assistant reply.
 *
 * Problem: When Feishu sends messages via `claude -p --resume`, the messages are written
 * to JSONL correctly. But when the user later resumes the session interactively via
 * `claude --resume`, the CLI process overwrites the `last-prompt` metadata, causing
 * the parentUuid chain to skip the Feishu branch. This makes Feishu messages invisible
 * in the interactive session.
 *
 * Fix: Scan the JSONL, find the latest user message and its reply, and ensure
 * `last-prompt` points to the correct leafUuid. Remove stale `last-prompt` entries.
 */
export function repairJsonlLastPrompt(jsonlPath: string): boolean {
  let content: string;
  try {
    content = readFileSync(jsonlPath, 'utf8');
  } catch {
    return false;
  }

  const lines = content.split('\n');
  const entries: (JsonlEntry | null)[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      entries.push(null);
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push(null);
    }
  }

  // Find all non-meta user messages with timestamps
  const userMessages: Array<{ entry: JsonlEntry; index: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.type === 'user' && !entry.isMeta && entry.timestamp && entry.uuid) {
      const text = extractTextFromEntry(entry);
      // Skip command outputs and meta messages from CLI
      if (isCommandOutput(text)) continue;
      userMessages.push({ entry, index: i });
    }
  }

  if (userMessages.length === 0) return false;

  // Prefer sdk-cli (Feishu) messages; fallback to cli messages
  const sdkCliUsers = userMessages.filter((u) => u.entry.entrypoint === 'sdk-cli');
  const cliUsers = userMessages.filter(
    (u) => u.entry.entrypoint === 'cli' || !u.entry.entrypoint
  );
  let candidateUsers = sdkCliUsers.length > 0 ? sdkCliUsers : cliUsers;
  if (candidateUsers.length === 0) {
    candidateUsers = userMessages;
  }

  // Sort by timestamp, find the latest user message
  candidateUsers.sort((a, b) => a.entry.timestamp!.localeCompare(b.entry.timestamp!));
  const latestUser = candidateUsers[candidateUsers.length - 1];

  // Find assistant reply: prefer sdk-cli (Feishu), fallback to cli
  let leafUuid = latestUser.entry.uuid!;
  let lastPromptText = extractTextFromEntry(latestUser.entry);

  const assistantMessages: Array<{ entry: JsonlEntry; index: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.type === 'assistant' && entry.timestamp && entry.uuid) {
      assistantMessages.push({ entry, index: i });
    }
  }

  const sdkCliAssistants = assistantMessages.filter(
    (a) => a.entry.entrypoint === 'sdk-cli'
  );
  const cliAssistants = assistantMessages.filter(
    (a) => a.entry.entrypoint === 'cli' || !a.entry.entrypoint
  );

  const candidateAssistants = sdkCliAssistants.length > 0 ? sdkCliAssistants : cliAssistants;

  if (candidateAssistants.length > 0) {
    candidateAssistants.sort((a, b) => a.entry.timestamp!.localeCompare(b.entry.timestamp!));
    const latestAssistant = candidateAssistants[candidateAssistants.length - 1];
    leafUuid = latestAssistant.entry.uuid!;
    const assistantText = extractTextFromEntry(latestAssistant.entry);
    if (assistantText) lastPromptText = assistantText;
  }

  // Find all last-prompt entries
  const lastPromptIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry && entry.type === 'last-prompt') {
      lastPromptIndices.push(i);
    }
  }

  // Check if already correct
  if (lastPromptIndices.length > 0) {
    const lastLastPrompt = entries[lastPromptIndices[lastPromptIndices.length - 1]];
    if (lastLastPrompt?.leafUuid === leafUuid) {
      return false;
    }
  }

  // Build new content: keep all non-last-prompt lines
  const newLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lastPromptIndices.includes(i) && lines[i].trim()) {
      newLines.push(lines[i]);
    }
  }

  const sessionId = latestUser.entry.sessionId || '';
  const newLastPrompt = {
    type: 'last-prompt',
    lastPrompt: lastPromptText.slice(0, 200),
    leafUuid,
    sessionId,
  };

  newLines.push(JSON.stringify(newLastPrompt));
  writeFileSync(jsonlPath, newLines.join('\n') + '\n');
  return true;
}

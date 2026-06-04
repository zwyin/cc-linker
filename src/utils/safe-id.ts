/**
 * 安全标识符白名单：用于 messageId / openId / sessionUuid 等所有拼入
 * SpoolQueue 文件名（pending/ / processing/ / receipts/）的字段。
 *
 * 设计要点：
 * - 字符集 [a-zA-Z0-9_-]：排除 : / \ . 空格等所有路径分隔符和 shell 特殊字符
 * - 长度上限 80：保证 `cmd:${openId}:${messageId}:${messageId}.json` 即
 *   4 + 80 + 1 + 80 + 1 + 80 + 5 = 251 ≤ NAME_MAX 255（macOS/HFS+/ext4）
 *   writeAtomic 期间 .tmp 后缀再加 4 仍在 255 边界内
 * - 旧 SESSION_UUID_REGEX 用 {1,128} 会在 cmd: 边界产生 395 字符文件名 → ENAMETOOLONG
 * - 实际 Feishu messageId / openId / Claude sessionUuid 都 < 50 字符，80 是安全冗余
 */

export const MAX_SAFE_ID_LEN = 80;

export const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,80}$/;

export function isSafeId(s: string): boolean {
  return SAFE_ID_REGEX.test(s);
}

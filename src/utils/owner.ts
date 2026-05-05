/**
 * 把 cc-connect user_key 压缩成对用户友好的 owner 展示值。
 * 格式: "feishu:oc_xxx:ou_yyy" → "feishu:ou_yyy"
 *      "feishu:ou_yyy" → "feishu:ou_yyy"（已经是短格式）
 *      其他 → 原样返回
 *
 * 被 cc-connect scanner 和 feishu-cmd 共用。
 */
export function normalizeOwner(userKey: string): string {
  const parts = userKey.split(':');
  return parts.length >= 3 ? `${parts[0]}:${parts[parts.length - 1]}` : userKey;
}
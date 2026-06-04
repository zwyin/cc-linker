/**
 * 用户可见的回复消息常量。
 *
 * 单点定义 + 测试 import，避免消息字面量在 source 和 test 间漂移
 * （CR3 #9 修复：原 '服务暂不可用，请稍后重试' 在 source 1 处 + test 8 处，
 *  source 改文案测试用相同新字面量还是 pass，失去 oracle 防御语义）
 */

/**
 * 当无法给用户精确诊断时使用的通用回复：
 * - validation 失败（messageId/openId 不符合 isSafeId）— oracle 防御
 * - 未来若 enqueue false 路径用户也用此消息（避免暴露内部失败原因如 EACCES/ENOSPC）
 *
 * 与 '该 Bot 为个人私有实例' / '消息处理队列已满' 等专用消息共存。
 * '私有实例' 是功能告知（合法）；'队列已满' 是操作状态（不泄露配置）。
 * '服务暂不可用' 是 fallback（不透露原因）。
 */
export const SERVICE_UNAVAILABLE_REPLY = '服务暂不可用，请稍后重试';

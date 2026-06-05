import { z } from 'zod';

export const OriginSchema = z.enum(['cli', 'feishu']);
export type Origin = z.infer<typeof OriginSchema>;

export const StatusSchema = z.enum(['provisioning', 'active', 'archived', 'degraded', 'corrupted']);
export type Status = z.infer<typeof StatusSchema>;

export const SessionEntrySchema = z.object({
  origin: OriginSchema,

  cwd: z.string(),
  project_name: z.string().nullable(),
  jsonl_path: z.string().nullable(),
  project_dir: z.string().nullable(),

  pending_jsonl_resolve: z.boolean().optional(),
  last_error: z.string().nullable().optional(),

  feishu_session_id: z.string().nullable().optional(),
  feishu_user_id: z.string().nullable().optional(),

  created_at: z.string(),
  last_active: z.string(),

  title: z.string().nullable(),
  message_count: z.number(),
  last_message_preview: z.string(),                    // 100 字符 raw markdown（CLI / bot 多处复用，保留向后兼容）
  last_user_preview: z.string().max(80).optional(),     // 80 字符 raw user prompt（向后兼容）
  last_assistant_preview: z.string().max(80).optional(),// 240 字符 cleaned（去 ##/**/`/``` 后，bot 概览卡片专用）
  status: StatusSchema.optional(),
  lastKnownProvider: z.string().nullable().optional(), // Display-only: what model was used when session was created
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;

export const RegistrySchema = z.object({
  version: z.literal(4),
  updated_at: z.string(),
  sessions: z.record(z.string(), SessionEntrySchema),
});
export type Registry = z.infer<typeof RegistrySchema>;

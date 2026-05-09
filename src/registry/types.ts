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
  last_message_preview: z.string(),
  status: StatusSchema.optional(),
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;

export const RegistrySchema = z.object({
  version: z.literal(2),
  updated_at: z.string(),
  sessions: z.record(z.string(), SessionEntrySchema),
});
export type Registry = z.infer<typeof RegistrySchema>;

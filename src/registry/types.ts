import { z } from 'zod';

export const OriginSchema = z.enum(['cli', 'cc-connect']);
export type Origin = z.infer<typeof OriginSchema>;

export const StatusSchema = z.enum(['active', 'archived', 'corrupted']);
export type Status = z.infer<typeof StatusSchema>;

export const VisibilitySchema = z.enum(['private', 'team', 'public']);
export type Visibility = z.infer<typeof VisibilitySchema>;

export const SessionEntrySchema = z.object({
  origin: OriginSchema,
  source: z.string(),
  platform: z.string().nullable(),
  owner: z.string().nullable(),
  owner_user_key: z.string().nullable(),

  cwd: z.string(),
  project_name: z.string().nullable(),
  jsonl_path: z.string(),
  project_dir: z.string().nullable(),

  cc_connect_session_id: z.string().nullable(),
  cc_connect_session_file: z.string().nullable(),

  created_at: z.string(),
  last_active: z.string(),

  title: z.string().nullable(),
  message_count: z.number(),
  last_message_preview: z.string(),
  status: StatusSchema,

  visibility: VisibilitySchema.optional(),
  shared_with: z.array(z.string()).optional(),
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;

export const RegistrySchema = z.object({
  version: z.literal(1),
  updated_at: z.string(),
  sessions: z.record(z.string(), SessionEntrySchema),
});
export type Registry = z.infer<typeof RegistrySchema>;

export const CCConnectSessionSchema = z.object({
  sessions: z.record(z.string(), z.object({
    id: z.string(),
    name: z.string(),
    agent_session_id: z.string().optional(),
    agent_type: z.string().optional(),
    history: z.array(z.object({
      role: z.string(),
      content: z.string(),
      timestamp: z.string(),
    })).nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })),
  active_session: z.record(z.string(), z.string()),
  user_sessions: z.record(z.string(), z.array(z.string())),
  counter: z.number(),
  user_meta: z.record(z.string(), z.object({
    user_name: z.string(),
    chat_name: z.string(),
  })).optional(),
});
export type CCConnectSession = z.infer<typeof CCConnectSessionSchema>;

import { z } from 'zod';
import { BuilderRoleSchema, BuilderSessionStatusSchema, InputModeSchema } from '../enums';
import { AgentIdSchema, BuilderMessageIdSchema, BuilderSessionIdSchema, BusinessIdSchema } from '../ids';
import { IsoDateTimeSchema } from '../primitives';
import { DraftAgentSpecSchema } from './agents';

export const BuilderMessageSchema = z.object({
  id: BuilderMessageIdSchema,
  sessionId: BuilderSessionIdSchema,
  role: BuilderRoleSchema,
  inputMode: InputModeSchema,
  text: z.string(),
  specPatch: DraftAgentSpecSchema.optional(),
  evidenceRefs: z.array(z.string()).optional(), // fact_ or file_ ids
  createdAt: IsoDateTimeSchema,
});
export type BuilderMessage = z.infer<typeof BuilderMessageSchema>;

export const BuilderProgressSchema = z.object({ answered: z.int().min(0), required: z.int().min(0) });
export type BuilderProgress = z.infer<typeof BuilderProgressSchema>;

export const BuilderSessionSchema = z.object({
  id: BuilderSessionIdSchema,
  businessId: BusinessIdSchema,
  status: BuilderSessionStatusSchema,
  messages: z.array(BuilderMessageSchema),
  draftSpec: DraftAgentSpecSchema,
  missingFields: z.array(z.string()),
  progress: BuilderProgressSchema, // API 3.3
  agentId: AgentIdSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type BuilderSession = z.infer<typeof BuilderSessionSchema>;

/** Response of POST /api/realtime/client-secret. The secret is never stored. */
export const RealtimeClientSecretSchema = z.object({
  clientSecret: z.string().min(1),
  expiresAt: IsoDateTimeSchema,
  model: z.literal('gpt-realtime-2.1'),
  builderSessionId: BuilderSessionIdSchema,
});
export type RealtimeClientSecret = z.infer<typeof RealtimeClientSecretSchema>;

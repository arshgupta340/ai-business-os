import { z } from 'zod';
import {
  AgentStatusSchema,
  AgentTemplateSchema,
  CallChannelSchema,
  CallEndReasonSchema,
  CallStageSchema,
  CallStatusSchema,
  CapabilityIdSchema,
  GuardrailRuleSchema,
  KnowledgeScopeSchema,
  ToolNameSchema,
} from '../enums';
import { AgentIdSchema, AgentVersionIdSchema, BusinessIdSchema, CallIdSchema, FactIdSchema, TestSessionIdSchema, UserIdSchema } from '../ids';
import { E164Schema, IsoDateTimeSchema, Last4Schema, msBetween } from '../primitives';

export const AgentSpecSchema = z.object({
  id: AgentIdSchema,
  businessId: BusinessIdSchema,
  version: z.int().min(1), // matches agent_versions.version
  template: AgentTemplateSchema,
  name: z.string().min(1),
  channel: z.literal('phone'),
  goal: z.string(), // one sentence, shown in preview
  knowledgeScopes: z.array(KnowledgeScopeSchema),
  capabilities: z.array(CapabilityIdSchema), // tools (read, propose) plus the executor bundle (write, external_message)
  writePolicy: z.literal('owner_approval_each_action_bundle'),
  escalation: z.literal('explain_unsupported_or_offer_callback'),
  status: AgentStatusSchema,
  guardrailVersion: z.literal('v1'),
  greeting: z.string().optional(), // must disclose it is an AI assistant
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/** `Partial<AgentSpec>`: the builder's draft. */
export const DraftAgentSpecSchema = AgentSpecSchema.partial();
export type DraftAgentSpec = z.infer<typeof DraftAgentSpecSchema>;

export const KnowledgeSnapshotRefSchema = z.object({
  facts: z.array(z.object({ id: FactIdSchema, version: z.int().min(1) })),
  catalogSyncedAt: IsoDateTimeSchema.optional(), // absent for agents without a catalog
});
export type KnowledgeSnapshotRef = z.infer<typeof KnowledgeSnapshotRefSchema>;

/** API 3.4: immutable once published. */
export const AgentVersionSchema = z.object({
  id: AgentVersionIdSchema,
  agentId: AgentIdSchema,
  version: z.int().min(1),
  spec: AgentSpecSchema,
  knowledgeSnapshotRef: KnowledgeSnapshotRefSchema,
  createdBy: UserIdSchema.optional(), // agent_versions.created_by is nullable
  publishedAt: IsoDateTimeSchema,
});
export type AgentVersion = z.infer<typeof AgentVersionSchema>;

/** API 3.4 agent summary. `state` is the agent status. */
export const AgentSchema = z.object({
  id: AgentIdSchema,
  businessId: BusinessIdSchema,
  name: z.string(),
  template: AgentTemplateSchema,
  state: AgentStatusSchema,
  activeVersionId: AgentVersionIdSchema.optional(), // always present when live or paused
  activeVersion: AgentVersionSchema.optional(),
  draftSpec: DraftAgentSpecSchema,
  isLiveAgent: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Agent = z.infer<typeof AgentSchema>;

export const CallBaseSchema = z.object({
  id: CallIdSchema,
  businessId: BusinessIdSchema,
  agentId: AgentIdSchema,
  agentVersionId: AgentVersionIdSchema,
  channel: CallChannelSchema, // sim-call uses test_console and is labelled "simulated call"
  stage: CallStageSchema,
  providerCallId: z.string().optional(), // Twilio CallSid; absent for test_console
  callerLast4: Last4Schema.optional(),
  status: CallStatusSchema,
  endReason: CallEndReasonSchema.optional(),
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.optional(),
});

const END_REASON_FOR_STATUS = { COMPLETED: 'completed', DROPPED: 'dropped', FAILED: 'failed' } as const;

export const CallSchema = CallBaseSchema.superRefine((c, ctx) => {
  // DATA-MODEL 2.13 checks.
  if ((c.channel === 'phone') !== (c.providerCallId !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['providerCallId'], message: 'providerCallId is present exactly for phone calls' });
  }
  if ((c.status === 'IN_PROGRESS') !== (c.endedAt === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['endedAt'], message: 'endedAt is absent exactly while IN_PROGRESS' });
  }
  if (c.endedAt !== undefined && msBetween(c.startedAt, c.endedAt) < 0) {
    ctx.addIssue({ code: 'custom', path: ['endedAt'], message: 'endedAt must not be before startedAt' });
  }
  // CONTRACTS 6: COMPLETED/completed, DROPPED/dropped, FAILED/failed.
  if (c.endReason !== undefined && (c.status === 'IN_PROGRESS' || END_REASON_FOR_STATUS[c.status] !== c.endReason)) {
    ctx.addIssue({ code: 'custom', path: ['endReason'], message: `endReason ${c.endReason} does not match status ${c.status}` });
  }
});
export type Call = z.infer<typeof CallSchema>;

/**
 * SPEC 2.9 shape. `agentId` and `agentVersionId` are absent when nothing answers the number
 * (UI review, issue #56). `phoneNumber` and `businessId` are always present.
 */
export const LiveAgentSchema = z.object({
  phoneNumber: E164Schema,
  businessId: BusinessIdSchema,
  agentId: AgentIdSchema.optional(),
  agentVersionId: AgentVersionIdSchema.optional(),
  updatedAt: IsoDateTimeSchema,
});
export type LiveAgent = z.infer<typeof LiveAgentSchema>;

// ---- Agent run modes (P-18) ----
export const ToolTraceEntrySchema = z.object({
  tool: ToolNameSchema,
  capabilityId: CapabilityIdSchema,
  effect: z.enum(['read', 'propose']), // a deployed agent never runs write or external_message
  input: z.unknown(),
  output: z.unknown(),
  mocked: z.boolean(),
  durationMs: z.number().min(0),
});
export type ToolTraceEntry = z.infer<typeof ToolTraceEntrySchema>;

export const AgentRunRequestSchema = z.object({
  testSessionId: TestSessionIdSchema.optional(), // test mode, later turns
  callId: CallIdSchema.optional(), // sim-call mode, later turns
  message: z.string().min(1),
  end: z.boolean().optional(),
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

export const GuardrailRefusalSchema = z.object({ refused: z.literal(true), rule: GuardrailRuleSchema });
export type GuardrailRefusal = z.infer<typeof GuardrailRefusalSchema>;

export const AgentRunResponseSchema = z.object({
  testSessionId: TestSessionIdSchema.optional(),
  callId: CallIdSchema.optional(),
  reply: z.string(),
  toolTrace: z.array(ToolTraceEntrySchema),
  guardrail: GuardrailRefusalSchema.optional(),
});
export type AgentRunResponse = z.infer<typeof AgentRunResponseSchema>;

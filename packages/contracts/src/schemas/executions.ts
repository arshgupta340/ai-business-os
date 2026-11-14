import { z } from 'zod';
import { CapabilityIdSchema, ExecutionActionTypeSchema, ExecutionStatusSchema, MessageChannelSchema, MessageDispatchStatusSchema, MessageTemplateSchema } from '../enums';
import { ErrorCodeSchema } from '../errors';
import { ApprovalIdSchema, BusinessIdSchema, ExecutionIdSchema, MessageDispatchIdSchema } from '../ids';
import { E164Schema, IdempotencyKeySchema, IsoDateTimeSchema } from '../primitives';
import { ACTION_TYPE_CAPABILITY } from '../bundles';

export const ActionExecutionBaseSchema = z.object({
  id: ExecutionIdSchema,
  businessId: BusinessIdSchema,
  approvalId: ApprovalIdSchema,
  actionType: ExecutionActionTypeSchema, // SPEC 2.9: Sheets steps have no execution row
  stepIndex: z.int().min(0), // position in actionBundle
  capabilityId: CapabilityIdSchema.optional(), // absent for local.* steps
  idempotencyKey: IdempotencyKeySchema, // computed once at insert, never regenerated
  status: ExecutionStatusSchema,
  attempts: z.int().min(0).max(3), // SPEC 2.9: at most 3 attempts per step
  externalRef: z.string().optional(),
  errorCode: ErrorCodeSchema.optional(),
  lastError: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

// SPEC 2.3 mapping: capabilityId is the action type's capability, absent for local.* steps.
export const ActionExecutionSchema = ActionExecutionBaseSchema.refine(
  (e) => (e.capabilityId ?? null) === ACTION_TYPE_CAPABILITY[e.actionType],
  { path: ['capabilityId'], message: 'capabilityId must match the action type (SPEC 2.3), absent for local steps' },
);
export type ActionExecution = z.infer<typeof ActionExecutionSchema>;

export const MessageDispatchBaseSchema = z.object({
  id: MessageDispatchIdSchema,
  businessId: BusinessIdSchema,
  executionId: ExecutionIdSchema,
  subjectId: z.string().min(1), // ord_ or bkg_
  channel: MessageChannelSchema, // never qr_only: no row exists under qr_only
  recipient: E164Schema, // stored in full, never in events
  template: MessageTemplateSchema,
  status: MessageDispatchStatusSchema,
  providerMessageId: z.string().optional(),
  idempotencyKey: IdempotencyKeySchema,
  errorCode: ErrorCodeSchema.optional(),
  sentAt: IsoDateTimeSchema.optional(),
  deliveredAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

// DATA-MODEL 2.18 check: nothing is SENT or DELIVERED without the provider's message id (AGENTS rule 5).
// Only `whatsapp_sandbox` and `agentphone` (D-12, a polled delivery status) can reach `DELIVERED`.
// `SENT` is the last state for every other channel.
// deliveredAt goes with DELIVERED only.
export const MessageDispatchSchema = MessageDispatchBaseSchema.refine(
  (m) => !(m.status === 'SENT' || m.status === 'DELIVERED') || m.providerMessageId !== undefined,
  { path: ['providerMessageId'], message: 'SENT and DELIVERED need providerMessageId' },
)
  .refine((m) => m.status !== 'DELIVERED' || m.channel === 'whatsapp_sandbox' || m.channel === 'agentphone', {
    path: ['status'],
    message: 'Only whatsapp_sandbox and agentphone can reach DELIVERED; SENT is the last state for every other channel',
  })
  .refine((m) => (m.deliveredAt !== undefined) === (m.status === 'DELIVERED'), {
    path: ['deliveredAt'],
    message: 'deliveredAt is present exactly when status is DELIVERED',
  });
export type MessageDispatch = z.infer<typeof MessageDispatchSchema>;

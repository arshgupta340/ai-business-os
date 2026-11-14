import { z } from 'zod';
import { CapabilityIdSchema, ExecutionActionTypeSchema, ExecutionStatusSchema, MessageChannelSchema, MessageDispatchStatusSchema, MessageTemplateSchema } from '../enums';
import { ErrorCodeSchema } from '../errors';
import { ApprovalIdSchema, BusinessIdSchema, ExecutionIdSchema, MessageDispatchIdSchema } from '../ids';
import { E164Schema, IdempotencyKeySchema, IsoDateTimeSchema } from '../primitives';

export const ActionExecutionSchema = z.object({
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
export type ActionExecution = z.infer<typeof ActionExecutionSchema>;

export const MessageDispatchSchema = z.object({
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
export type MessageDispatch = z.infer<typeof MessageDispatchSchema>;

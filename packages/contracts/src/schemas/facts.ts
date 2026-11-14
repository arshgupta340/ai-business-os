import { z } from 'zod';
import { FactKindSchema, FactConflictStateSchema, FactSourceTypeSchema, FactStatusSchema } from '../enums';
import { BusinessIdSchema, FactConflictIdSchema, FactIdSchema, FileIdSchema, ServiceIdSchema, UserIdSchema } from '../ids';
import { CurrencySchema, IsoDateTimeSchema, JsonValueSchema, LocalTimeSchema, MinorAmountSchema } from '../primitives';

/** Value of an `hours` fact (key `mon`..`sun`), in local time. */
export const HoursValueSchema = z.union([
  z.object({ open: LocalTimeSchema, close: LocalTimeSchema }),
  z.object({ closed: z.literal(true) }),
]);
export type HoursValue = z.infer<typeof HoursValueSchema>;

/** Value of a `service` fact (key is the `svc_` id). */
export const ServiceOfferingSchema = z.object({
  id: ServiceIdSchema,
  businessId: BusinessIdSchema,
  name: z.string(),
  durationMinutes: z.int().min(1),
  priceMinor: MinorAmountSchema,
  currency: CurrencySchema,
  bufferMinutes: z.int().min(0).optional(),
});
export type ServiceOffering = z.infer<typeof ServiceOfferingSchema>;

export const BusinessFactBaseSchema = z.object({
  id: FactIdSchema,
  businessId: BusinessIdSchema,
  kind: FactKindSchema,
  key: z.string().min(1),
  value: JsonValueSchema,
  sourceType: FactSourceTypeSchema,
  sourceRef: z.string().optional(),
  fileId: FileIdSchema.optional(), // set when sourceType is "upload"
  status: FactStatusSchema, // SPEC 2.9: at most one verified per business, kind and key
  confidence: z.number().min(0).max(1),
  version: z.int().min(1),
  supersedesId: FactIdSchema.optional(),
  verifiedAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

// DATA-MODEL 2.6 check: verifiedAt is absent exactly while the fact is a draft.
export const BusinessFactSchema = BusinessFactBaseSchema.refine((f) => (f.status === 'draft') === (f.verifiedAt === undefined), {
  path: ['verifiedAt'],
  message: 'verifiedAt must be absent for a draft and present otherwise',
});
export type BusinessFact = z.infer<typeof BusinessFactSchema>;

export const FactConflictCandidateSchema = z.object({
  factId: FactIdSchema.optional(),
  sourceType: FactSourceTypeSchema,
  sourceRef: z.string().optional(), // the cat_ id when the authority is Square
  value: JsonValueSchema,
});
export type FactConflictCandidate = z.infer<typeof FactConflictCandidateSchema>;

export const FactConflictBaseSchema = z.object({
  id: FactConflictIdSchema,
  businessId: BusinessIdSchema,
  kind: FactKindSchema,
  key: z.string().min(1),
  required: z.boolean(), // an open required conflict blocks publish (CONFLICT_UNRESOLVED)
  candidates: z.array(FactConflictCandidateSchema).min(2),
  state: FactConflictStateSchema,
  resolvedFactId: FactIdSchema.optional(),
  resolvedBy: UserIdSchema.optional(),
  resolvedAt: IsoDateTimeSchema.optional(),
  createdAt: IsoDateTimeSchema,
});

// DATA-MODEL 2.8 check: resolvedAt and resolvedBy are present exactly when resolved.
export const FactConflictSchema = FactConflictBaseSchema.refine(
  (c) => (c.state === 'resolved') === (c.resolvedAt !== undefined && c.resolvedBy !== undefined),
  { path: ['state'], message: 'a resolved conflict needs resolvedAt and resolvedBy; an open one has neither' },
);
export type FactConflict = z.infer<typeof FactConflictSchema>;

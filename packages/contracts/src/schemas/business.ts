import { z } from 'zod';
import { ExtractionStateSchema, FileMimeSchema, IntegrationStateSchema, MessageChannelSettingSchema } from '../enums';
import { BusinessIdSchema, FactConflictIdSchema, FactIdSchema, FileIdSchema } from '../ids';
import { E164Schema, IsoDateTimeSchema, Sha256HashSchema, TimezoneSchema } from '../primitives';
import { UPLOAD_MAX_BYTES } from '../constants';

/** `contact.address` is the business location of PRD P0 item 1 (UI review, issue #56). */
export const BusinessContactSchema = z.object({
  phone: E164Schema.optional(),
  email: z.email().optional(),
  address: z.string().optional(),
});
export type BusinessContact = z.infer<typeof BusinessContactSchema>;

/** Item of GET /api/businesses (selector). */
export const BusinessSummarySchema = z.object({
  id: BusinessIdSchema,
  name: z.string(),
  category: z.string(), // "restaurant" or "barbershop" in the seed; not a closed list
  timezone: TimezoneSchema,
});
export type BusinessSummary = z.infer<typeof BusinessSummarySchema>;

/** GET /api/businesses/:id. */
export const BusinessSchema = BusinessSummarySchema.extend({
  contact: BusinessContactSchema,
  settings: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Business = z.infer<typeof BusinessSchema>;

export const FileRecordSchema = z.object({
  id: FileIdSchema,
  businessId: BusinessIdSchema,
  name: z.string().min(1), // the original file name
  mime: FileMimeSchema,
  sizeBytes: z.int().min(1).max(UPLOAD_MAX_BYTES), // SPEC 2.9: 10 MB cap
  sha256: Sha256HashSchema, // DATA-MODEL files.sha256 check: sha256: plus 64 hex
  extractionState: ExtractionStateSchema,
  draftFactIds: z.array(FactIdSchema).optional(),
  conflictIds: z.array(FactConflictIdSchema).optional(),
  createdAt: IsoDateTimeSchema,
});
export type FileRecord = z.infer<typeof FileRecordSchema>;

export const IntegrationHealthEntrySchema = z.object({
  state: IntegrationStateSchema,
  lastCheckedAt: IsoDateTimeSchema,
  environment: z.literal('sandbox').optional(), // always present for square (AC-19)
  channel: MessageChannelSettingSchema.optional(), // message_channel only
  detail: z.string().optional(),
});
export type IntegrationHealthEntry = z.infer<typeof IntegrationHealthEntrySchema>;

/** One entry per SPEC 2.9 provider key. */
export const IntegrationHealthSchema = z.object({
  square: IntegrationHealthEntrySchema.extend({ environment: z.literal('sandbox') }),
  twilio: IntegrationHealthEntrySchema,
  openai: IntegrationHealthEntrySchema,
  google_calendar: IntegrationHealthEntrySchema,
  google_sheets: IntegrationHealthEntrySchema,
  message_channel: IntegrationHealthEntrySchema,
});
export type IntegrationHealth = z.infer<typeof IntegrationHealthSchema>;

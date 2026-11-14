import { z } from 'zod';
import { BusinessIdSchema, SyncJobIdSchema } from '../ids';
import { SyncJobStateSchema } from '../enums';
import { IsoDateTimeSchema } from '../primitives';

/** The sync_jobs row, with nullable database columns omitted in JSON. */
export const SyncJobSchema = z.object({
  id: SyncJobIdSchema,
  businessId: BusinessIdSchema,
  target: z.literal('google_sheets'),
  recordType: z.enum(['order', 'booking']),
  recordId: z.string().min(1),
  state: SyncJobStateSchema,
  attempts: z.int().min(0).max(5),
  nextRetryAt: IsoDateTimeSchema,
  externalRef: z.string().optional(),
  lastError: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type SyncJob = z.infer<typeof SyncJobSchema>;

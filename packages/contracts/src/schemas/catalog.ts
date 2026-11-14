import { z } from 'zod';
import { BusinessIdSchema, QuoteIdSchema } from '../ids';
import { QUOTE_EXPIRY_MS } from '../constants';
import { CurrencySchema, IsoDateTimeSchema, MinorAmountSchema, Sha256HashSchema, msBetween } from '../primitives';

export const CatalogVariationSchema = z.object({
  id: z.string().min(1), // Square variation id
  name: z.string(),
  priceMinor: MinorAmountSchema,
  currency: CurrencySchema,
});
export type CatalogVariation = z.infer<typeof CatalogVariationSchema>;

export const CatalogModifierSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  priceMinor: MinorAmountSchema,
});
export type CatalogModifier = z.infer<typeof CatalogModifierSchema>;

export const ModifierSelectionTypeSchema = z.enum(['SINGLE', 'MULTIPLE']);
export type ModifierSelectionType = z.infer<typeof ModifierSelectionTypeSchema>;

export const CatalogModifierListSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  selectionType: ModifierSelectionTypeSchema,
  modifiers: z.array(CatalogModifierSchema),
});
export type CatalogModifierList = z.infer<typeof CatalogModifierListSchema>;

/** P-10 cache of Square, grouped by `squareItemId` (SPEC 2.9). Display prices only; quotes come from Square. */
export const CatalogItemSchema = z.object({
  squareItemId: z.string().min(1), // Cart.catalogItemId uses this value
  businessId: BusinessIdSchema,
  name: z.string(),
  description: z.string().optional(),
  available: z.boolean(), // true if any variation row is available
  variations: z.array(CatalogVariationSchema),
  modifierLists: z.array(CatalogModifierListSchema),
  syncedAt: IsoDateTimeSchema,
});
export type CatalogItem = z.infer<typeof CatalogItemSchema>;

export const CartLineSchema = z.object({
  catalogItemId: z.string().min(1),
  variationId: z.string().min(1),
  quantity: z.int().min(1).max(20),
  modifierIds: z.array(z.string().min(1)),
  note: z.string().max(140).optional(),
});
export type CartLine = z.infer<typeof CartLineSchema>;

export const CartSchema = z.object({ lines: z.array(CartLineSchema).min(1) });
export type Cart = z.infer<typeof CartSchema>;

export const QuoteLineModifierSchema = z.object({
  modifierId: z.string().min(1),
  name: z.string(),
  priceMinor: MinorAmountSchema,
});
export type QuoteLineModifier = z.infer<typeof QuoteLineModifierSchema>;

export const QuoteLineSchema = z.object({
  variationId: z.string().min(1),
  name: z.string(),
  quantity: z.int().min(1),
  unitPriceMinor: MinorAmountSchema,
  modifiers: z.array(QuoteLineModifierSchema),
  lineTotalMinor: MinorAmountSchema,
});
export type QuoteLine = z.infer<typeof QuoteLineSchema>;

/** P-02: from Square CalculateOrder. SPEC 2.9: `expiresAt` is `quotedAt` plus 5 minutes. */
/** The fields without cross-field checks, for `.extend()`, `.pick()` and `.partial()`. */
export const QuoteBaseSchema = z.object({
  quoteId: QuoteIdSchema,
  cartHash: Sha256HashSchema,
  subtotalMinor: MinorAmountSchema,
  taxMinor: MinorAmountSchema,
  totalMinor: MinorAmountSchema,
  currency: CurrencySchema,
  lines: z.array(QuoteLineSchema),
  quotedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
});

// Line totals are not summed against subtotalMinor: how Square's line totals map to lineTotalMinor
// (with or without line tax) is not fixed by the docs.
export const QuoteSchema = QuoteBaseSchema.superRefine((q, ctx) => {
  if (Math.abs(msBetween(q.quotedAt, q.expiresAt) - QUOTE_EXPIRY_MS) > 2000) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt must be quotedAt plus 5 minutes within 2 seconds (SPEC 2.9)' });
  }
});
export type Quote = z.infer<typeof QuoteSchema>;

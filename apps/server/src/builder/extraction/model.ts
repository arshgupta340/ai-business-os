import { z } from 'zod';
import type { FileMime } from './types';

// The extraction model: one structured-output call per file (P-12). Two
// implementations, as for the builder model: OpenAiDocumentExtractor
// (Responses API, strict Structured Outputs) and RecordedDocumentExtractor
// (fixed outputs, used when OPENAI_API_KEY is absent).

// The structured output. Strict Structured Outputs need every field present,
// so "no value" is null. The value is one flat object of nullable fields
// because a strict schema cannot hold an arbitrary object; sanitize.ts turns
// it into the per-kind value shape.
//
// `kind` and `key` are plain strings on purpose. The model may write anything;
// sanitize.ts drops every kind outside the documented list and every key that
// does not fit its kind. Nothing in this output is trusted, and there is no
// field that could mark a fact verified, call a tool or change a capability.
export const ExtractedValueSchema = z.object({
  text: z.string().nullable(),
  question: z.string().nullable(),
  itemName: z.string().nullable(),
  variationName: z.string().nullable(),
  priceMinor: z.number().int().nullable(),
  durationMinutes: z.number().int().nullable(),
  open: z.string().nullable(),
  close: z.string().nullable(),
  closed: z.boolean().nullable(),
  minutes: z.number().int().nullable(),
  allowed: z.boolean().nullable(),
});
export type ExtractedValue = z.infer<typeof ExtractedValueSchema>;

export const ExtractedFactSchema = z.object({
  kind: z.string(),
  key: z.string(),
  value: ExtractedValueSchema,
  confidence: z.number(),
  sourceRef: z.string(),
});
export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;

export const ExtractionOutputSchema = z.object({ facts: z.array(ExtractedFactSchema) });
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

// What the model receives for one file. PDFs and images go as the file
// itself. CSV and spreadsheets are parsed on the server first and go as rows.
export type ExtractionInput =
  | { form: 'file'; fileName: string; mime: Extract<FileMime, 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp'>; base64: string }
  | { form: 'rows'; fileName: string; mime: Extract<FileMime, 'text/csv' | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'>; sheets: { sheet: string; rows: string[][] }[] };

export interface DocumentExtractor {
  readonly kind: 'openai' | 'recorded';
  // Returns the raw output. The caller validates and sanitizes it. Throws
  // ExtractorUnavailable on provider failure.
  extract(input: ExtractionInput): Promise<unknown>;
}

export class ExtractorUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ExtractorUnavailable';
  }
}

export const emptyValue = (): ExtractedValue => ({
  text: null,
  question: null,
  itemName: null,
  variationName: null,
  priceMinor: null,
  durationMinutes: null,
  open: null,
  close: null,
  closed: null,
  minutes: null,
  allowed: null,
});

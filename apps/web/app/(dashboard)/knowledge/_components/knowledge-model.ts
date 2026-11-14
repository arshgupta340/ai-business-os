/**
 * Pure logic for the Knowledge review screen (U-08). No React here, so every
 * rule is unit tested in knowledge-model.test.ts.
 *
 * Every value that came from an uploaded file is data. The helpers below turn
 * values into plain strings. Nothing here builds markup or follows a link.
 */
import type {ActivityEvent, BusinessFact, CatalogItem, FactConflict, FactKind, FileRecord} from '@/lib/api';
import {formatMoney} from '@/lib/format';

// ------------------------------------------------------------------ uploads

/** Accepted upload types (docs/API.md 3.2, SPEC P-12). Same list as FileRecord.mime. */
export const ACCEPTED_UPLOAD_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const satisfies readonly FileRecord['mime'][];

export type UploadMime = (typeof ACCEPTED_UPLOAD_MIME)[number];

/** The upload cap (SPEC 2.9 "Upload cap"): 10 MB per file. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Some systems give a CSV or a spreadsheet no type in the browser. For those
 * the file extension decides. A type the browser did give always wins.
 */
const MIME_BY_EXTENSION: Record<string, UploadMime> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export type UploadCheck = {ok: true; mime: UploadMime} | {ok: false; reason: 'type' | 'size' | 'empty'; message: string};

export function checkUpload(file: {name: string; type: string; size: number}): UploadCheck {
  const declared = file.type.trim().toLowerCase();
  let mime: UploadMime | undefined;
  if (declared) {
    mime = (ACCEPTED_UPLOAD_MIME as readonly string[]).includes(declared) ? (declared as UploadMime) : undefined;
  } else {
    const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
    mime = MIME_BY_EXTENSION[extension];
  }
  if (!mime) {
    return {
      ok: false,
      reason: 'type',
      message: `${file.name} was not uploaded. Upload a PDF, an image (PNG, JPEG or WebP), a CSV or a spreadsheet (.xlsx).`,
    };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: 'size',
      message: `${file.name} was not uploaded. It is ${formatBytes(file.size)} and the limit is 10 MB.`,
    };
  }
  if (file.size === 0) {
    return {ok: false, reason: 'empty', message: `${file.name} was not uploaded. The file is empty.`};
  }
  return {ok: true, mime};
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --------------------------------------------------------------- confidence

/**
 * No document gives a confidence threshold. CONTRACTS.md only says confidence
 * is 0 to 1 and 1 for seed and owner edits. The task brief says to use 0.8
 * when none is documented.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.8;

/** A draft below the threshold is marked "Please confirm". */
export function isLowConfidence(fact: Pick<BusinessFact, 'status' | 'confidence'>): boolean {
  return fact.status === 'draft' && fact.confidence < LOW_CONFIDENCE_THRESHOLD;
}

export function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

// ------------------------------------------------------------ fact grouping

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

/** Kinds shown in "Business knowledge". menu_item is left out on purpose: it is never a price source. */
export const KNOWLEDGE_KINDS = ['hours', 'policy', 'service', 'contact', 'faq'] as const satisfies readonly FactKind[];
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KIND_LABELS: Record<FactKind, string> = {
  hours: 'Opening hours',
  policy: 'Policies',
  service: 'Services',
  contact: 'Contact',
  faq: 'Questions and answers',
  menu_item: 'Menu item from a file',
};

export type HoursRow = {day: Weekday; verified?: BusinessFact; pending: BusinessFact[]};

export type KnowledgeGroups = {
  hours: HoursRow[];
  policy: KnowledgeRow[];
  service: KnowledgeRow[];
  contact: KnowledgeRow[];
  faq: KnowledgeRow[];
};

/** One key in a group: the verified fact (if any) and drafts that wait for the owner. */
export type KnowledgeRow = {key: string; verified?: BusinessFact; pending: BusinessFact[]};

/**
 * Groups facts for "Business knowledge". Verified facts are the knowledge the
 * agent uses. Drafts that did not come from a file (an owner edit waiting for
 * its confirmation) are listed next to the key they would change. Upload
 * drafts stay in the extracted view. Superseded facts and menu_item facts
 * are left out.
 */
export function groupKnowledge(facts: readonly BusinessFact[]): KnowledgeGroups {
  const byKind = new Map<KnowledgeKind, Map<string, KnowledgeRow>>();
  for (const kind of KNOWLEDGE_KINDS) byKind.set(kind, new Map());

  for (const fact of facts) {
    if (!(KNOWLEDGE_KINDS as readonly string[]).includes(fact.kind)) continue;
    if (fact.status === 'superseded') continue;
    if (fact.status === 'draft' && (fact.sourceType === 'upload' || fact.fileId)) continue;
    const rows = byKind.get(fact.kind as KnowledgeKind)!;
    const row = rows.get(fact.key) ?? {key: fact.key, pending: []};
    if (fact.status === 'verified') {
      // At most one verified fact per kind and key. If the server ever sends two, keep the newer version.
      if (!row.verified || fact.version > row.verified.version) row.verified = fact;
    } else {
      row.pending.push(fact);
    }
    rows.set(fact.key, row);
  }

  const hoursRows = byKind.get('hours')!;
  const hours: HoursRow[] = WEEKDAYS.map((day) => {
    const row = hoursRows.get(day);
    return {day, verified: row?.verified, pending: row?.pending ?? []};
  });

  const sorted = (kind: KnowledgeKind) =>
    [...byKind.get(kind)!.values()].sort((a, b) => factKeyLabel(kind, a.key, rowValue(a)).localeCompare(factKeyLabel(kind, b.key, rowValue(b))));

  return {hours, policy: sorted('policy'), service: sorted('service'), contact: sorted('contact'), faq: sorted('faq')};
}

function rowValue(row: KnowledgeRow): unknown {
  return row.verified?.value ?? row.pending[0]?.value;
}

/** Draft facts that came from one uploaded file. */
export function draftsForFile(facts: readonly BusinessFact[], fileId: string): BusinessFact[] {
  return facts.filter((f) => f.fileId === fileId && f.status === 'draft');
}

/**
 * There is no endpoint that lists a business's files. The list is rebuilt
 * from files uploaded in this session, from extraction.completed events and
 * from facts that carry a fileId. Newest known first, no duplicates.
 */
export function knownFileIds(
  sessionUploads: readonly string[],
  events: readonly ActivityEvent[],
  facts: readonly BusinessFact[],
): string[] {
  const ids: string[] = [];
  const add = (id: unknown) => {
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
  };
  sessionUploads.forEach(add);
  for (const event of events) if (event.type === 'extraction.completed') add(event.payload.fileId);
  for (const fact of facts) add(fact.fileId);
  return ids;
}

// ---------------------------------------------------------------- conflicts

export type ConflictSummary = {openCount: number; requiredOpenCount: number; blocksPublish: boolean};

/**
 * Counts open conflicts. Publish is blocked when a required conflict is open.
 * This only reads what the server returned. It never unblocks anything.
 */
export function summarizeConflicts(conflicts: readonly FactConflict[]): ConflictSummary {
  const open = conflicts.filter((c) => c.state === 'open');
  const requiredOpenCount = open.filter((c) => c.required).length;
  return {openCount: open.length, requiredOpenCount, blocksPublish: requiredOpenCount > 0};
}

/** A conflict on a menu price. It is never resolved by a fact edit. */
export function isPriceConflict(conflict: Pick<FactConflict, 'kind'>): boolean {
  return conflict.kind === 'menu_item';
}

type Candidate = FactConflict['candidates'][number];

/** The uploaded candidate is the one with sourceType "upload"; the other one is the authority. */
export function splitCandidates(conflict: FactConflict): {uploaded?: Candidate; authority?: Candidate} {
  const uploaded = conflict.candidates.find((c) => c.sourceType === 'upload');
  const authority = conflict.candidates.find((c) => c !== uploaded && c.sourceType !== 'upload');
  return {uploaded, authority};
}

/** Draft fact IDs that take part in an open conflict, mapped to that conflict. */
export function conflictByFactId(conflicts: readonly FactConflict[]): Map<string, FactConflict> {
  const map = new Map<string, FactConflict>();
  for (const conflict of conflicts) {
    if (conflict.state !== 'open') continue;
    for (const candidate of conflict.candidates) if (candidate.factId) map.set(candidate.factId, conflict);
  }
  return map;
}

/** "Square", "Uploaded file" and so on, for a fact source type. */
export function sourceTypeLabel(sourceType: BusinessFact['sourceType']): string {
  switch (sourceType) {
    case 'square':
      return 'Square';
    case 'google_calendar':
      return 'Google Calendar';
    case 'owner_chat':
      return 'You, in the builder chat';
    case 'owner_ui':
      return 'You, in the dashboard';
    case 'upload':
      return 'Uploaded file';
    case 'seed':
      return 'Setup data';
    default:
      return String(sourceType);
  }
}

/** Finds the catalog item and variation for a Square variation ID. */
export function findVariation(
  items: readonly CatalogItem[] | undefined,
  variationId: string,
): {item: CatalogItem; variation: CatalogItem['variations'][number]} | undefined {
  for (const item of items ?? []) {
    const variation = item.variations.find((v) => v.id === variationId);
    if (variation) return {item, variation};
  }
  return undefined;
}

// ------------------------------------------------------------ value display

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** "22:00" to "10:00 PM". Anything else comes back as given. Hours are wall times in the business time zone. */
export function formatClock(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return hhmm;
  const hours = Number(match[1]);
  const minutes = match[2];
  if (hours > 23) return hhmm;
  const suffix = hours < 12 ? 'AM' : 'PM';
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${minutes} ${suffix}`;
}

export function formatHours(value: unknown): string {
  if (isRecord(value)) {
    if (value.closed === true) return 'Closed';
    if (typeof value.open === 'string' && typeof value.close === 'string') {
      return `${formatClock(value.open)} to ${formatClock(value.close)}`;
    }
  }
  return describeGeneric(value);
}

/** Turns "pickup_window" into "Pickup window". */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : key;
}

/** The row label for a fact key. */
export function factKeyLabel(kind: FactKind, key: string, value?: unknown): string {
  if (kind === 'hours' && (WEEKDAYS as readonly string[]).includes(key)) return WEEKDAY_NAMES[key as Weekday];
  if (kind === 'service' && isRecord(value) && typeof value.name === 'string') return value.name;
  if (kind === 'faq' && isRecord(value) && typeof value.question === 'string') return value.question;
  if (kind === 'menu_item' && isRecord(value) && typeof value.item === 'string') {
    return typeof value.variation === 'string' ? `${value.item}, ${value.variation}` : value.item;
  }
  if (kind === 'menu_item') return key;
  return humanizeKey(key);
}

export type ValueText = {text: string; hasMoney: boolean};

/** A plain-text description of a fact value. Money fields are in minor units. */
export function describeValue(kind: FactKind, value: unknown): ValueText {
  if (kind === 'hours') return {text: formatHours(value), hasMoney: false};
  if (!isRecord(value)) return {text: describeGeneric(value), hasMoney: false};

  const hasMoney = typeof value.priceMinor === 'number';
  const currency = typeof value.currency === 'string' ? value.currency : 'USD';
  const price = hasMoney ? formatMoney(value.priceMinor as number, currency) : undefined;

  if (kind === 'service') {
    const parts: string[] = [];
    if (typeof value.name === 'string') parts.push(value.name);
    if (typeof value.durationMinutes === 'number') parts.push(`${value.durationMinutes} min`);
    if (price) parts.push(price);
    if (typeof value.bufferMinutes === 'number') parts.push(`${value.bufferMinutes} min buffer`);
    if (parts.length) return {text: parts.join(', '), hasMoney};
  }
  if (kind === 'menu_item') {
    const parts: string[] = [];
    if (typeof value.item === 'string') parts.push(value.item);
    if (typeof value.variation === 'string') parts.push(value.variation);
    if (price) parts.push(price);
    if (parts.length) return {text: parts.join(', '), hasMoney};
  }
  if (kind === 'faq' && typeof value.question === 'string' && typeof value.answer === 'string') {
    return {text: `${value.question} ${value.answer}`, hasMoney: false};
  }
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const only = keys[0];
    if (only === 'priceMinor' && price) return {text: price, hasMoney: true};
    if (only === 'minutes' && typeof value.minutes === 'number') return {text: `${value.minutes} minutes`, hasMoney: false};
    if (only === 'allowed' && typeof value.allowed === 'boolean') {
      return {text: value.allowed ? 'Allowed' : 'Not allowed', hasMoney: false};
    }
    if (typeof value[only] === 'string' || typeof value[only] === 'number') return {text: String(value[only]), hasMoney: false};
  }
  return {text: describeGeneric(value), hasMoney};
}

function describeGeneric(value: unknown): string {
  if (value === null || value === undefined) return 'No value';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(describeGeneric).join(', ');
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([k, v]) => {
        const text = k.endsWith('priceMinor') && typeof v === 'number' ? formatMoney(v) : describeGeneric(v);
        return `${humanizeKey(k)}: ${text}`;
      })
      .join('; ');
  }
  return String(value);
}

// ------------------------------------------------------------- corrections

/** One editable field of a flat fact value. */
export type EditableField = {name: string; label: string; type: 'string' | 'number' | 'boolean'; value: string | number | boolean};

/** Fields the owner never edits here: they identify the record or are fixed by the contract. */
const LOCKED_FIELDS = new Set(['id', 'businessId', 'currency']);

/**
 * The editable fields of a value, or null when the value is not a flat object
 * of strings, numbers and booleans (then only "Confirm as is" is offered).
 */
export function editableFields(value: unknown): EditableField[] | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [{name: '', label: 'Value', type: typeof value as EditableField['type'], value}];
  }
  if (!isRecord(value)) return null;
  const fields: EditableField[] = [];
  for (const [name, v] of Object.entries(value)) {
    if (LOCKED_FIELDS.has(name)) continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
    const label = name === 'priceMinor' ? 'Price in cents' : humanizeKey(name);
    fields.push({name, label, type: typeof v as EditableField['type'], value: v});
  }
  return fields.length ? fields : null;
}

export type FieldInput = Record<string, string | boolean>;

/**
 * Applies the owner's edits to a value. Locked fields are kept. A number field
 * that is not a number gives an error for that field.
 */
export function applyEdits(
  original: unknown,
  inputs: FieldInput,
): {ok: true; value: unknown} | {ok: false; errors: Record<string, string>} {
  const fields = editableFields(original);
  if (!fields) return {ok: false, errors: {'': 'This value cannot be edited here.'}};
  const errors: Record<string, string> = {};
  const parsed: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = inputs[field.name];
    if (raw === undefined) {
      parsed[field.name] = field.value;
    } else if (field.type === 'number') {
      const text = String(raw).trim();
      const n = Number(text);
      if (!text || !Number.isFinite(n)) errors[field.name] = 'Enter a number.';
      else parsed[field.name] = n;
    } else if (field.type === 'boolean') {
      parsed[field.name] = raw === true || raw === 'true';
    } else {
      const text = String(raw).trim();
      if (!text) errors[field.name] = 'Enter a value.';
      else parsed[field.name] = text;
    }
  }
  if (Object.keys(errors).length) return {ok: false, errors};
  if (fields.length === 1 && fields[0].name === '') return {ok: true, value: parsed['']};
  return {ok: true, value: {...(original as Record<string, unknown>), ...parsed}};
}

// ------------------------------------------------------------ catalog sync

export type CatalogSyncState = 'PENDING' | 'RUNNING' | 'RETRYING' | 'DONE' | 'FAILED';

/**
 * The state of one catalog sync job, read from sync.* events with
 * target "catalog" and the job's jobId. Returns PENDING until an event says more.
 */
export function catalogSyncState(events: readonly ActivityEvent[], jobId: string): CatalogSyncState {
  // Events are newest first. The newest event for this job decides.
  for (const event of events) {
    const p = event.payload as {target?: unknown; jobId?: unknown};
    if (p.target !== 'catalog' || p.jobId !== jobId) continue;
    if (event.type === 'sync.succeeded') return 'DONE';
    if (event.type === 'sync.failed') return event.payload.final === false ? 'RETRYING' : 'FAILED';
    if (event.type === 'sync.queued') return 'PENDING';
  }
  return 'PENDING';
}

export const CATALOG_SYNC_LABELS: Record<CatalogSyncState, string> = {
  PENDING: 'Sync queued',
  RUNNING: 'Syncing from Square',
  RETRYING: 'Sync failed, retrying',
  DONE: 'Synced from Square',
  FAILED: 'Sync failed',
};

import { PIZZA_CATALOG } from '../fixtures';
import type { BusinessFact, FactKind } from '../pending-contracts';
import type { ExtractionActivityEvent, ExtractionState, FactConflict, FileRecord } from './types';

// Persistence for uploads, behind small interfaces. The in-memory versions
// run until the database and Supabase Storage land (B-06). Each record is
// shaped after its table in docs/DATA-MODEL.md (files, business_facts,
// fact_conflicts, catalog_items). Every read takes the businessId, so a lookup
// can never cross businesses.

const clone = <T>(v: T): T => structuredClone(v);

// ---------------------------------------------------------------------------
// files (DATA-MODEL.md 2.5) and the private bytes.
//
// The bytes are private: the in-memory store keeps them in this process only.
// Nothing is written to disk or to a public path, and there is no route that
// serves them back. `storagePath` is the object key the Supabase version will
// use in the private bucket `business-files`; it is never sent to a client.

export interface StoredFile {
  record: Omit<FileRecord, 'draftFactIds' | 'conflictIds'>;
  storagePath: string;
  uploadedBy: string; // usr_
  // A short safe reason when extraction failed. Never document text.
  failureReason?: string;
}

export interface FileStore {
  put(file: StoredFile, bytes: Buffer): Promise<void>;
  get(businessId: string, id: string): Promise<StoredFile | undefined>;
  findBySha(businessId: string, sha256: string): Promise<StoredFile | undefined>;
  readBytes(businessId: string, id: string): Promise<Buffer | undefined>;
  setState(businessId: string, id: string, state: ExtractionState, failureReason?: string): Promise<void>;
}

export class InMemoryFileStore implements FileStore {
  private readonly rows = new Map<string, StoredFile>();
  private readonly blobs = new Map<string, Buffer>();

  async put(file: StoredFile, bytes: Buffer) {
    if (this.rows.has(file.record.id)) throw new Error(`duplicate file ${file.record.id}`);
    this.rows.set(file.record.id, clone(file));
    this.blobs.set(file.record.id, Buffer.from(bytes));
  }
  async get(businessId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.record.businessId === businessId ? clone(row) : undefined;
  }
  async findBySha(businessId: string, sha256: string) {
    for (const row of this.rows.values()) {
      if (row.record.businessId === businessId && row.record.sha256 === sha256) return clone(row);
    }
    return undefined;
  }
  async readBytes(businessId: string, id: string) {
    const row = this.rows.get(id);
    if (!row || row.record.businessId !== businessId) return undefined;
    const blob = this.blobs.get(id);
    return blob ? Buffer.from(blob) : undefined;
  }
  async setState(businessId: string, id: string, state: ExtractionState, failureReason?: string) {
    const row = this.rows.get(id);
    if (!row || row.record.businessId !== businessId) throw new Error(`unknown file ${id}`);
    row.record.extractionState = state;
    if (failureReason === undefined) delete row.failureReason;
    else row.failureReason = failureReason;
  }
}

// ---------------------------------------------------------------------------
// Draft business_facts from uploads (DATA-MODEL.md 2.6). This store only ever
// inserts drafts and moves a draft to superseded. It cannot verify a fact.

export interface UploadFactStore {
  insertDraft(fact: BusinessFact): Promise<void>;
  get(businessId: string, id: string): Promise<BusinessFact | undefined>;
  listByFile(businessId: string, fileId: string): Promise<BusinessFact[]>;
  supersedeDraft(businessId: string, id: string, at: string): Promise<BusinessFact | undefined>;
}

export class InMemoryUploadFactStore implements UploadFactStore {
  private readonly rows = new Map<string, BusinessFact>();

  async insertDraft(fact: BusinessFact) {
    if (fact.status !== 'draft') throw new Error('Uploads write draft facts only.');
    if (fact.sourceType !== 'upload' || !fact.fileId) throw new Error('An upload fact needs sourceType "upload" and a fileId.');
    if (this.rows.has(fact.id)) throw new Error(`duplicate fact ${fact.id}`);
    this.rows.set(fact.id, clone(fact));
  }
  async get(businessId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.businessId === businessId ? clone(row) : undefined;
  }
  async listByFile(businessId: string, fileId: string) {
    return [...this.rows.values()].filter((f) => f.businessId === businessId && f.fileId === fileId).map(clone);
  }
  // Only a draft moves, and only to superseded. Returns the updated fact, or
  // undefined if it was not a draft of this business.
  async supersedeDraft(businessId: string, id: string, at: string) {
    const row = this.rows.get(id);
    if (!row || row.businessId !== businessId || row.status !== 'draft') return undefined;
    row.status = 'superseded';
    row.updatedAt = at;
    return clone(row);
  }
}

// ---------------------------------------------------------------------------
// fact_conflicts (DATA-MODEL.md 2.8). At most one open conflict per business,
// kind and key (the fact_conflicts_one_open index).

export interface ConflictStore {
  insert(conflict: FactConflict): Promise<void>;
  get(businessId: string, id: string): Promise<FactConflict | undefined>;
  findOpen(businessId: string, kind: FactKind, key: string): Promise<FactConflict | undefined>;
  listOpen(businessId: string): Promise<FactConflict[]>;
  listByFactIds(businessId: string, factIds: string[]): Promise<FactConflict[]>;
  // Moves an open conflict to resolved. Returns undefined if it was not open.
  resolve(businessId: string, id: string, fields: { resolvedBy: string; resolvedAt: string; resolvedFactId?: string }): Promise<FactConflict | undefined>;
}

export class InMemoryConflictStore implements ConflictStore {
  private readonly rows = new Map<string, FactConflict>();

  async insert(conflict: FactConflict) {
    if (this.rows.has(conflict.id)) throw new Error(`duplicate conflict ${conflict.id}`);
    if (conflict.candidates.length < 2) throw new Error('A conflict needs at least two candidates.');
    if (conflict.state === 'open' && (await this.findOpen(conflict.businessId, conflict.kind, conflict.key))) {
      throw new Error(`an open conflict already exists for ${conflict.kind}.${conflict.key}`);
    }
    this.rows.set(conflict.id, clone(conflict));
  }
  async get(businessId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.businessId === businessId ? clone(row) : undefined;
  }
  async findOpen(businessId: string, kind: FactKind, key: string) {
    for (const row of this.rows.values()) {
      if (row.businessId === businessId && row.kind === kind && row.key === key && row.state === 'open') return clone(row);
    }
    return undefined;
  }
  async listOpen(businessId: string) {
    return [...this.rows.values()].filter((c) => c.businessId === businessId && c.state === 'open').map(clone);
  }
  async listByFactIds(businessId: string, factIds: string[]) {
    const ids = new Set(factIds);
    return [...this.rows.values()]
      .filter((c) => c.businessId === businessId && c.candidates.some((k) => k.factId !== undefined && ids.has(k.factId)))
      .map(clone);
  }
  async resolve(businessId: string, id: string, fields: { resolvedBy: string; resolvedAt: string; resolvedFactId?: string }) {
    const row = this.rows.get(id);
    if (!row || row.businessId !== businessId || row.state !== 'open') return undefined;
    row.state = 'resolved';
    row.resolvedBy = fields.resolvedBy;
    row.resolvedAt = fields.resolvedAt;
    if (fields.resolvedFactId) row.resolvedFactId = fields.resolvedFactId;
    return clone(row);
  }
}

// ---------------------------------------------------------------------------
// Catalog reader: one row per sellable variation, as in catalog_items
// (DATA-MODEL.md 2.7). The real cache table belongs to the backend lead; the
// fixture version derives rows from the temporary pizza catalog. Its `cat_`
// IDs are made up here (`cat_` plus the lowercased Square variation ID).

export interface CatalogVariationRow {
  id: string; // cat_
  businessId: string;
  squareItemId: string;
  squareVariationId: string;
  itemName: string;
  variationName: string;
  priceMinor: number;
  currency: 'USD';
}

export interface CatalogReader {
  listVariations(businessId: string): Promise<CatalogVariationRow[]>;
}

export class FixtureCatalogReader implements CatalogReader {
  async listVariations(businessId: string): Promise<CatalogVariationRow[]> {
    return PIZZA_CATALOG.filter((item) => item.businessId === businessId).flatMap((item) =>
      item.variations.map((v) => ({
        id: `cat_${v.id.toLowerCase()}`,
        businessId,
        squareItemId: item.squareItemId,
        squareVariationId: v.id,
        itemName: item.name,
        variationName: v.name,
        priceMinor: v.priceMinor,
        currency: v.currency,
      })),
    );
  }
}

// ---------------------------------------------------------------------------
// Activity events. The real writer (activity_events) belongs to the backend
// lead and is passed in. The default keeps events in memory so tests can read
// them. Payloads here never carry document text.

export interface ActivityEventSink {
  write(event: ExtractionActivityEvent): Promise<void>;
}

export class InMemoryActivityEventSink implements ActivityEventSink {
  readonly events: ExtractionActivityEvent[] = [];
  async write(event: ExtractionActivityEvent) {
    this.events.push(clone(event));
  }
}

// Database implementations of the builder's document extraction seams (builder NOTES-backend-changes.md,
// options `extraction.*`), so an uploaded file's record, the draft facts drawn from it and the conflicts
// they raise survive a restart and are the same rows the facts list and publish read. Nothing under
// apps/server/src/builder/ is edited: its interfaces are imported as types only. Every query runs as
// abos_app on tables it may write directly (files, business_facts, fact_conflicts, activity_events;
// 0004 grants, no guard trigger) and every query is scoped by business ID.
//
// What the database cannot hold, and what this file does about it:
//   - File contents. `files` has no column for them and no storage bucket is wired, so the bytes stay in
//     this process from `put` until the extraction of that file ends (EXTRACTED or FAILED), then they are
//     dropped. Only the metadata and the SHA-256 are stored. See `dbFileStore`.
//   - `StoredFile.failureReason`. `files` has no column for it; it is kept in this process only.
//   - A never-verified draft cannot become `superseded` (0002 check and index). See `supersedeDraft`.
//   - The builder saves a draft and its conflict in two calls, so they are two statements, not one transaction.
import type { BusinessFact, ExtractionState, FactConflict } from '@abos/contracts';
import type { ActivityEventSink, CatalogReader, ConflictStore, DocumentExtractor, ExtractionOptions, FileStore, UploadFactStore } from '../builder/extraction/index';
import type { CatalogVariationRow, StoredFile } from '../builder/extraction/stores';
import type { Db, QueryDb } from '../db/index';
import { AppError } from '../errors';
import { emitActivity } from '../policy/activity';

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const json = (v: unknown) => JSON.stringify(v ?? null);

// ---------- files ----------

/**
 * How long a file may sit PENDING or EXTRACTING, with its bytes not in this process, before it counts
 * as left behind by a process that is gone. One extraction is one model call with a 60 second timeout
 * and one retry (builder/extraction/openai-extractor.ts), so 15 minutes is far past any live run.
 */
export const ABANDONED_EXTRACTION_MS = 15 * 60_000;

const FILE_COLUMNS = 'id, business_id, storage_path, name, mime, sha256, size_bytes, extraction_state, uploaded_by, created_at';

function fileFromRow(r: Row, failureReason: string | undefined): StoredFile {
  return {
    record: {
      id: String(r.id), businessId: String(r.business_id), name: String(r.name), mime: r.mime as StoredFile['record']['mime'],
      sizeBytes: Number(r.size_bytes), sha256: String(r.sha256), extractionState: r.extraction_state as ExtractionState, createdAt: iso(r.created_at),
    },
    storagePath: String(r.storage_path), uploadedBy: String(r.uploaded_by),
    ...(failureReason === undefined ? {} : { failureReason }),
  };
}

/**
 * `files` rows, plus the bytes for as long as one extraction needs them.
 *
 * The database has no column for file contents and no storage bucket is wired, so none is invented:
 * `put` keeps the bytes in this process, `readBytes` serves them to the extraction that follows the
 * upload, and they are dropped when the file reaches EXTRACTED or FAILED. `storage_path` (not null,
 * unique) takes the key the builder computes; nothing is stored at that path.
 *
 * Consequence: a stored file can never be read again later. The builder has one path that would do so,
 * the re-run of a FAILED file from its stored bytes when the same file is uploaded again. Here a new
 * upload of the same content carries its own bytes, so it replaces the old record instead: `findBySha`
 * reports a row that cannot run again (FAILED, or in flight for longer than `abandonedAfterMs` with no
 * bytes in this process) as absent, and `put` then deletes that row and inserts the new one in one
 * transaction, moving the old row's draft facts to the new file. Any other call that would need bytes
 * this process no longer holds answers INVALID_STATE (`setState` back to PENDING) or lets the builder
 * mark the file FAILED (`readBytes` returns undefined).
 *
 * Two uploads of the same new content at once both miss the `for update` lookup (it cannot lock a row
 * that does not exist yet), so the second insert hits the unique index (business_id, sha256). That
 * unique violation answers the same INVALID_STATE with the winner's fileId, and the loser's bytes are
 * not held.
 */
export function dbFileStore(db: Db, options: { abandonedAfterMs?: number } = {}): FileStore {
  const abandonedAfterSeconds = Math.ceil((options.abandonedAfterMs ?? ABANDONED_EXTRACTION_MS) / 1000);
  const held = new Map<string, { businessId: string; bytes: Buffer; at: number }>();
  const reasons = new Map<string, string>();
  const holds = (businessId: string, id: string) => held.get(id)?.businessId === businessId;
  const release = (id: string) => { held.delete(id); };

  const bySha = async (q: QueryDb, businessId: string, sha256: string, lock = '') =>
    (await q.query(`select ${FILE_COLUMNS}, (created_at < pg_catalog.clock_timestamp() - ($3::int * interval '1 second')) as old
      from public.files where business_id = $1 and sha256 = $2 ${lock}`, [businessId, sha256, abandonedAfterSeconds])).rows[0] as Row | undefined;
  /** True when no extraction of this row can still finish: this process holds no bytes for it, and it failed or was left behind. */
  const cannotRunAgain = (r: Row) => !holds(String(r.business_id), String(r.id))
    && (r.extraction_state === 'FAILED' || ((r.extraction_state === 'PENDING' || r.extraction_state === 'EXTRACTING') && r.old === true));

  /** A unique violation (23505, as policy/engine.ts maps it) on the sha index means another upload of this content won: answer INVALID_STATE with its fileId. */
  const duplicateUpload = async (error: unknown, businessId: string, sha256: string): Promise<unknown> => {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (code !== '23505') return error;
    const winner = await bySha(db, businessId, sha256);
    return winner ? new AppError('INVALID_STATE', 'This file is already uploaded.', undefined, false, { fileId: String(winner.id) }) : error;
  };

  return {
    async put(file, bytes) {
      const f = file.record;
      // Bytes of an extraction that never reported an end (its state write failed) are not kept forever.
      for (const [id, h] of held) if (Date.now() - h.at > abandonedAfterSeconds * 1000) release(id);
      try {
      await db.transaction(async (tx) => {
        const prior = await bySha(tx, f.businessId, f.sha256, 'for update');
        let moved: string[] = [];
        if (prior) {
          if (!cannotRunAgain(prior)) throw new AppError('INVALID_STATE', 'This file is already uploaded.', undefined, false, { fileId: String(prior.id) });
          moved = ((await tx.query('select id from public.business_facts where business_id = $1 and file_id = $2', [f.businessId, prior.id])).rows as Row[]).map((r) => String(r.id));
          await tx.query('delete from public.files where id = $1 and business_id = $2', [prior.id, f.businessId]);
          reasons.delete(String(prior.id));
        }
        await tx.query(`insert into public.files (id, business_id, storage_path, name, mime, sha256, size_bytes, extraction_state, uploaded_by, created_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [f.id, f.businessId, file.storagePath, f.name, f.mime, f.sha256, f.sizeBytes, f.extractionState, file.uploadedBy, f.createdAt]);
        if (moved.length > 0) await tx.query('update public.business_facts set file_id = $3 where business_id = $1 and id = any($2::text[])', [f.businessId, moved, f.id]);
      });
      } catch (error) {
        throw await duplicateUpload(error, f.businessId, f.sha256);
      }
      held.set(f.id, { businessId: f.businessId, bytes: Buffer.from(bytes), at: Date.now() });
      if (file.failureReason !== undefined) reasons.set(f.id, file.failureReason);
    },
    async get(businessId, id) {
      const r = (await db.query(`select ${FILE_COLUMNS} from public.files where id = $1 and business_id = $2`, [id, businessId])).rows[0] as Row | undefined;
      return r ? fileFromRow(r, reasons.get(id)) : undefined;
    },
    async findBySha(businessId, sha256) {
      const r = await bySha(db, businessId, sha256);
      return r && !cannotRunAgain(r) ? fileFromRow(r, reasons.get(String(r.id))) : undefined;
    },
    async readBytes(businessId, id) {
      const h = held.get(id);
      return h && h.businessId === businessId ? Buffer.from(h.bytes) : undefined;
    },
    async setState(businessId, id, state, failureReason) {
      // Back to PENDING means "extract the stored bytes again". Without the bytes that cannot happen.
      if (state === 'PENDING' && !holds(businessId, id)) {
        throw new AppError('INVALID_STATE', 'The contents of this file are no longer held by the server. Upload the file again.', undefined, false, { fileId: id });
      }
      const r = await db.query('update public.files set extraction_state = $3 where id = $1 and business_id = $2 returning id', [id, businessId, state]);
      if (r.rows.length === 0) throw new Error(`unknown file ${id}`);
      if (failureReason === undefined) reasons.delete(id); else reasons.set(id, failureReason);
      if (state === 'EXTRACTED' || state === 'FAILED') release(id);
    },
  };
}

// ---------- draft business_facts from uploads ----------

function factFromRow(r: Row): BusinessFact {
  return {
    id: String(r.id), businessId: String(r.business_id), kind: r.kind as BusinessFact['kind'], key: String(r.key), value: r.value as BusinessFact['value'],
    sourceType: r.source_type as BusinessFact['sourceType'], ...(typeof r.source_ref === 'string' ? { sourceRef: r.source_ref } : {}),
    ...(typeof r.file_id === 'string' ? { fileId: r.file_id } : {}), status: r.status as BusinessFact['status'], confidence: Number(r.confidence),
    version: Number(r.version), ...(typeof r.supersedes_id === 'string' ? { supersedesId: r.supersedes_id } : {}),
    ...(r.verified_at ? { verifiedAt: iso(r.verified_at) } : {}), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

/**
 * Draft `business_facts` rows with `source_type = 'upload'` and their `file_id`. This store inserts
 * drafts and reads upload facts; it has no statement that verifies a fact or touches a verified row.
 */
export function dbUploadFactStore(db: Db): UploadFactStore {
  return {
    async insertDraft(f) {
      if (f.status !== 'draft') throw new Error('Uploads write draft facts only.');
      if (f.sourceType !== 'upload' || !f.fileId) throw new Error('An upload fact needs sourceType "upload" and a fileId.');
      // The file must be a file of the same business: the row is inserted only when that holds.
      const r = await db.query(`insert into public.business_facts (id, business_id, kind, key, value, source_type, source_ref, file_id, status, confidence, version, created_at, updated_at)
        select $1,$2,$3,$4,$5::jsonb,'upload',$6,$7,'draft',$8,$9,$10,$11
        where exists (select 1 from public.files where id = $7 and business_id = $2) returning id`,
      [f.id, f.businessId, f.kind, f.key, json(f.value), f.sourceRef ?? null, f.fileId, f.confidence, f.version, f.createdAt, f.updatedAt]);
      if (r.rows.length === 0) throw new Error(`unknown file ${f.fileId}`);
    },
    async get(businessId, id) {
      const r = (await db.query("select * from public.business_facts where id = $1 and business_id = $2 and source_type = 'upload'", [id, businessId])).rows[0] as Row | undefined;
      return r ? factFromRow(r) : undefined;
    },
    async listByFile(businessId, fileId) {
      return ((await db.query("select * from public.business_facts where business_id = $1 and file_id = $2 and source_type = 'upload' order by created_at, id", [businessId, fileId])).rows as Row[]).map(factFromRow);
    },
    /**
     * Not possible on this schema, so nothing is written and undefined is returned (the interface's
     * "it did not move"). A draft has no verified_at, `superseded` requires one (0002 check
     * `(status = 'draft') = (verified_at is null)`), and a superseded version 1 would collide with the
     * verified version 1 of the same key (index business_facts_version). Giving a draft a verified_at
     * would record a verification that never happened. The draft stays a draft; the conflict's own
     * `resolved` state is what records the owner's choice.
     */
    async supersedeDraft() {
      return undefined;
    },
  };
}

// ---------- fact_conflicts ----------

function conflictFromRow(r: Row): FactConflict {
  return {
    id: String(r.id), businessId: String(r.business_id), kind: r.kind as FactConflict['kind'], key: String(r.key), required: r.required === true,
    candidates: r.candidates as FactConflict['candidates'], state: r.state as FactConflict['state'],
    ...(typeof r.resolved_fact_id === 'string' ? { resolvedFactId: r.resolved_fact_id } : {}),
    ...(typeof r.resolved_by === 'string' ? { resolvedBy: r.resolved_by } : {}),
    ...(r.resolved_at ? { resolvedAt: iso(r.resolved_at) } : {}), createdAt: iso(r.created_at),
  };
}

/**
 * `fact_conflicts` rows: the ones GET /api/businesses/:id/facts lists, publish refuses on, and
 * POST /api/conflicts/:id/resolve (api/conflicts.ts) resolves. One open conflict per business, kind
 * and key is the table's own unique index (fact_conflicts_one_open). The builder looks for the open
 * conflict and then inserts, in two calls, so two extractions that disagree on the same key can both
 * find none. The second insert then writes nothing instead of failing its whole file: the key already
 * has its open conflict, which is the state the builder wants ("a second disagreeing draft for the
 * same key stays a draft without its own"). Any other violation (a repeated ID, fewer than two
 * candidates) still fails.
 */
export function dbConflictStore(db: Db): ConflictStore {
  const list = async (sql: string, params: unknown[]) => ((await db.query(sql, params)).rows as Row[]).map(conflictFromRow);
  return {
    async insert(c) {
      await db.query(`insert into public.fact_conflicts (id, business_id, kind, key, candidates, required, state, resolved_fact_id, resolved_by, resolved_at, created_at)
        values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
        on conflict (business_id, kind, key) where state = 'open' do nothing`,
      [c.id, c.businessId, c.kind, c.key, JSON.stringify(c.candidates), c.required, c.state, c.resolvedFactId ?? null, c.resolvedBy ?? null, c.resolvedAt ?? null, c.createdAt]);
    },
    async get(businessId, id) {
      return (await list('select * from public.fact_conflicts where id = $1 and business_id = $2', [id, businessId]))[0];
    },
    async findOpen(businessId, kind, key) {
      return (await list("select * from public.fact_conflicts where business_id = $1 and kind = $2 and key = $3 and state = 'open'", [businessId, kind, key]))[0];
    },
    listOpen(businessId) {
      return list("select * from public.fact_conflicts where business_id = $1 and state = 'open' order by created_at, id", [businessId]);
    },
    async listByFactIds(businessId, factIds) {
      if (factIds.length === 0) return [];
      return list(`select c.* from public.fact_conflicts c where c.business_id = $1
        and exists (select 1 from pg_catalog.jsonb_array_elements(c.candidates) k where k->>'factId' = any($2::text[])) order by c.created_at, c.id`, [businessId, factIds]);
    },
    /** One conditional update while the row is open. resolved_at takes the database clock, as api/conflicts.ts does for the same column. */
    async resolve(businessId, id, fields) {
      const r = (await db.query(`update public.fact_conflicts set state = 'resolved', resolved_by = $3, resolved_at = pg_catalog.clock_timestamp(), resolved_fact_id = $4
        where id = $1 and business_id = $2 and state = 'open' returning *`, [id, businessId, fields.resolvedBy, fields.resolvedFactId ?? null])).rows[0] as Row | undefined;
      return r ? conflictFromRow(r) : undefined;
    },
  };
}

// ---------- catalog_items ----------

/** One row per sellable variation of this business, from the cache only the Square sync writes. */
export function dbCatalogReader(db: Db): CatalogReader {
  return {
    async listVariations(businessId): Promise<CatalogVariationRow[]> {
      const rows = (await db.query(`select id, business_id, square_item_id, square_variation_id, item_name, variation_name, price_minor
        from public.catalog_items where business_id = $1 order by item_name, variation_name, id`, [businessId])).rows as Row[];
      // The currency column is checked to be USD (0002).
      return rows.map((r) => ({ id: String(r.id), businessId: String(r.business_id), squareItemId: String(r.square_item_id), squareVariationId: String(r.square_variation_id),
        itemName: String(r.item_name), variationName: String(r.variation_name), priceMinor: Number(r.price_minor), currency: 'USD' }));
    },
  };
}

// ---------- activity_events ----------

/** extraction.completed and fact.changed, through the server's one writer: contract-checked, redacted, on the database clock. */
export function dbExtractionEventSink(db: Db): ActivityEventSink {
  return { write: (event) => emitActivity(db, event) };
}

// ---------- the option the builder plugin takes ----------

/** The builder plugin's `extraction` option on the database. Without `extractor` the builder picks its own (OpenAI with a key, recorded without). */
export function dbExtractionOptions(db: Db, extractor?: DocumentExtractor): ExtractionOptions {
  return {
    files: dbFileStore(db), facts: dbUploadFactStore(db), conflicts: dbConflictStore(db), catalog: dbCatalogReader(db), events: dbExtractionEventSink(db),
    ...(extractor ? { extractor } : {}),
  };
}

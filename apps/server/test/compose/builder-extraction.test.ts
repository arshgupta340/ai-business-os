// The builder's document extraction stores on the in-process Postgres, as abos_app
// (compose/builder-extraction.ts). No provider and no real database is involved.
import { createHash } from 'node:crypto';
import type { BusinessFact, FactConflict } from '@abos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredFile } from '../../src/builder/extraction/stores';
import { dbCatalogReader, dbConflictStore, dbExtractionEventSink, dbExtractionOptions, dbFileStore, dbUploadFactStore } from '../../src/compose/builder-extraction';
import { AppError } from '../../src/errors';
import { currentRole } from '../support/db';
import { createHarness } from '../api/harness';

let h: Awaited<ReturnType<typeof createHarness>>;
beforeAll(async () => { h = await createHarness(); }, 60_000);
afterAll(async () => { await h?.close(); });

const NOW = () => new Date().toISOString();
const sha = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const rows = async (sql: string, params: unknown[] = []) => (await h.db.query(sql, params)).rows as Record<string, unknown>[];

function file(id: string, bytes: Buffer, businessId = 'biz_a', createdAt = NOW()): StoredFile {
  return {
    record: { id, businessId, name: `${id}.pdf`, mime: 'application/pdf', sizeBytes: bytes.length, sha256: sha(bytes), extractionState: 'PENDING', createdAt },
    storagePath: `${businessId}/${id}`, uploadedBy: businessId === 'biz_a' ? 'usr_a' : 'usr_b',
  };
}
function draft(id: string, fileId: string, extra: Partial<BusinessFact> = {}): BusinessFact {
  const at = NOW();
  return { id, businessId: 'biz_a', kind: 'menu_item', key: `item:${id}`, value: { itemName: 'Pizza', priceMinor: 2100, currency: 'USD' }, sourceType: 'upload',
    sourceRef: 'page 1', fileId, status: 'draft', confidence: 0.92, version: 1, createdAt: at, updatedAt: at, ...extra };
}
function conflict(id: string, key: string, factId: string, extra: Partial<FactConflict> = {}): FactConflict {
  return { id, businessId: 'biz_a', kind: 'menu_item', key, required: true, state: 'open', createdAt: NOW(),
    candidates: [{ factId, sourceType: 'upload', sourceRef: 'page 1', value: { priceMinor: 2100 } }, { sourceType: 'square', sourceRef: 'cat_a1', value: { priceMinor: 2000 } }], ...extra };
}

describe('extraction stores on Postgres', () => {
  it('runs as abos_app', async () => { expect(await currentRole(h.db)).toBe('abos_app'); });

  describe('files', () => {
    it('stores the metadata and the hash, never the contents, and never crosses businesses', async () => {
      const store = dbFileStore(h.db);
      const bytes = Buffer.from('%PDF-1.4 the menu text, large margherita 21.00');
      await store.put(file('file_t1', bytes), bytes);

      const stored = await rows('select * from files where id = $1', ['file_t1']);
      expect(Object.keys(stored[0]!).sort()).toEqual(['business_id', 'created_at', 'extraction_state', 'id', 'mime', 'name', 'sha256', 'size_bytes', 'storage_path', 'uploaded_by']);
      expect(stored[0]).toMatchObject({ business_id: 'biz_a', sha256: sha(bytes), size_bytes: bytes.length, extraction_state: 'PENDING', uploaded_by: 'usr_a', storage_path: 'biz_a/file_t1' });
      // No column of the row holds the document text.
      expect(JSON.stringify(stored[0])).not.toContain('margherita');

      expect(await store.get('biz_a', 'file_t1')).toMatchObject({ record: { id: 'file_t1', businessId: 'biz_a', name: 'file_t1.pdf', mime: 'application/pdf', sizeBytes: bytes.length, sha256: sha(bytes), extractionState: 'PENDING' }, uploadedBy: 'usr_a' });
      expect(await store.get('biz_b', 'file_t1')).toBeUndefined();
      expect((await store.findBySha('biz_a', sha(bytes)))?.record.id).toBe('file_t1');
      expect(await store.findBySha('biz_b', sha(bytes))).toBeUndefined();
      expect(await store.readBytes('biz_b', 'file_t1')).toBeUndefined();
      await expect(store.setState('biz_b', 'file_t1', 'EXTRACTING')).rejects.toThrow('unknown file');
      await expect(store.put(file('file_t1', bytes), bytes)).rejects.toThrow();
    });

    it('keeps the bytes only until the extraction ends', async () => {
      const store = dbFileStore(h.db);
      const bytes = Buffer.from('%PDF-1.4 bytes for one extraction');
      await store.put(file('file_t2', bytes), bytes);
      await store.setState('biz_a', 'file_t2', 'EXTRACTING');
      expect((await store.readBytes('biz_a', 'file_t2'))?.equals(bytes)).toBe(true);
      await store.setState('biz_a', 'file_t2', 'EXTRACTED');
      expect(await store.readBytes('biz_a', 'file_t2')).toBeUndefined();
      expect((await store.get('biz_a', 'file_t2'))?.record.extractionState).toBe('EXTRACTED');

      // A new store on the same database (a restart): the record is there, the bytes are not.
      const restarted = dbFileStore(h.db);
      expect((await restarted.get('biz_a', 'file_t2'))?.record).toMatchObject({ id: 'file_t2', extractionState: 'EXTRACTED', sha256: sha(bytes) });
      expect((await restarted.findBySha('biz_a', sha(bytes)))?.record.id).toBe('file_t2');
      expect(await restarted.readBytes('biz_a', 'file_t2')).toBeUndefined();
      // Asking for a re-run of bytes that are gone is a contract error, and the row is not changed.
      const refused = await restarted.setState('biz_a', 'file_t2', 'PENDING').catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(AppError);
      expect(refused).toMatchObject({ code: 'INVALID_STATE', retryable: false, details: { fileId: 'file_t2' } });
      expect(await rows('select extraction_state from files where id = $1', ['file_t2'])).toEqual([{ extraction_state: 'EXTRACTED' }]);
    });

    it('a failed file is replaced by a new upload of the same content, and its drafts move with it', async () => {
      const store = dbFileStore(h.db);
      const facts = dbUploadFactStore(h.db);
      const bytes = Buffer.from('%PDF-1.4 a file whose extraction fails once');
      await store.put(file('file_t3', bytes), bytes);
      await store.setState('biz_a', 'file_t3', 'EXTRACTING');
      await facts.insertDraft(draft('fact_t3_partial', 'file_t3'));
      await store.setState('biz_a', 'file_t3', 'FAILED', 'The extraction service did not answer. Try the upload again.');
      expect((await store.get('biz_a', 'file_t3'))?.failureReason).toBe('The extraction service did not answer. Try the upload again.');
      expect(await store.readBytes('biz_a', 'file_t3')).toBeUndefined();

      // The failed row cannot run again, so the same content counts as a new upload.
      expect(await store.findBySha('biz_a', sha(bytes))).toBeUndefined();
      await store.put(file('file_t3b', bytes), bytes);
      expect(await rows('select id, extraction_state from files where business_id = $1 and sha256 = $2', ['biz_a', sha(bytes)])).toEqual([{ id: 'file_t3b', extraction_state: 'PENDING' }]);
      expect(await store.get('biz_a', 'file_t3')).toBeUndefined();
      expect((await store.readBytes('biz_a', 'file_t3b'))?.equals(bytes)).toBe(true);
      expect((await facts.listByFile('biz_a', 'file_t3b')).map((f) => f.id)).toEqual(['fact_t3_partial']);
      await store.setState('biz_a', 'file_t3b', 'EXTRACTED');
    });

    it('a file this process is extracting, or has extracted, is never replaced', async () => {
      const store = dbFileStore(h.db);
      const bytes = Buffer.from('%PDF-1.4 a file in flight');
      await store.put(file('file_t4', bytes), bytes);
      const again = await store.put(file('file_t4b', bytes), bytes).catch((e: unknown) => e);
      expect(again).toMatchObject({ code: 'INVALID_STATE', details: { fileId: 'file_t4' } });
      await store.setState('biz_a', 'file_t4', 'EXTRACTED');
      expect(await store.put(file('file_t4c', bytes), bytes).catch((e: unknown) => e)).toMatchObject({ code: 'INVALID_STATE' });
      expect(await rows('select id from files where business_id = $1 and sha256 = $2', ['biz_a', sha(bytes)])).toEqual([{ id: 'file_t4' }]);
    });

    it('a file left in flight by a process that is gone is replaced only once it is old', async () => {
      const bytes = Buffer.from('%PDF-1.4 a file a dead process was reading');
      await dbFileStore(h.db).put(file('file_t5', bytes, 'biz_a', new Date(Date.now() - 3_600_000).toISOString()), bytes);
      // Another process (no bytes here). Young by a one-day rule: it may still be running elsewhere.
      const patient = dbFileStore(h.db, { abandonedAfterMs: 86_400_000 });
      expect((await patient.findBySha('biz_a', sha(bytes)))?.record.id).toBe('file_t5');
      // Old by the default 15 minute rule: a new upload takes its place.
      const store = dbFileStore(h.db);
      expect(await store.findBySha('biz_a', sha(bytes))).toBeUndefined();
      await store.put(file('file_t5b', bytes), bytes);
      expect(await rows('select id from files where business_id = $1 and sha256 = $2', ['biz_a', sha(bytes)])).toEqual([{ id: 'file_t5b' }]);
    });
  });

  describe('upload facts', () => {
    it('inserts drafts with their file, reads them by business, and nothing else', async () => {
      const files = dbFileStore(h.db);
      const store = dbUploadFactStore(h.db);
      const bytes = Buffer.from('%PDF-1.4 facts file');
      await files.put(file('file_f1', bytes), bytes);
      const other = Buffer.from('%PDF-1.4 the other business');
      await files.put(file('file_f_b', other, 'biz_b'), other);

      await store.insertDraft(draft('fact_up_1', 'file_f1'));
      await store.insertDraft(draft('fact_up_2', 'file_f1', { kind: 'policy', key: 'pickup_window', value: { minutes: 25 }, confidence: 0.85 }));
      expect(await rows('select business_id, kind, key, value, source_type, source_ref, file_id, status, confidence::float as confidence, version, verified_at, verified_by from business_facts where id = $1', ['fact_up_1']))
        .toEqual([{ business_id: 'biz_a', kind: 'menu_item', key: 'item:fact_up_1', value: { itemName: 'Pizza', priceMinor: 2100, currency: 'USD' }, source_type: 'upload', source_ref: 'page 1',
          file_id: 'file_f1', status: 'draft', confidence: 0.92, version: 1, verified_at: null, verified_by: null }]);

      await expect(store.insertDraft(draft('fact_up_v', 'file_f1', { status: 'verified', verifiedAt: NOW() }))).rejects.toThrow('draft facts only');
      await expect(store.insertDraft(draft('fact_up_c', 'file_f1', { sourceType: 'owner_chat' }))).rejects.toThrow('sourceType "upload"');
      const { fileId: _none, ...noFile } = draft('fact_up_n', 'file_f1');
      await expect(store.insertDraft(noFile)).rejects.toThrow('fileId');
      // A file of another business, or no such file: nothing is inserted.
      await expect(store.insertDraft(draft('fact_up_x', 'file_f_b'))).rejects.toThrow('unknown file');
      await expect(store.insertDraft(draft('fact_up_y', 'file_missing'))).rejects.toThrow('unknown file');
      expect(await rows("select id from business_facts where id in ('fact_up_v','fact_up_c','fact_up_n','fact_up_x','fact_up_y')")).toEqual([]);

      expect(await store.get('biz_a', 'fact_up_1')).toMatchObject({ id: 'fact_up_1', fileId: 'file_f1', status: 'draft', sourceType: 'upload', confidence: 0.92, version: 1 });
      expect((await store.get('biz_a', 'fact_up_1'))?.verifiedAt).toBeUndefined();
      expect(await store.get('biz_b', 'fact_up_1')).toBeUndefined();
      // A fact that did not come from an upload is not this store's to read.
      expect(await store.get('biz_a', 'fact_a1')).toBeUndefined();
      expect((await store.listByFile('biz_a', 'file_f1')).map((f) => f.id)).toEqual(['fact_up_1', 'fact_up_2']);
      expect(await store.listByFile('biz_b', 'file_f1')).toEqual([]);
    });

    it('supersedeDraft writes nothing: the schema has no superseded state for a fact that was never verified', async () => {
      const store = dbUploadFactStore(h.db);
      expect(await store.supersedeDraft('biz_a', 'fact_up_1', NOW())).toBeUndefined();
      expect(await rows('select status from business_facts where id = $1', ['fact_up_1'])).toEqual([{ status: 'draft' }]);
      // The reason, shown on the database itself: the check constraint refuses the move.
      await expect(h.db.query("update business_facts set status = 'superseded' where id = $1 and business_id = $2", ['fact_up_1', 'biz_a'])).rejects.toThrow();
      expect(await rows('select status from business_facts where id = $1', ['fact_up_1'])).toEqual([{ status: 'draft' }]);
    });
  });

  describe('conflicts', () => {
    it('inserts, finds, lists by fact and resolves once, inside one business', async () => {
      const store = dbConflictStore(h.db);
      await store.insert(conflict('cfl_t1', 'item:one', 'fact_up_1'));
      await store.insert(conflict('cfl_t2', 'item:two', 'fact_up_2', { required: false }));
      // One open conflict per business, kind and key (the table's unique index).
      await expect(store.insert(conflict('cfl_t1_again', 'item:one', 'fact_up_1'))).rejects.toThrow();
      // The table's own check: at least two candidates.
      await expect(store.insert({ ...conflict('cfl_t_short', 'item:short', 'fact_up_1'), candidates: [{ sourceType: 'upload', value: 1 }] })).rejects.toThrow();

      expect(await store.get('biz_a', 'cfl_t1')).toMatchObject({ id: 'cfl_t1', businessId: 'biz_a', kind: 'menu_item', key: 'item:one', required: true, state: 'open',
        candidates: [{ factId: 'fact_up_1', sourceType: 'upload', sourceRef: 'page 1', value: { priceMinor: 2100 } }, { sourceType: 'square', sourceRef: 'cat_a1', value: { priceMinor: 2000 } }] });
      expect(await store.get('biz_b', 'cfl_t1')).toBeUndefined();
      expect((await store.findOpen('biz_a', 'menu_item', 'item:one'))?.id).toBe('cfl_t1');
      expect(await store.findOpen('biz_b', 'menu_item', 'item:one')).toBeUndefined();
      expect(await store.findOpen('biz_a', 'policy', 'item:one')).toBeUndefined();
      expect((await store.listOpen('biz_a')).map((c) => c.id)).toEqual(['cfl_t1', 'cfl_t2']);
      expect(await store.listOpen('biz_b')).toEqual([]);
      expect((await store.listByFactIds('biz_a', ['fact_up_2', 'fact_nope'])).map((c) => c.id)).toEqual(['cfl_t2']);
      expect((await store.listByFactIds('biz_a', ['fact_up_1', 'fact_up_2'])).map((c) => c.id)).toEqual(['cfl_t1', 'cfl_t2']);
      expect(await store.listByFactIds('biz_b', ['fact_up_1'])).toEqual([]);
      expect(await store.listByFactIds('biz_a', [])).toEqual([]);

      expect(await store.resolve('biz_b', 'cfl_t1', { resolvedBy: 'usr_b', resolvedAt: NOW() })).toBeUndefined();
      const resolved = await store.resolve('biz_a', 'cfl_t1', { resolvedBy: 'usr_a', resolvedAt: NOW() });
      expect(resolved).toMatchObject({ id: 'cfl_t1', state: 'resolved', resolvedBy: 'usr_a' });
      expect(resolved?.resolvedAt).toBeDefined();
      expect(resolved?.resolvedFactId).toBeUndefined();
      expect(await store.resolve('biz_a', 'cfl_t1', { resolvedBy: 'usr_a', resolvedAt: NOW() })).toBeUndefined();
      expect(await store.findOpen('biz_a', 'menu_item', 'item:one')).toBeUndefined();
      expect((await store.listOpen('biz_a')).map((c) => c.id)).toEqual(['cfl_t2']);
      // A resolved conflict frees the key for a later one.
      await store.insert(conflict('cfl_t3', 'item:one', 'fact_up_1'));
      expect((await store.resolve('biz_a', 'cfl_t3', { resolvedBy: 'usr_a', resolvedAt: NOW(), resolvedFactId: 'fact_a1' }))?.resolvedFactId).toBe('fact_a1');
    });
  });

  it('the catalog reader returns the variations of one business only', async () => {
    const reader = dbCatalogReader(h.db);
    const a = await reader.listVariations('biz_a');
    expect(a).toEqual([1, 2, 3].map((i) => ({ id: `cat_a${i}`, businessId: 'biz_a', squareItemId: 'ITEM_a', squareVariationId: `VAR_a${i}`, itemName: 'Pizza a', variationName: String(i), priceMinor: i * 100, currency: 'USD' })));
    expect((await reader.listVariations('biz_b')).every((r) => r.businessId === 'biz_b')).toBe(true);
    expect(await reader.listVariations('biz_missing')).toEqual([]);
  });

  it('the event sink writes the contract event on the database clock', async () => {
    const sink = dbExtractionEventSink(h.db);
    await sink.write({ id: 'evt_extract_1', businessId: 'biz_a', type: 'extraction.completed', correlationId: 'file_t1', actorType: 'system',
      occurredAt: new Date(Date.now() - 3_600_000).toISOString(), payload: { fileId: 'file_t1', mime: 'application/pdf', extractionState: 'EXTRACTED', draftFactCount: 2, conflictCount: 1 } });
    const [row] = await rows("select business_id, type, correlation_id, actor_type, payload, extract(epoch from (clock_timestamp() - occurred_at))::float as age from activity_events where id = 'evt_extract_1'");
    expect(row).toMatchObject({ business_id: 'biz_a', type: 'extraction.completed', correlation_id: 'file_t1', actor_type: 'system',
      payload: { fileId: 'file_t1', mime: 'application/pdf', extractionState: 'EXTRACTED', draftFactCount: 2, conflictCount: 1 } });
    expect(row!.age as number).toBeGreaterThanOrEqual(0);
    expect(row!.age as number).toBeLessThan(60);
    // An event that is not a contract event is refused, not stored.
    await expect(sink.write({ id: 'evt_extract_bad', businessId: 'biz_a', type: 'extraction.completed', correlationId: 'file_t1', actorType: 'system', occurredAt: NOW(), payload: { fileId: 'file_t1' } } as never)).rejects.toThrow();
    expect(await rows("select id from activity_events where id = 'evt_extract_bad'")).toEqual([]);
  });

  it('the option carries every store and, only when given, the extractor', () => {
    expect(Object.keys(dbExtractionOptions(h.db)).sort()).toEqual(['catalog', 'conflicts', 'events', 'facts', 'files']);
    const extractor = { kind: 'recorded' as const, async extract() { return { facts: [] }; } };
    expect(dbExtractionOptions(h.db, extractor).extractor).toBe(extractor);
  });
});

import { createHash } from 'node:crypto';
import type { BusinessFact } from '../pending-contracts';
import type { BusinessKnowledge } from '../session/knowledge';
import { isoZ } from '../time';
import { apiError, newId } from '../util';
import { detectConflict, serviceKeyFor } from './conflicts';
import { checkUpload, decodeCsv } from './file-check';
import { ExtractorUnavailable, type DocumentExtractor, type ExtractionInput } from './model';
import { sanitizeExtraction } from './sanitize';
import { readXlsxRows, ROW_LIMITS } from './spreadsheet';
import type { ActivityEventSink, CatalogReader, ConflictStore, FileStore, StoredFile, UploadFactStore } from './stores';
import { XLSX_MIME, type ExtractionActivityEvent, type FactConflict, type FileRecord } from './types';

// Upload, extraction and conflict resolution (API.md 3.2 and 3.12).
//
// Extraction runs after the upload response. It reads the stored bytes, makes
// one extractor call, sanitizes the output, saves every fact as a draft with
// sourceType "upload", opens conflicts, and ends with an extraction.completed
// event. Nothing here verifies a fact, and nothing here calls Square, a
// message channel, Calendar or Sheets.

export interface ExtractionLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ExtractionServiceDeps {
  files: FileStore;
  facts: UploadFactStore;
  conflicts: ConflictStore;
  catalog: CatalogReader;
  knowledge: BusinessKnowledge;
  extractor: DocumentExtractor;
  events: ActivityEventSink;
  now: () => Date;
  log?: ExtractionLogger;
}

const silent: ExtractionLogger = { info() {}, warn() {} };

// The failure messages a file can end with. Fixed strings only.
const FAILURE = {
  provider: 'The extraction service did not answer. Try the upload again.',
  unreadable: 'The file could not be read.',
  internal: 'Extraction failed.',
} as const;

export class ExtractionService {
  private readonly pending = new Set<Promise<void>>();
  private readonly log: ExtractionLogger;

  constructor(private readonly deps: ExtractionServiceDeps) {
    this.log = deps.log ?? silent;
  }

  // Resolves when every queued extraction has finished. For tests.
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  async upload(input: { businessId: string; ownerId: string; fileName: string | undefined; declaredMime: string | undefined; bytes: Buffer }): Promise<FileRecord> {
    const checked = await checkUpload(input);
    const sha256 = `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`;

    // unique (business_id, sha256): the same file is not extracted twice. A
    // repeat upload answers with the existing record; a failed one runs again.
    const existing = await this.deps.files.findBySha(input.businessId, sha256);
    if (existing) {
      if (existing.record.extractionState === 'FAILED') {
        await this.deps.files.setState(input.businessId, existing.record.id, 'PENDING');
        this.queue(input.businessId, existing.record.id);
      }
      return this.view(input.businessId, existing.record.id);
    }

    const id = newId('file_');
    const stored: StoredFile = {
      record: {
        id,
        businessId: input.businessId,
        name: checked.name,
        mime: checked.mime,
        sizeBytes: input.bytes.length,
        sha256,
        extractionState: 'PENDING',
        createdAt: isoZ(this.deps.now()),
      },
      storagePath: `${input.businessId}/${id}`,
      uploadedBy: input.ownerId,
    };
    await this.deps.files.put(stored, input.bytes);
    this.queue(input.businessId, id);
    return this.view(input.businessId, id);
  }

  async get(businessId: string, id: string): Promise<FileRecord> {
    return this.view(businessId, id);
  }

  private async view(businessId: string, id: string): Promise<FileRecord> {
    const stored = await this.deps.files.get(businessId, id);
    if (!stored) throw apiError('NOT_FOUND', 'File not found.');
    const record: FileRecord = { ...stored.record, draftFactIds: [] };
    if (stored.record.extractionState === 'EXTRACTED') {
      const drafts = await this.deps.facts.listByFile(businessId, id);
      record.draftFactIds = drafts.map((f) => f.id);
      record.conflictIds = (await this.deps.conflicts.listByFactIds(businessId, record.draftFactIds)).map((c) => c.id);
    }
    return record;
  }

  private queue(businessId: string, fileId: string) {
    const job = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.run(businessId, fileId))
      .catch(() => undefined)
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  private async inputFor(stored: StoredFile, bytes: Buffer): Promise<ExtractionInput> {
    const { name, mime } = stored.record;
    if (mime === 'text/csv') {
      const rows = decodeCsv(bytes)
        .slice(0, ROW_LIMITS.rowsPerSheet)
        .map((r) => r.slice(0, ROW_LIMITS.cellsPerRow).map((c) => c.slice(0, ROW_LIMITS.charsPerCell)));
      return { form: 'rows', fileName: name, mime, sheets: [{ sheet: 'csv', rows }] };
    }
    if (mime === XLSX_MIME) return { form: 'rows', fileName: name, mime, sheets: await readXlsxRows(bytes) };
    return { form: 'file', fileName: name, mime, base64: bytes.toString('base64') };
  }

  async run(businessId: string, fileId: string): Promise<void> {
    const stored = await this.deps.files.get(businessId, fileId);
    if (!stored || stored.record.extractionState !== 'PENDING') return;
    await this.deps.files.setState(businessId, fileId, 'EXTRACTING');
    const started = Date.now();
    try {
      const bytes = await this.deps.files.readBytes(businessId, fileId);
      if (!bytes) throw new UnreadableFile();
      let input: ExtractionInput;
      try {
        input = await this.inputFor(stored, bytes);
      } catch {
        throw new UnreadableFile();
      }
      const raw = await this.deps.extractor.extract(input);
      const candidates = sanitizeExtraction(raw);

      const context = await this.deps.knowledge.getContext(businessId);
      const verifiedFacts = context?.verifiedFacts ?? [];
      const catalog = await this.deps.catalog.listVariations(businessId);

      let draftFactCount = 0;
      let conflictCount = 0;
      for (const candidate of candidates) {
        const at = isoZ(this.deps.now());
        const key = candidate.kind === 'service' ? (serviceKeyFor(candidate.value, verifiedFacts) ?? candidate.key) : candidate.key;
        const fact: BusinessFact = {
          id: newId('fact_'),
          businessId,
          kind: candidate.kind,
          key,
          value: candidate.value,
          sourceType: 'upload',
          sourceRef: candidate.sourceRef,
          fileId,
          status: 'draft',
          confidence: candidate.confidence,
          version: 1,
          createdAt: at,
          updatedAt: at,
        };
        await this.deps.facts.insertDraft(fact);
        draftFactCount += 1;

        const found = detectConflict(fact, { catalog, verifiedFacts });
        // At most one open conflict per business, kind and key. A second
        // disagreeing draft for the same key stays a draft without its own.
        if (found && !(await this.deps.conflicts.findOpen(businessId, fact.kind, fact.key))) {
          const conflict: FactConflict = {
            id: newId('cfl_'),
            businessId,
            kind: fact.kind,
            key: fact.key,
            required: found.required,
            candidates: [{ factId: fact.id, sourceType: 'upload', sourceRef: fact.sourceRef, value: fact.value }, found.authority],
            state: 'open',
            createdAt: at,
          };
          await this.deps.conflicts.insert(conflict);
          conflictCount += 1;
        }
      }
      await this.deps.files.setState(businessId, fileId, 'EXTRACTED');
      this.log.info(
        { fileId, mime: stored.record.mime, extractor: this.deps.extractor.kind, draftFactCount, conflictCount, ms: Date.now() - started },
        'extraction completed',
      );
      await this.completed(stored, 'EXTRACTED', draftFactCount, conflictCount);
    } catch (error) {
      const reason = error instanceof ExtractorUnavailable ? FAILURE.provider : error instanceof UnreadableFile ? FAILURE.unreadable : FAILURE.internal;
      await this.deps.files.setState(businessId, fileId, 'FAILED', reason);
      // Only our own fixed reason and the error class name, never its message
      // or any document text.
      this.log.warn({ fileId, mime: stored.record.mime, reason, error: (error as Error)?.name ?? 'unknown' }, 'extraction failed');
      await this.completed(stored, 'FAILED', 0, 0);
    }
  }

  private async completed(stored: StoredFile, extractionState: 'EXTRACTED' | 'FAILED', draftFactCount: number, conflictCount: number) {
    const event: ExtractionActivityEvent = {
      id: newId('evt_'),
      businessId: stored.record.businessId,
      type: 'extraction.completed',
      correlationId: stored.record.id,
      actorType: 'system',
      occurredAt: isoZ(this.deps.now()),
      payload: { fileId: stored.record.id, mime: stored.record.mime, extractionState, draftFactCount, conflictCount },
    };
    try {
      await this.deps.events.write(event);
    } catch {
      this.log.warn({ fileId: stored.record.id }, 'extraction.completed event was not written');
    }
  }

  // POST /api/conflicts/:id/resolve with { resolution: "keep_authoritative" }.
  // Marks the conflict resolved and the uploaded draft superseded. Nothing
  // external is written, so no approval is needed (SPEC 2.9).
  async resolveConflict(input: { businessId: string; ownerId: string; conflictId: string }): Promise<FactConflict> {
    const conflict = await this.deps.conflicts.get(input.businessId, input.conflictId);
    if (!conflict) throw apiError('NOT_FOUND', 'Conflict not found.');
    if (conflict.state !== 'open') throw apiError('INVALID_STATE', 'This conflict is already resolved.', { state: conflict.state });

    const at = isoZ(this.deps.now());
    const draftCandidate = conflict.candidates.find((c) => c.sourceType === 'upload' && c.factId);
    const authority = conflict.candidates.find((c) => c !== draftCandidate);
    // resolvedFactId is empty when the Square value is kept (DATA-MODEL.md
    // 2.8). When the authority is a verified fact, it names that fact.
    const resolvedFactId = authority && authority.sourceType !== 'square' ? authority.factId : undefined;

    const resolved = await this.deps.conflicts.resolve(input.businessId, conflict.id, {
      resolvedBy: input.ownerId,
      resolvedAt: at,
      ...(resolvedFactId ? { resolvedFactId } : {}),
    });
    if (!resolved) throw apiError('INVALID_STATE', 'This conflict is already resolved.', { state: 'resolved' });

    if (draftCandidate?.factId) {
      const superseded = await this.deps.facts.supersedeDraft(input.businessId, draftCandidate.factId, at);
      if (superseded) {
        const event: ExtractionActivityEvent = {
          id: newId('evt_'),
          businessId: input.businessId,
          type: 'fact.changed',
          correlationId: conflict.id,
          actorType: 'owner',
          occurredAt: at,
          payload: {
            factId: superseded.id,
            kind: superseded.kind,
            key: superseded.key,
            fromVersion: superseded.version,
            toVersion: superseded.version,
            sourceType: superseded.sourceType,
          },
        };
        try {
          await this.deps.events.write(event);
        } catch {
          this.log.warn({ conflictId: conflict.id }, 'fact.changed event was not written');
        }
      }
    }
    return resolved;
  }
}

class UnreadableFile extends Error {
  constructor() {
    super('unreadable file');
    this.name = 'UnreadableFile';
  }
}

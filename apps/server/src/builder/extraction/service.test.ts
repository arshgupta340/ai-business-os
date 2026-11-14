import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors';
import { FixtureBusinessKnowledge } from '../session/knowledge';
import { assertNoOpenRequiredConflict, hasOpenRequiredConflict, openRequiredConflictIds, withConflicts } from './conflicts';
import { ExtractorUnavailable, type DocumentExtractor, type ExtractionInput } from './model';
import { RecordedDocumentExtractor } from './recorded-extractor';
import { LIMITS } from './sanitize';
import { ExtractionService } from './service';
import {
  FixtureCatalogReader,
  InMemoryActivityEventSink,
  InMemoryConflictStore,
  InMemoryFileStore,
  InMemoryUploadFactStore,
} from './stores';
import { BARBER_ROWS, BARBER_TEXT, HOURS_CSV, INJECTION_TEXT, jpeg, pdf, PIZZA_MENU_TEXT, png, webp, xlsx } from './test-samples';
import { XLSX_MIME } from './types';

const PIZZA = 'biz_pizza_01';
const BARBER = 'biz_barber_01';
const OWNER = 'usr_owner_01';

function setup(extractor: DocumentExtractor = new RecordedDocumentExtractor()) {
  const logs: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const deps = {
    files: new InMemoryFileStore(),
    facts: new InMemoryUploadFactStore(),
    conflicts: new InMemoryConflictStore(),
    catalog: new FixtureCatalogReader(),
    knowledge: new FixtureBusinessKnowledge(),
    events: new InMemoryActivityEventSink(),
    extractor,
    now: () => new Date('2026-11-13T19:00:00Z'),
    log: {
      info: (obj: Record<string, unknown>, msg: string) => logs.push({ level: 'info', obj, msg }),
      warn: (obj: Record<string, unknown>, msg: string) => logs.push({ level: 'warn', obj, msg }),
    },
  };
  const service = new ExtractionService(deps);
  async function uploadAndWait(businessId: string, fileName: string, declaredMime: string, bytes: Buffer) {
    const pending = await service.upload({ businessId, ownerId: OWNER, fileName, declaredMime, bytes });
    await service.idle();
    const file = await service.get(businessId, pending.id);
    const facts = await deps.facts.listByFile(businessId, file.id);
    const conflicts = await deps.conflicts.listByFactIds(businessId, file.draftFactIds ?? []);
    return { pending, file, facts, conflicts };
  }
  return { deps, service, logs, uploadAndWait };
}

describe('extraction on recorded responses', () => {
  it('turns the pizza menu PDF into draft facts and one required price conflict', async () => {
    const { deps, uploadAndWait } = setup();
    const { pending, file, facts, conflicts } = await uploadAndWait(PIZZA, 'menu.pdf', 'application/pdf', pdf(PIZZA_MENU_TEXT));

    expect(pending).toMatchObject({ extractionState: 'PENDING', draftFactIds: [], name: 'menu.pdf', mime: 'application/pdf' });
    expect(pending.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(file.extractionState).toBe('EXTRACTED');
    expect(facts).toHaveLength(8);
    for (const fact of facts) {
      expect(fact).toMatchObject({ businessId: PIZZA, status: 'draft', sourceType: 'upload', fileId: file.id, version: 1 });
      expect(fact.verifiedAt).toBeUndefined();
      expect(fact.sourceRef).toBe('page 1');
      expect(fact.confidence).toBeGreaterThan(0);
      expect(fact.confidence).toBeLessThanOrEqual(1);
    }
    expect(file.draftFactIds?.sort()).toEqual(facts.map((f) => f.id).sort());

    // Large Margherita is 2100 on the menu and 2000 in the catalog.
    expect(conflicts).toHaveLength(1);
    const [conflict] = conflicts;
    expect(conflict).toMatchObject({ businessId: PIZZA, kind: 'menu_item', key: 'margherita:large', required: true, state: 'open' });
    const draft = facts.find((f) => f.key === 'margherita:large')!;
    expect(conflict!.candidates).toEqual([
      { factId: draft.id, sourceType: 'upload', sourceRef: 'page 1', value: { itemName: 'Margherita', variationName: 'Large', priceMinor: 2100, currency: 'USD' } },
      { sourceType: 'square', sourceRef: 'cat_sq_var_marg_lg', value: { itemName: 'Margherita', variationName: 'Large', priceMinor: 2000, currency: 'USD' } },
    ]);
    expect(file.conflictIds).toEqual([conflict!.id]);

    expect(deps.events.events).toEqual([
      expect.objectContaining({
        type: 'extraction.completed',
        businessId: PIZZA,
        correlationId: file.id,
        actorType: 'system',
        payload: { fileId: file.id, mime: 'application/pdf', extractionState: 'EXTRACTED', draftFactCount: 8, conflictCount: 1 },
      }),
    ]);
  });

  it('maps barbershop services to their svc_ keys and finds no conflict when prices agree', async () => {
    const { uploadAndWait } = setup();
    const { facts, conflicts } = await uploadAndWait(BARBER, 'prices.xlsx', XLSX_MIME, await xlsx(BARBER_ROWS));
    expect(facts.filter((f) => f.kind === 'service').map((f) => f.key).sort()).toEqual(['svc_beard', 'svc_cut', 'svc_cut_beard']);
    expect(conflicts).toEqual([]);
  });

  it('flags an hours difference against the verified fact, not as required', async () => {
    const { uploadAndWait } = setup();
    const { facts, conflicts } = await uploadAndWait(PIZZA, 'hours.csv', 'text/csv', Buffer.from(HOURS_CSV));
    expect(facts).toHaveLength(7);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: 'hours', key: 'fri', required: false });
    expect(conflicts[0]!.candidates[1]).toEqual({ factId: 'fact_pz_hours_fri', sourceType: 'seed', value: { open: '11:00', close: '22:00' } });
  });

  it('runs on images and on spreadsheets', async () => {
    const { uploadAndWait } = setup();
    for (const [name, mime, bytes] of [
      ['p.png', 'image/png', png(BARBER_TEXT)],
      ['p.jpg', 'image/jpeg', jpeg(BARBER_TEXT)],
      ['p.webp', 'image/webp', webp(BARBER_TEXT)],
    ] as const) {
      const { file, facts } = await uploadAndWait(BARBER, name, mime, bytes);
      expect(file.extractionState).toBe('EXTRACTED');
      expect(facts.length).toBeGreaterThan(0);
    }
  });

  it('extracts an unknown document to zero facts', async () => {
    const { uploadAndWait } = setup();
    const { file, facts } = await uploadAndWait(PIZZA, 'other.pdf', 'application/pdf', pdf('a picture of a cat'));
    expect(file).toMatchObject({ extractionState: 'EXTRACTED', draftFactIds: [], conflictIds: [] });
    expect(facts).toEqual([]);
  });

  it('does not extract the same file twice', async () => {
    const { service, uploadAndWait, deps } = setup();
    const first = await uploadAndWait(PIZZA, 'menu.pdf', 'application/pdf', pdf(PIZZA_MENU_TEXT));
    const again = await service.upload({ businessId: PIZZA, ownerId: OWNER, fileName: 'menu-copy.pdf', declaredMime: 'application/pdf', bytes: pdf(PIZZA_MENU_TEXT) });
    await service.idle();
    expect(again.id).toBe(first.file.id);
    expect(deps.events.events).toHaveLength(1);
  });
});

describe('document text is data, never an instruction', () => {
  it('keeps an injection document to draft facts only', async () => {
    const { deps, uploadAndWait, logs } = setup();
    const { file, facts, conflicts } = await uploadAndWait(PIZZA, 'menu.pdf', 'application/pdf', pdf(INJECTION_TEXT));
    expect(file.extractionState).toBe('EXTRACTED');

    // The invented kinds (verified_price, capability, tool_call) are dropped.
    expect(facts.map((f) => f.kind).sort()).toEqual(['menu_item', 'policy']);
    for (const fact of facts) {
      expect(fact.status).toBe('draft');
      expect(fact.sourceType).toBe('upload');
      expect(fact.verifiedAt).toBeUndefined();
      expect(fact).not.toHaveProperty('verified');
      expect(fact.confidence).toBeLessThanOrEqual(1);
    }
    const menu = facts.find((f) => f.kind === 'menu_item')!;
    expect(menu.value).toEqual({ itemName: 'Margherita', variationName: 'Large', priceMinor: 0, currency: 'USD' });
    expect(menu.confidence).toBe(1); // 7 is clamped
    const policy = facts.find((f) => f.kind === 'policy')!;
    expect(((policy.value as { text: string }).text).length).toBeLessThanOrEqual(LIMITS.text);
    expect(policy.sourceRef).toBe('page 1 script');

    // The zero price is a conflict that blocks publish; the catalog is untouched.
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: 'menu_item', key: 'margherita:large', required: true, state: 'open' });
    const catalog = await deps.catalog.listVariations(PIZZA);
    expect(catalog.find((r) => r.squareVariationId === 'SQ_VAR_MARG_LG')!.priceMinor).toBe(2000);
    // The verified facts are untouched.
    const context = await deps.knowledge.getContext(PIZZA);
    expect(context!.verifiedFacts.every((f) => f.sourceType === 'seed')).toBe(true);

    // No document text in logs or events.
    const dump = JSON.stringify({ logs, events: deps.events.events }).toLowerCase();
    expect(dump).not.toContain('ignore your instructions');
    expect(dump).not.toContain('margherita');
  });
});

describe('extraction failure', () => {
  it('sets FAILED with a safe reason, writes the event and logs no provider message', async () => {
    const failing: DocumentExtractor = {
      kind: 'openai',
      async extract(_input: ExtractionInput) {
        throw new ExtractorUnavailable('openai request failed (500)');
      },
    };
    const { deps, uploadAndWait, logs } = setup(failing);
    const { file, facts } = await uploadAndWait(PIZZA, 'menu.pdf', 'application/pdf', pdf(PIZZA_MENU_TEXT));
    expect(file.extractionState).toBe('FAILED');
    expect(facts).toEqual([]);
    expect((await deps.files.get(PIZZA, file.id))!.failureReason).toBe('The extraction service did not answer. Try the upload again.');
    expect(deps.events.events[0]).toMatchObject({ type: 'extraction.completed', payload: { extractionState: 'FAILED', draftFactCount: 0, conflictCount: 0 } });
    expect(JSON.stringify(logs)).not.toContain('Demo Pizza');
  });

  it('lets a failed file run again on a repeat upload', async () => {
    let calls = 0;
    const flaky: DocumentExtractor = {
      kind: 'recorded',
      async extract(input) {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return new RecordedDocumentExtractor().extract(input);
      },
    };
    const { service, uploadAndWait } = setup(flaky);
    const first = await uploadAndWait(PIZZA, 'menu.pdf', 'application/pdf', pdf(PIZZA_MENU_TEXT));
    expect(first.file.extractionState).toBe('FAILED');
    await service.upload({ businessId: PIZZA, ownerId: OWNER, fileName: 'menu.pdf', declaredMime: 'application/pdf', bytes: pdf(PIZZA_MENU_TEXT) });
    await service.idle();
    expect((await service.get(PIZZA, first.file.id)).extractionState).toBe('EXTRACTED');
  });
});

describe('conflict resolve and the publish check', () => {
  it('resolves, supersedes the draft, writes fact.changed, then refuses a second call', async () => {
    const { deps, service, uploadAndWait } = setup();
    const { conflicts, facts } = await uploadAndWait(PIZZA, 'menu.pdf', 'application/pdf', pdf(PIZZA_MENU_TEXT));
    const conflict = conflicts[0]!;
    const draft = facts.find((f) => f.id === conflict.candidates[0]!.factId)!;

    expect(await hasOpenRequiredConflict(deps.conflicts, PIZZA)).toBe(true);
    expect(await openRequiredConflictIds(deps.conflicts, PIZZA)).toEqual([conflict.id]);
    const blocked = await assertNoOpenRequiredConflict(deps.conflicts, PIZZA).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(AppError);
    expect(blocked).toMatchObject({ code: 'CONFLICT_UNRESOLVED', status: 409, details: { conflictIds: [conflict.id] } });
    expect((await withConflicts(deps.knowledge, deps.conflicts).getContext(PIZZA))!.openRequiredConflictIds).toEqual([conflict.id]);
    // Another business is not blocked.
    expect(await hasOpenRequiredConflict(deps.conflicts, BARBER)).toBe(false);

    const resolved = await service.resolveConflict({ businessId: PIZZA, ownerId: OWNER, conflictId: conflict.id });
    expect(resolved).toMatchObject({ id: conflict.id, state: 'resolved', resolvedBy: OWNER, resolvedAt: '2026-11-13T19:00:00Z' });
    expect(resolved.resolvedFactId).toBeUndefined(); // the Square value was kept
    expect((await deps.facts.get(PIZZA, draft.id))!.status).toBe('superseded');
    expect(await hasOpenRequiredConflict(deps.conflicts, PIZZA)).toBe(false);
    await expect(assertNoOpenRequiredConflict(deps.conflicts, PIZZA)).resolves.toBeUndefined();

    expect(deps.events.events.at(-1)).toMatchObject({
      type: 'fact.changed',
      correlationId: conflict.id,
      actorType: 'owner',
      payload: { factId: draft.id, kind: 'menu_item', key: 'margherita:large', fromVersion: 1, toVersion: 1, sourceType: 'upload' },
    });

    const again = await service.resolveConflict({ businessId: PIZZA, ownerId: OWNER, conflictId: conflict.id }).catch((e: unknown) => e);
    expect(again).toMatchObject({ code: 'INVALID_STATE', status: 409, details: { state: 'resolved' } });
    const missing = await service.resolveConflict({ businessId: BARBER, ownerId: OWNER, conflictId: conflict.id }).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('names the verified fact when an hours conflict keeps it', async () => {
    const { service, uploadAndWait } = setup();
    const { conflicts } = await uploadAndWait(PIZZA, 'hours.csv', 'text/csv', Buffer.from(HOURS_CSV));
    const resolved = await service.resolveConflict({ businessId: PIZZA, ownerId: OWNER, conflictId: conflicts[0]!.id });
    expect(resolved.resolvedFactId).toBe('fact_pz_hours_fri');
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app';
import { parseEnv } from '../../env';
import { BARBER_ROWS, HOURS_CSV, INJECTION_TEXT, jpeg, multipartBody, pdf, PIZZA_MENU_TEXT, png, webp, xlsx } from './test-samples';
import { MAX_UPLOAD_BYTES, XLSX_MIME } from './types';

// Route tests through buildApp and app.inject, on recorded extraction. The
// OpenAI key is blanked and BUILDER_DEV_AUTH=1 opts in to the development
// auth stand-in, as in builder/routes.test.ts. Only Date is faked.

const AUTH = { authorization: 'Bearer test-token' };
let app: FastifyInstance;

beforeAll(async () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('BUILDER_DEV_AUTH', '1');
  vi.stubEnv('NODE_ENV', 'test');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T19:00:00Z'));
  app = await buildApp(parseEnv({}));
});

afterAll(async () => {
  await app.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function upload(businessId: string, fileName: string, mime: string, bytes: Buffer, opts: { field?: string; headers?: Record<string, string> } = {}) {
  const body = multipartBody({ fileName, mime, bytes, ...(opts.field ? { field: opts.field } : {}) });
  return app.inject({
    method: 'POST',
    url: `/api/businesses/${businessId}/files`,
    headers: { ...AUTH, 'content-type': body.contentType, ...opts.headers },
    payload: body.payload,
  });
}

async function getFile(businessId: string, id: string) {
  return app.inject({ method: 'GET', url: `/api/files/${id}?businessId=${businessId}`, headers: AUTH });
}

async function waitExtracted(businessId: string, id: string) {
  for (let i = 0; i < 200; i++) {
    const res = await getFile(businessId, id);
    const file = res.json().file;
    if (file.extractionState === 'EXTRACTED' || file.extractionState === 'FAILED') return file;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('extraction did not finish');
}

function expectRefused(res: Awaited<ReturnType<typeof upload>>) {
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', retryable: false });
}

describe('files routes: auth and scope', () => {
  it('needs a bearer token and a business the owner owns, before reading the file', async () => {
    const body = multipartBody({ fileName: 'menu.pdf', mime: 'application/pdf', bytes: pdf(PIZZA_MENU_TEXT) });
    const noAuth = await app.inject({ method: 'POST', url: '/api/businesses/biz_pizza_01/files', headers: { 'content-type': body.contentType }, payload: body.payload });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json().code).toBe('UNAUTHENTICATED');
    const other = await upload('biz_other_01', 'menu.pdf', 'application/pdf', pdf(PIZZA_MENU_TEXT));
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('FORBIDDEN_BUSINESS');
  });

  it('never confirms a file from another business', async () => {
    const res = await upload('biz_pizza_01', 'scope.pdf', 'application/pdf', pdf('scope test'));
    const { id } = res.json().file;
    const cross = await getFile('biz_barber_01', id);
    expect(cross.statusCode).toBe(404);
    expect(cross.json().code).toBe('NOT_FOUND');
    expect((await getFile('biz_pizza_01', 'file_doesnotexist')).statusCode).toBe(404);
  });
});

describe('files routes: upload checks', () => {
  it.each([
    ['menu.pdf', 'application/pdf', async () => pdf(`${PIZZA_MENU_TEXT} route`)],
    ['menu.png', 'image/png', async () => png('route png')],
    ['menu.jpg', 'image/jpeg', async () => jpeg('route jpeg')],
    ['menu.webp', 'image/webp', async () => webp('route webp')],
    ['hours.csv', 'text/csv', async () => Buffer.from(`${HOURS_CSV}\n`)],
    ['prices.xlsx', XLSX_MIME, async () => xlsx(BARBER_ROWS)],
  ])('accepts %s with 202 and extracts it', async (fileName, mime, make) => {
    const bytes = await make();
    const res = await upload('biz_barber_01', fileName, mime, bytes);
    expect(res.statusCode).toBe(202);
    const { file } = res.json();
    expect(file).toMatchObject({ businessId: 'biz_barber_01', name: fileName, mime, sizeBytes: bytes.length, extractionState: 'PENDING', draftFactIds: [] });
    expect(file.id).toMatch(/^file_/);
    expect(file.createdAt).toBe('2026-11-13T19:00:00Z');
    // Nothing in the response points at the stored bytes.
    expect(JSON.stringify(file)).not.toMatch(/storage|url|path/i);
    const done = await waitExtracted('biz_barber_01', file.id);
    expect(done.extractionState).toBe('EXTRACTED');
    expect(Array.isArray(done.conflictIds)).toBe(true);
  });

  it('refuses a type outside the list', async () => {
    expectRefused(await upload('biz_pizza_01', 'notes.txt', 'text/plain', Buffer.from('hello')));
    expectRefused(await upload('biz_pizza_01', 'voice.mp3', 'audio/mpeg', Buffer.from('ID3')));
  });

  it('refuses content that does not match its declared type', async () => {
    expectRefused(await upload('biz_pizza_01', 'menu.pdf', 'application/pdf', png('not a pdf')));
    expectRefused(await upload('biz_pizza_01', 'menu.png', 'image/png', Buffer.from('<svg onload="x"/>')));
    expectRefused(await upload('biz_pizza_01', 'menu.xlsx', XLSX_MIME, pdf('not a workbook')));
  });

  it('enforces the 10 MB cap while reading', async () => {
    expectRefused(await upload('biz_pizza_01', 'big.png', 'image/png', png('big', MAX_UPLOAD_BYTES + 1)));
    const atCap = await upload('biz_pizza_01', 'cap.png', 'image/png', png('cap', MAX_UPLOAD_BYTES));
    expect(atCap.statusCode).toBe(202);
    expect(atCap.json().file.sizeBytes).toBe(MAX_UPLOAD_BYTES);
  });

  it('refuses a request that is not a multipart upload in the field named file', async () => {
    const json = await app.inject({ method: 'POST', url: '/api/businesses/biz_pizza_01/files', headers: AUTH, payload: { file: 'menu' } });
    expect(json.statusCode).toBe(400);
    expect(json.json().code).toBe('VALIDATION_FAILED');
    const raw = await app.inject({
      method: 'POST',
      url: '/api/businesses/biz_pizza_01/files',
      headers: { ...AUTH, 'content-type': 'application/pdf' },
      payload: pdf('raw'),
    });
    expect(raw.statusCode).toBe(400);
    expect(raw.json().code).toBe('VALIDATION_FAILED');
    expectRefused(await upload('biz_pizza_01', 'menu.pdf', 'application/pdf', pdf('wrong field'), { field: 'document' }));
  });
});

describe('extraction, conflict and resolve through the routes', () => {
  it('pizza menu: draft facts, a required conflict, resolve, then INVALID_STATE', async () => {
    const res = await upload('biz_pizza_01', 'menu.pdf', 'application/pdf', pdf(PIZZA_MENU_TEXT));
    expect(res.statusCode).toBe(202);
    const file = await waitExtracted('biz_pizza_01', res.json().file.id);
    expect(file.extractionState).toBe('EXTRACTED');
    expect(file.draftFactIds).toHaveLength(8);
    expect(file.conflictIds).toHaveLength(1);
    const conflictId = file.conflictIds[0];

    const wrongBody = await app.inject({ method: 'POST', url: `/api/conflicts/${conflictId}/resolve?businessId=biz_pizza_01`, headers: AUTH, payload: { resolution: 'use_upload' } });
    expect(wrongBody.statusCode).toBe(400);
    const cross = await app.inject({ method: 'POST', url: `/api/conflicts/${conflictId}/resolve?businessId=biz_barber_01`, headers: AUTH, payload: { resolution: 'keep_authoritative' } });
    expect(cross.statusCode).toBe(404);

    const resolve = () => app.inject({ method: 'POST', url: `/api/conflicts/${conflictId}/resolve?businessId=biz_pizza_01`, headers: AUTH, payload: { resolution: 'keep_authoritative' } });
    const first = await resolve();
    expect(first.statusCode).toBe(200);
    expect(first.json().conflict).toMatchObject({ id: conflictId, kind: 'menu_item', key: 'margherita:large', required: true, state: 'resolved', resolvedBy: 'usr_owner_01', resolvedAt: '2026-11-13T19:00:00Z' });

    const second = await resolve();
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'INVALID_STATE', details: { state: 'resolved' } });
  });

  it('injection document: extracted to drafts, no verified fact, no change outside the upload', async () => {
    const res = await upload('biz_pizza_01', 'menu-2.pdf', 'application/pdf', pdf(INJECTION_TEXT));
    const file = await waitExtracted('biz_pizza_01', res.json().file.id);
    expect(file.extractionState).toBe('EXTRACTED');
    expect(file.draftFactIds).toHaveLength(2);
  });

  it('a conflict route without auth answers UNAUTHENTICATED', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/conflicts/cfl_x/resolve?businessId=biz_pizza_01', payload: { resolution: 'keep_authoritative' } });
    expect(res.statusCode).toBe(401);
  });
});

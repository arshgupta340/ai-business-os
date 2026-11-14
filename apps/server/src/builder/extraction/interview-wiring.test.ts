import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import { parseEnv } from '../../env';
import { PIZZA_MENU_TEXT, multipartBody, pdf } from './test-samples';

// An uploaded menu price that disagrees with the catalog must reach the
// builder interview as a stop condition, so the owner cannot continue to
// publish with an open required conflict.
describe('upload conflicts reach the builder interview', () => {
  const saved = { dev: process.env.BUILDER_DEV_AUTH, node: process.env.NODE_ENV, key: process.env.OPENAI_API_KEY };
  beforeEach(() => {
    process.env.BUILDER_DEV_AUTH = '1';
    process.env.NODE_ENV = 'test';
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    for (const [name, value] of [['BUILDER_DEV_AUTH', saved.dev], ['NODE_ENV', saved.node], ['OPENAI_API_KEY', saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('adds open_conflict to the stop conditions after a conflicting upload, and removes it after resolve', async () => {
    const app = await buildApp(parseEnv({}));
    const auth = { authorization: 'Bearer test' };
    const biz = 'biz_pizza_01';

    const created = await app.inject({ method: 'POST', url: `/api/builder/sessions?businessId=${biz}`, headers: auth, payload: {} });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().id ?? created.json().session?.id;

    const turn = async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/builder/sessions/${sessionId}/messages?businessId=${biz}`,
        headers: auth,
        payload: { text: 'I run a pizza shop and want an AI that takes pickup orders.', inputMode: 'text' },
      });
      expect(res.statusCode).toBe(200);
      return res.json().stopConditions as { code: string; conflictIds?: string[] }[];
    };

    expect((await turn()).some((s) => s.code === 'open_conflict')).toBe(false);

    const body = multipartBody({ fileName: 'menu.pdf', mime: 'application/pdf', bytes: pdf(PIZZA_MENU_TEXT) });
    const upload = await app.inject({ method: 'POST', url: `/api/businesses/${biz}/files`, headers: { ...auth, 'content-type': body.contentType }, payload: body.payload });
    expect(upload.statusCode).toBe(202);
    const fileId = upload.json().file.id;

    let conflictIds: string[] = [];
    for (let i = 0; i < 50 && conflictIds.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const file = await app.inject({ method: 'GET', url: `/api/files/${fileId}?businessId=${biz}`, headers: auth });
      conflictIds = file.json().conflictIds ?? file.json().file?.conflictIds ?? [];
    }
    expect(conflictIds.length).toBeGreaterThan(0);

    const blocked = await turn();
    const stop = blocked.find((s) => s.code === 'open_conflict');
    expect(stop?.conflictIds).toEqual(expect.arrayContaining(conflictIds));

    for (const id of conflictIds) {
      const resolved = await app.inject({
        method: 'POST',
        url: `/api/conflicts/${id}/resolve?businessId=${biz}`,
        headers: auth,
        payload: { resolution: 'keep_authoritative' },
      });
      expect(resolved.statusCode).toBe(200);
    }
    expect((await turn()).some((s) => s.code === 'open_conflict')).toBe(false);
    await app.close();
  });
});

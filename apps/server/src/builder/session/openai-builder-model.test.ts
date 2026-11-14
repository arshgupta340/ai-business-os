import { describe, expect, it } from 'vitest';
import { parseBuilderEnv } from '../env';
import { BuilderModelUnavailable } from './model';
import { OpenAiBuilderModel, type ResponsesParseClient } from './openai-builder-model';

// No network. A fake client records the request the real model would send.

const input = { businessName: 'Demo Pizza Co.', ownerText: 'hello', history: [], draftSpec: {}, missingFields: [], knownFacts: [] };

function fakeClient(result: unknown | (() => never)) {
  const calls: unknown[] = [];
  const client = {
    responses: {
      parse: async (body: unknown) => {
        calls.push(body);
        if (typeof result === 'function') (result as () => never)();
        return result;
      },
    },
  } as unknown as ResponsesParseClient;
  return { client, calls };
}

describe('OpenAiBuilderModel (fake client)', () => {
  it('sends a strict json_schema text format and the configured model', async () => {
    const parsed = { reply: 'ok' };
    const { client, calls } = fakeClient({ status: 'completed', output: [], output_parsed: parsed });
    const model = new OpenAiBuilderModel({ apiKey: 'test-key-not-real', model: 'model-under-test' }, client);
    await expect(model.turn(input)).resolves.toEqual(parsed);
    const body = calls[0] as { model: string; text: { format: { type: string; strict: boolean; name: string; schema: { required: string[] } } } };
    expect(body.model).toBe('model-under-test');
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true, name: 'builder_turn' });
    expect(body.text.format.schema.required).toEqual(expect.arrayContaining(['reply', 'capabilityIds', 'unsupportedRequests', 'answers']));
  });

  it('turns a refusal into a no-change reply', async () => {
    const { client } = fakeClient({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }], output_parsed: null });
    const out = (await new OpenAiBuilderModel({ apiKey: 'k', model: 'm' }, client).turn(input)) as { capabilityIds: string[] };
    expect(out.capabilityIds).toEqual([]);
  });

  it('reports a provider error without its message', async () => {
    const { client } = fakeClient(() => {
      throw Object.assign(new Error('Incorrect API key provided: sk-abc123'), { status: 401 });
    });
    const err = await new OpenAiBuilderModel({ apiKey: 'k', model: 'm' }, client).turn(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuilderModelUnavailable);
    expect((err as Error).message).toBe('openai request failed (401)');
  });
});

describe('builder env', () => {
  it('uses recorded responses without a key, and treats a blank key as absent', () => {
    expect(parseBuilderEnv({})).toEqual({ mode: 'recorded' });
    expect(parseBuilderEnv({ OPENAI_API_KEY: '  ' })).toEqual({ mode: 'recorded' });
  });

  it('needs a model ID when a key is set, and never prints the key', () => {
    expect(() => parseBuilderEnv({ OPENAI_API_KEY: 'secret-value-123' })).toThrow(/OPENAI_BUILDER_MODEL is required/);
    try {
      parseBuilderEnv({ OPENAI_API_KEY: 'secret-value-123' });
    } catch (e) {
      expect(String(e)).not.toContain('secret-value-123');
    }
    expect(parseBuilderEnv({ OPENAI_API_KEY: 'k', OPENAI_BUILDER_MODEL: 'm' })).toEqual({ mode: 'openai', apiKey: 'k', model: 'm' });
  });
});

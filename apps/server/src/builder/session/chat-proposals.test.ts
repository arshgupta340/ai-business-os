import { HoursValueSchema, type BusinessFact } from '@abos/contracts';
import { describe, expect, it } from 'vitest';
import { FixtureBusinessKnowledge, type BusinessKnowledge } from './knowledge';
import type { BuilderModel, BuilderTurnOutput } from './model';
import { BuilderSessionService, type ProposeFactFromChat, type ProposeFactFromChatInput } from './service';
import { InMemoryAgentDraftStore, InMemoryBuilderSessionStore, InMemoryDraftFactStore, type BuilderSessionRecord } from './stores';

// Review of 07389a0 (findings 1 to 4): the shape a chat answer proposes, typed
// values, retries and corrections after a failure, and the order of the
// proposal and the session write.

let clock = new Date('2026-11-13T18:00:00Z');
const now = () => clock;

function knowledgeWithout(keys: string[]): BusinessKnowledge {
  const base = new FixtureBusinessKnowledge();
  return {
    async getContext(businessId) {
      const ctx = await base.getContext(businessId);
      return ctx && { ...ctx, verifiedFacts: ctx.verifiedFacts.filter((f) => !(f.kind === 'policy' && keys.includes(f.key))) };
    },
  };
}
const NO_CONSENT = knowledgeWithout(['message_consent']);
const FIXTURES = new FixtureBusinessKnowledge();

// A model that classifies the pizza agent and gives whatever answers the test sets.
function scriptedModel() {
  const state = { answers: [] as BuilderTurnOutput['answers'] };
  const model: BuilderModel = {
    kind: 'recorded',
    turn: async () => ({
      reply: 'Got it.', template: 'restaurant_order_taker', capabilityIds: [], unsupportedRequests: [], confidence: 0.9,
      name: 'Pizza Order Assistant', goal: 'Take pickup orders.', greeting: null, knowledgeScopes: null, answers: state.answers,
    }),
  };
  return { state, model };
}

function recording(outcomes: ('ok' | 'fail')[] = []) {
  const calls: ProposeFactFromChatInput[] = [];
  const propose: ProposeFactFromChat = async (input) => {
    calls.push(structuredClone(input));
    if ((outcomes[calls.length - 1] ?? 'ok') === 'fail') throw new Error('approval engine down');
    return { approvalId: `apv_chat_${calls.length}`, bundleType: 'fact_edit' };
  };
  return { calls, propose };
}

function setup(propose: ProposeFactFromChat, knowledge: BusinessKnowledge, sessions = new InMemoryBuilderSessionStore()) {
  const { state, model } = scriptedModel();
  const draftFacts = new InMemoryDraftFactStore();
  const service = new BuilderSessionService({ sessions, agents: new InMemoryAgentDraftStore(), draftFacts, knowledge, model, now, proposeFactFromChat: propose });
  return { service, draftFacts, sessions, state };
}

async function started(ctx: ReturnType<typeof setup>) {
  const s = await ctx.service.create({ businessId: 'biz_pizza_01', ownerId: 'usr_owner_01' });
  await ctx.service.message('biz_pizza_01', s.id, { text: 'I run a pizza shop.', inputMode: 'text' });
  return s.id;
}

const say = (ctx: ReturnType<typeof setup>, id: string, text = 'answer') => ctx.service.message('biz_pizza_01', id, { text, inputMode: 'text' });
const drafts = (ctx: ReturnType<typeof setup>, id: string) => ctx.draftFacts.listBySession('biz_pizza_01', id);
const verifiedOf = async (kind: string, key: string) =>
  (await FIXTURES.getContext('biz_pizza_01'))!.verifiedFacts.find((f) => f.kind === kind && f.key === key)!;

describe('finding 1: the proposal names its subject', () => {
  it('new key: the subject is the draft row, whose value equals the proposed value, with fromVersion 0 and before null', async () => {
    const r = recording();
    const ctx = setup(r.propose, NO_CONSENT);
    const id = await started(ctx);
    ctx.state.answers = [{ field: 'policy.message_consent', value: 'May we text you the payment link?' }];
    const turn = await say(ctx, id);
    const [draft] = await drafts(ctx, id);
    expect(turn.proposedChange).toEqual({ approvalId: 'apv_chat_1', bundleType: 'fact_edit' });
    expect(r.calls).toEqual([expect.objectContaining({ subjectId: draft!.id, kind: 'policy', key: 'message_consent', value: draft!.value, fromVersion: 0, before: null })]);
  });

  it('existing key: the subject is the verified fact, with its version and value', async () => {
    const r = recording();
    const ctx = setup(r.propose, FIXTURES);
    const id = await started(ctx);
    const verified = await verifiedOf('policy', 'pickup_window');
    ctx.state.answers = [{ field: 'policy.pickup_window', value: '30 minutes' }];
    await say(ctx, id);
    expect(r.calls).toEqual([expect.objectContaining({ subjectId: verified.id, fromVersion: verified.version, before: verified.value, value: { minutes: 30, text: '30 minutes' } })]);
  });
});

describe('finding 2: a proposed value has the shape its readers expect', () => {
  it('an hours edit proposes { open, close } that passes HoursValueSchema, never a text blob', async () => {
    const r = recording();
    const ctx = setup(r.propose, FIXTURES);
    const id = await started(ctx);
    ctx.state.answers = [{ field: 'hours.fri', value: 'Open 11 am until 11 pm.' }];
    const turn = await say(ctx, id);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.value).toEqual({ open: '11:00', close: '23:00' });
    expect(HoursValueSchema.safeParse(r.calls[0]!.value).success).toBe(true);
    expect((await drafts(ctx, id))[0]!.value).toEqual({ open: '11:00', close: '23:00' });
    expect(turn.proposedChange).toBeDefined();
  });

  it('hours it cannot read are refused: no draft, no proposal, and the reply asks again', async () => {
    const r = recording();
    const ctx = setup(r.propose, FIXTURES);
    const id = await started(ctx);
    ctx.state.answers = [{ field: 'hours.fri', value: 'Late-ish, maybe 11 to 11.' }];
    const turn = await say(ctx, id);
    expect(r.calls).toEqual([]);
    expect(await drafts(ctx, id)).toEqual([]);
    expect(turn).not.toHaveProperty('proposedChange');
    expect(turn.reply.text).toContain('am or pm');
  });

  it('minutes and consent answers become { minutes } and { required, wording }', async () => {
    const r = recording();
    const ctx = setup(r.propose, NO_CONSENT);
    const id = await started(ctx);
    ctx.state.answers = [
      { field: 'policy.message_consent', value: 'May we text you the payment link?' },
      { field: 'policy.pickup_window', value: 'About half an hour.' },
    ];
    await say(ctx, id);
    expect(r.calls.map((c) => c.value)).toEqual([
      { required: true, wording: 'May we text you the payment link?' },
      { minutes: 30, text: 'About half an hour.' },
    ]);
  });
});

describe('finding 3: a failure does not stop a retry or a correction', () => {
  it('failure, then the same answer again: the same draft is proposed again', async () => {
    const r = recording(['fail', 'ok']);
    const ctx = setup(r.propose, NO_CONSENT);
    const id = await started(ctx);
    ctx.state.answers = [{ field: 'policy.message_consent', value: 'May we text you?' }];
    const failed = await say(ctx, id);
    expect(failed.reply.text).toContain('still needs your confirmation');
    const retried = await say(ctx, id);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!.subjectId).toBe(r.calls[0]!.subjectId);
    expect(retried.proposedChange).toEqual({ approvalId: 'apv_chat_2', bundleType: 'fact_edit' });
    expect(await drafts(ctx, id)).toHaveLength(1);
  });

  it('failure, then a later turn with no answer: the pending draft is retried', async () => {
    const r = recording(['fail', 'ok']);
    const ctx = setup(r.propose, NO_CONSENT);
    const id = await started(ctx);
    ctx.state.answers = [{ field: 'policy.message_consent', value: 'May we text you?' }];
    await say(ctx, id);
    ctx.state.answers = [];
    const later = await say(ctx, id, 'What else do you need?');
    expect(r.calls).toHaveLength(2);
    expect(later.proposedChange).toEqual({ approvalId: 'apv_chat_2', bundleType: 'fact_edit' });
  });

  it('failure, then a corrected answer: the correction is kept and proposed, and the old draft is not', async () => {
    const r = recording(['fail', 'ok']);
    const ctx = setup(r.propose, NO_CONSENT);
    const id = await started(ctx);
    ctx.state.answers = [{ field: 'policy.message_consent', value: 'Ask first.' }];
    await say(ctx, id);
    ctx.state.answers = [{ field: 'policy.message_consent', value: 'Ask if we may send one text.' }];
    const corrected = await say(ctx, id);
    const all = await drafts(ctx, id);
    expect(all.map((f) => f.value)).toEqual([{ required: true, wording: 'Ask first.' }, { required: true, wording: 'Ask if we may send one text.' }]);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]).toMatchObject({ subjectId: all[1]!.id, value: all[1]!.value });
    expect(corrected.proposedChange).toBeDefined();
  });

  it('success, then a further edit: the edit is proposed; an exact repeat is not', async () => {
    const r = recording();
    const ctx = setup(r.propose, NO_CONSENT);
    const id = await started(ctx);
    ctx.state.answers = [{ field: 'policy.message_consent', value: 'Ask first.' }];
    await say(ctx, id);
    await say(ctx, id);
    expect(r.calls).toHaveLength(1);
    ctx.state.answers = [{ field: 'policy.message_consent', value: 'Ask if we may send one text.' }];
    await say(ctx, id);
    expect(r.calls).toHaveLength(2);
  });

  it('after the 10 minute approval expiry, repeating the answer proposes it again', async () => {
    const r = recording();
    const ctx = setup(r.propose, NO_CONSENT);
    const start = clock;
    try {
      const id = await started(ctx);
      ctx.state.answers = [{ field: 'policy.message_consent', value: 'Ask first.' }];
      await say(ctx, id);
      clock = new Date(start.getTime() + 11 * 60_000);
      const again = await say(ctx, id);
      expect(r.calls).toHaveLength(2);
      expect(r.calls[1]!.subjectId).toBe(r.calls[0]!.subjectId);
      expect(again.proposedChange).toEqual({ approvalId: 'apv_chat_2', bundleType: 'fact_edit' });
    } finally {
      clock = start;
    }
  });

  it('the proposal record is kept off the session the API returns', async () => {
    const r = recording();
    const ctx = setup(r.propose, NO_CONSENT);
    const id = await started(ctx);
    ctx.state.answers = [{ field: 'policy.message_consent', value: 'Ask first.' }];
    const turn = await say(ctx, id);
    expect(turn.reply).not.toHaveProperty('proposals');
    const view = await ctx.service.get('biz_pizza_01', id);
    for (const m of view.messages) expect(m).not.toHaveProperty('proposals');
  });
});

describe('finding 4: proposal and session write', () => {
  it('two identical answers at the same time: one draft, one proposal, and every message is kept', async () => {
    const r = recording();
    const ctx = setup(r.propose, NO_CONSENT);
    const id = await started(ctx);
    ctx.state.answers = [{ field: 'policy.message_consent', value: 'Ask first.' }];
    await Promise.all([say(ctx, id), say(ctx, id)]);
    expect(await drafts(ctx, id)).toHaveLength(1);
    expect(r.calls).toHaveLength(1);
    expect((await ctx.service.get('biz_pizza_01', id)).messages).toHaveLength(7);
  });

  it('a session write that fails before the proposal leaves no approval, and the next turn proposes the draft', async () => {
    class FailingOnce extends InMemoryBuilderSessionStore {
      fail = false;
      override async update(s: BuilderSessionRecord) {
        if (this.fail) {
          this.fail = false;
          throw new Error('database down');
        }
        return super.update(s);
      }
    }
    const sessions = new FailingOnce();
    const r = recording();
    const ctx = setup(r.propose, NO_CONSENT, sessions);
    const id = await started(ctx);
    ctx.state.answers = [{ field: 'policy.message_consent', value: 'Ask first.' }];
    sessions.fail = true;
    await expect(say(ctx, id)).rejects.toThrow('database down');
    expect(r.calls).toEqual([]);
    const next = await say(ctx, id);
    expect(r.calls).toHaveLength(1);
    expect(next.proposedChange).toEqual({ approvalId: 'apv_chat_1', bundleType: 'fact_edit' });
  });

  it('a write that fails after the approval exists: the next turn proposes the same subject again (what remains)', async () => {
    class FailingSecond extends InMemoryBuilderSessionStore {
      count = 0;
      armed = false;
      override async update(s: BuilderSessionRecord) {
        if (this.armed && ++this.count === 2) throw new Error('database down');
        return super.update(s);
      }
    }
    const sessions = new FailingSecond();
    const r = recording();
    const ctx = setup(r.propose, NO_CONSENT, sessions);
    const id = await started(ctx);
    ctx.state.answers = [{ field: 'policy.message_consent', value: 'Ask first.' }];
    sessions.armed = true;
    await expect(say(ctx, id)).rejects.toThrow('database down');
    expect(r.calls).toHaveLength(1);
    // The owner's turn was saved before the proposal.
    expect((await ctx.service.get('biz_pizza_01', id)).messages).toHaveLength(5);
    await say(ctx, id);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!.subjectId).toBe(r.calls[0]!.subjectId);
  });
});

describe('a draft without the option', () => {
  it('without proposeFactFromChat, the owner text is kept as before and nothing is typed', async () => {
    const { model, state } = scriptedModel();
    const draftFacts = new InMemoryDraftFactStore();
    const service = new BuilderSessionService({ sessions: new InMemoryBuilderSessionStore(), agents: new InMemoryAgentDraftStore(), draftFacts, knowledge: NO_CONSENT, model, now });
    const s = await service.create({ businessId: 'biz_pizza_01', ownerId: 'usr_owner_01' });
    await service.message('biz_pizza_01', s.id, { text: 'hi', inputMode: 'text' });
    state.answers = [{ field: 'policy.message_consent', value: 'Ask first.' }];
    await service.message('biz_pizza_01', s.id, { text: 'hi', inputMode: 'text' });
    const facts: BusinessFact[] = await draftFacts.listBySession('biz_pizza_01', s.id);
    expect(facts.map((f) => f.value)).toEqual([{ text: 'Ask first.' }]);
  });
});

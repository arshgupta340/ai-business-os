// PROPOSED text step (SPEC 2.9 "Consent evidence on a phone call"), on the composed server: the phone
// relay with the composed toolset factory, the real approval engine, the executor and the test database
// as abos_app, with the world's fake providers. A caller who says yes to the server's offer gets an
// approval whose hashed payload names their number and the channel; after the owner approves, exactly
// one message goes to that number with the step's stable key. A caller who says no gets none.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvalPayloadHash, idempotencyKey } from '@abos/contracts';
import { PIZZA, VOICE_ENV, approve, captureLog, phoneCall, phoneRelay, pickupAt, steps } from '../adversarial/helpers';
import type { FakeSocket } from '../voice/helpers';
import { ulaw } from '../voice/helpers';
import { createWorld, type World } from './world';

const NUMBER = '+15555553716';
const TRANSCRIPT = 'Yeah, go ahead';
const CART = { lines: [{ catalogItemId: 'SQ_ITEM_PEP', variationId: 'SQ_VAR_PEP_LG', quantity: 1, modifierIds: [] }] };

/** The model plays the queued offer, Twilio confirms playback, and the caller answers in one turn. */
function answerOffer(model: FakeSocket, phone: FakeSocket, transcript: string) {
  model.emit({ type: 'response.created', response: { id: 'resp_offer', metadata: { voiceConsentOffer: '1' } } });
  model.emit({ type: 'response.output_audio.delta', item_id: 'item_offer', delta: ulaw(40) });
  model.emit({ type: 'response.done', response: { id: 'resp_offer', status: 'completed', output: [] } });
  for (const m of phone.ofType('mark')) phone.emit({ event: 'mark', mark: { name: (m.mark as { name: string }).name } });
  model.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item_answer' });
  model.emit({ type: 'input_audio_buffer.committed', item_id: 'item_answer' });
  model.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_answer', content_index: 0, transcript });
}

describe('phone text consent on the composed server', () => {
  let w: World;
  const logs = captureLog();
  beforeAll(async () => { w = await createWorld({ log: logs.log }, VOICE_ENV); }, 120_000);
  afterAll(async () => { await w?.close(); });

  async function callAndPropose(providerCallId: string, said: string) {
    const call = await phoneCall(w, PIZZA, providerCallId);
    call.toolset.dispose();
    const relay = await phoneRelay(call, { logger: logs.log as never, callerNumber: NUMBER });
    await relay.connect();
    const quoted = await relay.toolCall('quote_order', JSON.stringify({ cart: CART }), 'fc_q') as { ok: boolean; quote: { quoteId: string } };
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    const model = relay.models[0]!;
    answerOffer(model, relay.phone, said);
    // The model's own consent flags and number are sent as well, and must be ignored either way.
    const proposed = await relay.toolCall('propose_order', JSON.stringify({ cart: CART, quoteId: quoted.quote.quoteId, fulfillment: { type: 'pickup', pickupAt: pickupAt() },
      contact: { name: 'Sam', messageConsent: true, messageRecipient: '+15555550999', consentAt: new Date().toISOString() } }), 'fc_p') as { ok: boolean; proposalId: string; approvalId: string };
    expect(proposed.ok, JSON.stringify(proposed)).toBe(true);
    await relay.hangUp();
    return { call, relay, model, ...proposed };
  }

  it('a spoken yes: the hashed payload has the recipient and the channel, and one message goes to that recipient with the stable key', async () => {
    const p = await callAndPropose('CA_e2e_text_yes', TRANSCRIPT);
    const row = (await w.t.db.query('select payload, payload_hash from approval_requests where id = $1', [p.approvalId])).rows[0] as { payload: Record<string, unknown>; payload_hash: string };
    expect(row.payload).toMatchObject({ messageRecipient: NUMBER, messageChannel: 'surge' });
    expect(row.payload_hash).toBe(await approvalPayloadHash('order_bundle', row.payload));
    const order = (await w.t.db.query('select contact from orders where id = $1', [p.proposalId])).rows[0] as { contact: Record<string, unknown> };
    expect(order.contact).toMatchObject({ name: 'Sam', messageRecipient: NUMBER, messageConsent: true });

    const before = w.messages.sent.length;
    await approve(w, PIZZA, p.approvalId);
    const sent = w.messages.sent.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(NUMBER);
    const step = (await steps(w, p.approvalId)).find((s) => s.action_type === 'message.checkout.send')!;
    expect(step.status).toBe('SUCCEEDED');
    const key = await idempotencyKey({ businessId: PIZZA, subjectId: p.proposalId, actionType: 'message.checkout.send', approvalId: p.approvalId });
    expect(step.idempotency_key).toBe(key);
    expect(sent[0]!.idempotencyKey).toBe(key);
    // Settling again sends nothing more.
    await w.settle();
    expect(w.messages.sent.length).toBe(before + 1);

    // The full number and the transcript are in no log line and no activity event; the model never got the number.
    const events = JSON.stringify((await w.t.db.query('select payload from activity_events where business_id = $1', [PIZZA])).rows);
    for (const secret of [NUMBER, '5555553716', TRANSCRIPT, 'go ahead']) {
      expect(logs.text().toLowerCase()).not.toContain(secret.toLowerCase());
      expect(events.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(JSON.stringify(p.model.sent)).not.toContain('5555553716');
    expect(JSON.stringify(p.model.sent)).toContain('3 7 1 6');
  });

  it('a spoken no: the approval is qr_only with no recipient, and nothing is sent', async () => {
    const p = await callAndPropose('CA_e2e_text_no', 'No thanks.');
    const row = (await w.t.db.query('select payload from approval_requests where id = $1', [p.approvalId])).rows[0] as { payload: Record<string, unknown> };
    expect(row.payload).toMatchObject({ messageChannel: 'qr_only' });
    expect(row.payload).not.toHaveProperty('messageRecipient');
    const before = w.messages.sent.length;
    await approve(w, PIZZA, p.approvalId);
    expect(w.messages.sent.length).toBe(before);
    const step = (await steps(w, p.approvalId)).find((s) => s.action_type === 'message.checkout.send')!;
    expect(step.status).toBe('SKIPPED');
  });
});

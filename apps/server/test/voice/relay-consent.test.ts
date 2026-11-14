// PROPOSED text step (SPEC 2.9 "Consent evidence on a phone call"), in the relay with the real toolset
// and fake ports. The server makes the offer once, reads the caller's one answer turn itself (the
// server's transcript, or a keypad press) and hands evidence to the toolset only for a proposal.
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_NOW, SQ, barberFacts, barberSpecV1, pizzaCatalog, pizzaSpecV2, serviceHaircut } from '@abos/contracts/fixtures';
import { cartHash, type AgentSpec, type AvailabilitySlot, type Cart, type MessageChannelSetting, type Quote } from '@abos/contracts';
import { createRealToolset } from '../../src/tools/real/index';
import type { RealToolsetPorts } from '../../src/tools/real/types';
import { StreamTokenStore } from '../../src/voice/logic';
import { CONSENT_REASK } from '../../src/voice/prompt';
import { runPhoneRelay } from '../../src/voice/relay';
import type { PinnedCall } from '../../src/voice/types';
import { FakeSocket, PIZZA_SNAPSHOT, fakeCalls, fakeEvents, fakeLogger, ulaw, type Json } from './helpers';

const NUMBER = '+15555553716';
const OFFER = 'Would you like one text message with your payment link, sent to the number you are calling from, ending in 3 7 1 6?';
const TRANSCRIPT = 'Yep, sure thing';

type Opts = { channel?: MessageChannelSetting; callerNumber?: string | null; spec?: AgentSpec; windowMs?: number; facts?: PinnedCall['facts'] };

async function setup(o: Opts = {}) {
  const spec = o.spec ?? pizzaSpecV2;
  const channel = o.channel ?? 'surge';
  const cart: Cart = { lines: [{ catalogItemId: SQ.itemMargherita, variationId: SQ.varMargheritaLarge, quantity: 1, modifierIds: [] }] };
  const quote: Quote = { quoteId: 'qte_consent_01', cartHash: await cartHash(cart), subtotalMinor: 100, taxMinor: 0, totalMinor: 100, currency: 'USD', lines: [{ variationId: SQ.varMargheritaLarge, name: 'Pizza', quantity: 1, unitPriceMinor: 100, modifiers: [], lineTotalMinor: 100 }], quotedAt: FIXTURE_NOW, expiresAt: new Date(Date.parse(FIXTURE_NOW) + 300000).toISOString() };
  const slot: AvailabilitySlot = { serviceId: serviceHaircut.id, startUtc: '2026-11-14T22:00:00Z', endUtc: '2026-11-14T22:30:00Z', timezone: 'America/Los_Angeles' };
  const createOrderProposal = vi.fn<RealToolsetPorts['proposals']['createOrderProposal']>(async () => ({ ok: true, orderId: 'ord_consent_01', approvalId: 'apv_consent_01' }));
  const createBookingProposal = vi.fn<RealToolsetPorts['proposals']['createBookingProposal']>(async () => ({ ok: true, bookingId: 'bkg_consent_01', approvalId: 'apv_consent_02', slot }));
  const ports: RealToolsetPorts = {
    catalog: { search: async () => pizzaCatalog }, quotes: { quote: async () => ({ ok: true, quote }) },
    proposals: { atomicOperations: true, createOrderProposal, createBookingProposal },
    orderStatus: { read: async () => null }, availability: { freeSlots: async () => [slot] },
  };
  const tokens = new StreamTokenStore<PinnedCall>();
  const callerNumber = o.callerNumber === null ? undefined : (o.callerNumber ?? NUMBER);
  const token = tokens.mint({ callId: 'call_consent_01', providerCallId: 'CA123', businessId: spec.businessId, businessName: 'Demo Shop', agentId: spec.id, agentVersionId: 'agv_consent_v1', spec, facts: o.facts ?? PIZZA_SNAPSHOT, ...(callerNumber !== undefined ? { callerNumber } : {}) }) ?? '';
  const phone = new FakeSocket(); const model = new FakeSocket(); const calls = fakeCalls(); const events = fakeEvents();
  const { logger, lines } = fakeLogger();
  const contexts: unknown[] = [];
  const relay = runPhoneRelay({ phone, tokens, calls, events, messageChannel: channel, logger,
    limits: { consentWindowMs: o.windowMs ?? 2000, pendingWaitMs: 60_000 }, openaiSocketFactory: () => model,
    toolsetFactory: (ctx) => {
      contexts.push(ctx);
      return createRealToolset({ businessId: ctx.businessId, messageChannel: channel, ports, capabilities: ctx.capabilities, factsSnapshot: ctx.facts, now: () => new Date(FIXTURE_NOW), consent: ctx.consent });
    },
  });
  phone.emit({ event: 'start', start: { callSid: 'CA123', streamSid: 'MZ1', customParameters: { streamToken: token } } });
  await new Promise((r) => setTimeout(r, 0));
  model.open(); model.emit({ type: 'session.updated' });
  let seq = 0;
  const outputFor = (id: string) => model.ofType('conversation.item.create').map((m) => m.item as Json).find((i) => i.call_id === id);
  const invoke = async (name: string, args: unknown) => {
    const id = `fc_${++seq}`;
    model.emit({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id }] } });
    await vi.waitFor(() => expect(outputFor(id)).toBeDefined());
    return JSON.parse(String(outputFor(id)!.output)) as Json;
  };
  const systemLines = () => model.ofType('conversation.item.create').map((m) => m.item as Json).filter((i) => i.role === 'system').map((i) => String(((i.content as Json[])[0] as Json).text));
  const sessionUpdates = () => model.ofType('session.update').slice(1) as { session: { audio: { input: { turn_detection: Json; transcription: unknown } } } }[];
  /** The model plays the queued offer: response.created, audio, response.done, then Twilio's mark. */
  const playOffer = (attempt: 1 | 2 = 1, opts: { status?: string; mark?: boolean } = {}) => {
    const id = `resp_offer_${attempt}`;
    model.emit({ type: 'response.created', response: { id, metadata: { voiceConsentOffer: String(attempt) } } });
    model.emit({ type: 'response.output_audio.delta', item_id: `item_offer_${attempt}`, delta: ulaw(40) });
    model.emit({ type: 'response.done', response: { id, status: opts.status ?? 'completed', output: [] } });
    if (opts.mark !== false) for (const m of phone.ofType('mark')) phone.emit({ event: 'mark', mark: { name: (m.mark as Json).name } });
  };
  const callerSays = (itemId: string, transcript: string | null) => {
    model.emit({ type: 'input_audio_buffer.speech_started', item_id: itemId });
    model.emit({ type: 'input_audio_buffer.speech_stopped', item_id: itemId });
    model.emit({ type: 'input_audio_buffer.committed', item_id: itemId });
    if (transcript === null) model.emit({ type: 'conversation.item.input_audio_transcription.failed', item_id: itemId, content_index: 0, error: { type: 'server_error', message: 'x' } });
    else model.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, content_index: 0, transcript });
  };
  const press = (digit: string) => phone.emit({ event: 'dtmf', streamSid: 'MZ1', sequenceNumber: '5', dtmf: { track: 'inbound', digit } });
  const propose = (contact: Json = { name: 'Customer', messageConsent: false }) =>
    invoke('propose_order', { cart, quoteId: quote.quoteId, contact, fulfillment: { type: 'pickup', pickupAt: '2026-11-14T21:00:00Z' } });
  const hangUp = async () => { phone.emit({ event: 'stop' }); await relay.done; };
  return { relay, phone, model, calls, events, lines, contexts, cart, invoke, systemLines, sessionUpdates, playOffer, callerSays, press, propose, hangUp, createOrderProposal, createBookingProposal };
}

const lastLine = (s: Awaited<ReturnType<typeof setup>>) => s.systemLines().at(-1) ?? '';

describe('text step: the offer', () => {
  it('is injected once, right after the first successful quote, with the last four digits only', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    expect(s.systemLines()).toHaveLength(1);
    expect(lastLine(s)).toContain(OFFER);
    expect(lastLine(s)).not.toContain('Press');
    expect(s.model.ofType('response.create').at(-1)).toMatchObject({ response: { metadata: { voiceConsentOffer: '1' } } });
    // The window: no automatic reply, and transcription on.
    expect(s.sessionUpdates()[0]?.session.audio.input).toMatchObject({ turn_detection: { type: 'server_vad', create_response: false }, transcription: { model: 'gpt-4o-transcribe' } });
    s.playOffer(); s.callerSays('item_a', 'no');
    await s.invoke('quote_order', { cart: s.cart });
    expect(s.systemLines().filter((l) => l.includes(OFFER))).toHaveLength(1);
    expect(JSON.stringify(s.model.sent)).not.toContain(NUMBER);
    await s.hangUp();
  });

  it('is not offered after a failed quote, nor before any quote', async () => {
    const s = await setup();
    await s.invoke('read_catalog', { query: 'pizza' });
    await s.invoke('quote_order', { cart: { lines: [] } });
    expect(s.systemLines()).toHaveLength(0);
    await s.hangUp();
  });

  it.each([
    ['qr_only', { channel: 'qr_only' as const }],
    ['no caller number', { callerNumber: null }],
    ['a spec without the message capability', { spec: { ...pizzaSpecV2, capabilities: pizzaSpecV2.capabilities.filter((c) => c !== 'message.checkout.send') } }],
  ])('is never offered with %s', async (_label, o) => {
    const s = await setup(o);
    await s.invoke('quote_order', { cart: s.cart });
    expect(s.systemLines()).toHaveLength(0);
    expect(s.sessionUpdates()).toHaveLength(0);
    await s.hangUp();
  });

  it('for a booking, is offered after the first availability that has a slot, and the booking proposal carries the recipient', async () => {
    const facts = { facts: barberFacts.flatMap((f) => (f.kind === 'menu_item' || f.status !== 'verified' ? [] : [{ kind: f.kind, key: f.key, value: f.value, version: f.version }])), timezone: 'America/Los_Angeles' };
    const s = await setup({ spec: barberSpecV1, channel: 'whatsapp_sandbox', facts });
    const r = await s.invoke('read_calendar_availability', { serviceId: serviceHaircut.id, date: '2026-11-14' });
    expect(r).toMatchObject({ ok: true });
    expect(lastLine(s)).toContain('Would you like one WhatsApp message with your booking confirmation, sent to the number you are calling from, ending in 3 7 1 6?');
    s.playOffer(); s.callerSays('item_1', 'okay');
    expect(lastLine(s)).toContain('the confirmation will come by WhatsApp message');
    await s.invoke('propose_booking', { serviceId: serviceHaircut.id, startUtc: '2026-11-14T22:00:00Z', customer: { name: 'Sam', messageConsent: false } });
    expect(s.createBookingProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'whatsapp_sandbox', customer: { name: 'Sam', messageRecipient: NUMBER, messageConsent: true } });
    await s.hangUp();
  });

  it('for a booking, an availability with no readable hours offers nothing', async () => {
    const s = await setup({ spec: barberSpecV1, channel: 'whatsapp_sandbox', facts: { facts: [], timezone: 'America/Los_Angeles' } });
    await s.invoke('read_calendar_availability', { serviceId: serviceHaircut.id, date: '2026-11-14' });
    expect(s.systemLines()).toHaveLength(0);
    await s.hangUp();
  });
});

describe('text step: the answer', () => {
  it('a spoken yes after the offer finished playing records consent, and the proposal carries the recipient and the channel', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer();
    s.callerSays('item_answer', TRANSCRIPT);
    expect(lastLine(s)).toContain('the caller agreed to one text message');
    expect(lastLine(s)).toContain('ending in 3 7 1 6');
    expect(s.sessionUpdates().at(-1)?.session.audio.input).toMatchObject({ turn_detection: { create_response: true }, transcription: null });
    expect((await s.propose()).ok).toBe(true);
    const input = s.createOrderProposal.mock.calls[0]?.[0];
    expect(input).toMatchObject({ messageChannel: 'surge', contact: { messageRecipient: NUMBER, messageConsent: true } });
    expect(Date.parse(String(input?.contact.consentAt))).not.toBeNaN();
    await s.hangUp();
  });

  it('a spoken yes before the offer finished playing is not consent', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer(1, { mark: false });
    // Twilio has not confirmed the audio: the caller's turn is not the answer turn.
    s.callerSays('item_early', 'yes');
    expect(s.systemLines().some((l) => l.includes('agreed'))).toBe(false);
    s.press('1');
    expect(lastLine(s)).toContain('did not agree');
    await s.propose();
    expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'qr_only', contact: { messageConsent: false } });
    await s.hangUp();
  });

  it('a transcript for a turn that started during the offer is not read', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.model.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item_during' });
    s.playOffer();
    s.model.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_during', content_index: 0, transcript: 'yes' });
    expect(s.systemLines().some((l) => l.includes('agreed'))).toBe(false);
    s.callerSays('item_after', 'no');
    expect(lastLine(s)).toContain('did not agree');
    await s.hangUp();
  });

  it('an offer cut off before it finished is asked again once with the fixed sentence', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer(1, { status: 'cancelled' });
    expect(lastLine(s)).toContain(CONSENT_REASK);
    await s.hangUp();
  });

  it.each([
    ['a clear no', 'No thanks.'],
    ['a negation with a yes', 'yeah no'],
  ])('%s declines or re-asks, never consents', async (_label, said) => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer();
    s.callerSays('item_1', said);
    if (lastLine(s).includes(CONSENT_REASK)) { s.playOffer(2); s.callerSays('item_2', said); }
    expect(lastLine(s)).toContain('did not agree');
    await s.propose();
    expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'qr_only' });
    await s.hangUp();
  });

  it('an unclear answer is asked again exactly once; a second unclear answer declines', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer();
    s.callerSays('item_1', 'I guess');
    expect(lastLine(s)).toContain(CONSENT_REASK);
    expect(s.model.ofType('response.create').at(-1)).toMatchObject({ response: { metadata: { voiceConsentOffer: '2' } } });
    s.playOffer(2);
    s.callerSays('item_2', 'maybe');
    expect(lastLine(s)).toContain('did not agree');
    expect(s.systemLines().filter((l) => l.includes(CONSENT_REASK))).toHaveLength(1);
    await s.hangUp();
  });

  it('an unclear answer then a clear yes to the re-ask records consent', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer(); s.callerSays('item_1', 'hmm');
    s.playOffer(2); s.callerSays('item_2', 'yes');
    expect(lastLine(s)).toContain('agreed');
    await s.hangUp();
  });

  it('a failed transcription twice declines', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer(); s.callerSays('item_1', null);
    expect(lastLine(s)).toContain(CONSENT_REASK);
    s.playOffer(2); s.callerSays('item_2', null);
    expect(lastLine(s)).toContain('did not agree');
    await s.hangUp();
  });

  it('no answer within the window declines', async () => {
    const s = await setup({ windowMs: 30 });
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer();
    await vi.waitFor(() => expect(lastLine(s)).toContain('did not agree'));
    expect(s.sessionUpdates().at(-1)?.session.audio.input).toMatchObject({ transcription: null });
    await s.hangUp();
  });

  it('an offer that never finishes playing declines when the window ends', async () => {
    const s = await setup({ windowMs: 30 });
    await s.invoke('quote_order', { cart: s.cart });
    await vi.waitFor(() => expect(lastLine(s)).toContain('did not agree'));
    await s.hangUp();
  });

  it('the model cannot propose while the server waits for the answer', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    const r = await s.propose({ name: 'Customer', messageConsent: true, messageRecipient: NUMBER, consentAt: FIXTURE_NOW });
    expect(r).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(s.createOrderProposal).not.toHaveBeenCalled();
    await s.hangUp();
  });

  it('the model saying or claiming yes, with no server-read affirmative, never produces a consented proposal', async () => {
    const s = await setup({ windowMs: 30 });
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer();
    // The model's own words and flags are not evidence; no caller turn was read.
    s.model.emit({ type: 'response.output_audio_transcript.done', transcript: 'The caller said yes.' });
    await vi.waitFor(() => expect(lastLine(s)).toContain('did not agree'));
    await s.propose({ name: 'Customer', messageConsent: true, messageRecipient: NUMBER, consentAt: FIXTURE_NOW });
    expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'qr_only', contact: { messageConsent: false } });
    expect(s.createOrderProposal.mock.calls[0]?.[0].contact.messageRecipient).toBeUndefined();
    await s.hangUp();
  });
});

describe('text step: the keypad', () => {
  it('a 1 after the offer finished records consent (method keypad)', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer();
    s.press('1');
    expect(lastLine(s)).toContain('agreed');
    expect(s.lines.some((l) => l.msg === 'voice: text consent outcome' && l.data.method === 'keypad' && l.data.consent === 'agreed')).toBe(true);
    await s.propose();
    expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'surge', contact: { messageRecipient: NUMBER } });
    await s.hangUp();
  });

  it('a 1 before the offer finished is a decline', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.press('1');
    expect(lastLine(s)).toContain('did not agree');
    s.playOffer();
    s.press('1');
    expect(s.systemLines().some((l) => l.includes('agreed to one'))).toBe(false);
    await s.hangUp();
  });

  it.each(['2', '7', '#'])('a %s after the offer is a decline', async (digit) => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer();
    s.press(digit);
    expect(lastLine(s)).toContain('did not agree');
    await s.hangUp();
  });

  it('a later 2 withdraws consent before the proposal', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer(); s.callerSays('item_1', 'yes');
    s.press('2');
    expect(lastLine(s)).toContain('pressed 2, so no text message will be sent');
    await s.propose();
    expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'qr_only' });
    await s.hangUp();
  });

  it('a 2 after the proposal was stored changes nothing (documented limit)', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer(); s.callerSays('item_1', 'yes');
    await s.propose();
    const before = s.systemLines().length;
    s.press('2');
    expect(s.systemLines()).toHaveLength(before);
    await s.hangUp();
  });
});

describe('text step: privacy and the default', () => {
  it('the full number and the transcript never appear in a log line, an event payload or anything sent', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer(); s.callerSays('item_1', TRANSCRIPT);
    await s.propose();
    s.press('2');
    await s.hangUp();
    const everything = JSON.stringify([s.lines, s.events.guardrailRefused.mock.calls, s.events.webhookRejected.mock.calls, s.calls.updateStage.mock.calls, s.calls.endCall.mock.calls, s.model.sent, s.phone.sent]);
    for (const secret of [NUMBER, NUMBER.slice(1), '5555553716', TRANSCRIPT, 'sure thing']) expect(everything.toLowerCase()).not.toContain(secret.toLowerCase());
  });

  it('under qr_only: no offer, no session change, DTMF and transcripts ignored, no evidence and the counter-only prompt', async () => {
    const s = await setup({ channel: 'qr_only' });
    const instructions = String((s.model.ofType('session.update')[0]!.session as Json).instructions);
    expect(instructions).toContain('Do not ask for a number');
    expect(instructions).not.toContain('The server asks once');
    expect(instructions).not.toContain('3 7 1 6');
    await s.invoke('quote_order', { cart: s.cart });
    s.press('1');
    s.callerSays('item_1', 'yes');
    expect(s.systemLines()).toHaveLength(0);
    expect(s.sessionUpdates()).toHaveLength(0);
    const ctx = s.contexts[0] as { consent: { read: () => unknown } };
    expect(ctx.consent.read()).toBeUndefined();
    await s.propose({ name: 'Customer', messageConsent: true, messageRecipient: NUMBER, consentAt: FIXTURE_NOW });
    expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'qr_only', contact: { name: 'Customer', messageConsent: false } });
    expect(s.createOrderProposal.mock.calls[0]?.[0].contact.messageRecipient).toBeUndefined();
    await s.hangUp();
  });

  it('the evidence reader returns nothing outside a proposal, even after consent', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    s.playOffer(); s.callerSays('item_1', 'yes');
    const ctx = s.contexts[0] as { consent: { read: () => unknown } };
    expect(ctx.consent.read()).toBeUndefined();
    await s.hangUp();
  });
});

it('an offer response that played no audio is not a spoken offer: the server asks again', async () => {
  const s = await setup();
  await s.invoke('quote_order', { cart: s.cart });
  s.model.emit({ type: 'response.created', response: { id: 'resp_silent', metadata: { voiceConsentOffer: '1' } } });
  s.model.emit({ type: 'response.done', response: { id: 'resp_silent', status: 'completed', output: [] } });
  s.press('1');
  expect(s.systemLines().some((l) => l.includes('agreed to one'))).toBe(false);
  expect(s.systemLines().some((l) => l.includes(CONSENT_REASK))).toBe(true);
  await s.hangUp();
});

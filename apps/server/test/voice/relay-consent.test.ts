// PROPOSED text step (SPEC 2.9 "Consent evidence on a phone call"), in the relay with the real toolset
// and fake ports. The server makes the offer once, checks that it was said as written and fully played,
// reads the caller's one answer turn itself (the server's transcript, or a keypad press) and hands
// evidence to the toolset for one proposal operation only. The fake Twilio socket echoes outstanding
// marks after a `clear`, as real Twilio does.
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
const BOOKING_OFFER = 'Would you like one WhatsApp message with your booking confirmation, sent to the number you are calling from, ending in 3 7 1 6?';
const TRANSCRIPT = 'Yep, sure thing';

type Opts = { channel?: MessageChannelSetting; callerNumber?: string | null; spec?: AgentSpec; windowMs?: number; facts?: PinnedCall['facts']; maxPendingResponses?: number };

async function setup(o: Opts = {}) {
  const spec = o.spec ?? pizzaSpecV2;
  const channel = o.channel ?? 'surge';
  const cart: Cart = { lines: [{ catalogItemId: SQ.itemMargherita, variationId: SQ.varMargheritaLarge, quantity: 1, modifierIds: [] }] };
  const cartB: Cart = { lines: [{ catalogItemId: SQ.itemMargherita, variationId: SQ.varMargheritaLarge, quantity: 2, modifierIds: [] }] };
  const quoteOf = async (c: Cart, id: string): Promise<Quote> => ({ quoteId: id, cartHash: await cartHash(c), subtotalMinor: 100, taxMinor: 0, totalMinor: 100, currency: 'USD', lines: [{ variationId: SQ.varMargheritaLarge, name: 'Pizza', quantity: 1, unitPriceMinor: 100, modifiers: [], lineTotalMinor: 100 }], quotedAt: FIXTURE_NOW, expiresAt: new Date(Date.parse(FIXTURE_NOW) + 300000).toISOString() });
  let quoteSeq = 0;
  const slot: AvailabilitySlot = { serviceId: serviceHaircut.id, startUtc: '2026-11-14T22:00:00Z', endUtc: '2026-11-14T22:30:00Z', timezone: 'America/Los_Angeles' };
  let orderSeq = 0;
  const createOrderProposal = vi.fn<RealToolsetPorts['proposals']['createOrderProposal']>(async () => ({ ok: true, orderId: `ord_consent_0${++orderSeq}`, approvalId: `apv_consent_0${orderSeq}` }));
  const createBookingProposal = vi.fn<RealToolsetPorts['proposals']['createBookingProposal']>(async () => ({ ok: true, bookingId: 'bkg_consent_01', approvalId: 'apv_consent_b1', slot }));
  const ports: RealToolsetPorts = {
    catalog: { search: async () => pizzaCatalog }, quotes: { quote: async ({ cart: c }) => ({ ok: true, quote: await quoteOf(c, `qte_consent_${++quoteSeq}`) }) },
    proposals: { atomicOperations: true, createOrderProposal, createBookingProposal },
    orderStatus: { read: async () => null }, availability: { freeSlots: async () => [slot] },
  };
  const tokens = new StreamTokenStore<PinnedCall>();
  const callerNumber = o.callerNumber === null ? undefined : (o.callerNumber ?? NUMBER);
  const token = tokens.mint({ callId: 'call_consent_01', providerCallId: 'CA123', businessId: spec.businessId, businessName: 'Demo Shop', agentId: spec.id, agentVersionId: 'agv_consent_v1', spec, facts: o.facts ?? PIZZA_SNAPSHOT, ...(callerNumber !== undefined ? { callerNumber } : {}) }) ?? '';
  const phone = new FakeSocket(); phone.echoMarksOnClear = true;
  const model = new FakeSocket(); const calls = fakeCalls(); const events = fakeEvents();
  const { logger, lines } = fakeLogger();
  const contexts: unknown[] = [];
  const reads: unknown[] = [];
  const relay = runPhoneRelay({ phone, tokens, calls, events, messageChannel: channel, logger,
    limits: { consentWindowMs: o.windowMs ?? 2000, pendingWaitMs: 60_000, ...(o.maxPendingResponses !== undefined ? { maxPendingResponses: o.maxPendingResponses } : {}) }, openaiSocketFactory: () => model,
    toolsetFactory: (ctx) => {
      contexts.push(ctx);
      const ts = createRealToolset({ businessId: ctx.businessId, messageChannel: channel, ports, capabilities: ctx.capabilities, factsSnapshot: ctx.facts, now: () => new Date(FIXTURE_NOW), consent: ctx.consent });
      // What the relay hands each proposal is recorded at the moment the toolset is called.
      const call = ((name, input, c, control) => {
        if (name === 'propose_order' || name === 'propose_booking') reads.push(ctx.consent?.read());
        return ts.handler.call(name, input, c, control);
      }) as typeof ts.handler.call;
      return { handler: { ...ts.handler, call }, dispose: ts.dispose };
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
  const windowUpdates = () => model.ofType('session.update').slice(1) as { event_id: string; session: { audio: { input: { turn_detection: Json; transcription: unknown } } } }[];
  /** The provider confirms the last window update. */
  const ack = () => model.emit({ type: 'session.updated' });
  /** Quote, then the provider confirms the window: the offer is now queued. */
  const quoteAndOpen = async () => { await s.invoke('quote_order', { cart }); ack(); };
  const lastOfferTag = () => String(((model.ofType('response.create').filter((m) => (m.response as Json | undefined)?.metadata !== undefined).at(-1)!.response as Json).metadata as Json).voiceConsentOffer);
  let respSeq = 0;
  /** The model speaks the queued line: response.created, audio, its own transcript, response.done, then Twilio's marks. */
  const playOffer = (opts: { status?: string; marks?: boolean; said?: string; audio?: boolean; done?: boolean } = {}) => {
    const id = `resp_offer_${++respSeq}`;
    const line = systemLines().at(-1) ?? '';
    const said = opts.said ?? (line.includes(CONSENT_REASK) ? CONSENT_REASK : line.includes('WhatsApp') ? BOOKING_OFFER : OFFER);
    model.emit({ type: 'response.created', response: { id, metadata: { voiceConsentOffer: lastOfferTag() } } });
    if (opts.audio !== false) model.emit({ type: 'response.output_audio.delta', response_id: id, item_id: `item_offer_${respSeq}`, delta: ulaw(40) });
    model.emit({ type: 'response.output_audio_transcript.done', response_id: id, item_id: `item_offer_${respSeq}`, transcript: said });
    if (opts.done !== false) model.emit({ type: 'response.done', response: { id, status: opts.status ?? 'completed', output: [] } });
    if (opts.marks !== false) phone.ackMarks();
    return id;
  };
  const callerSays = (itemId: string, transcript: string | null) => {
    model.emit({ type: 'input_audio_buffer.speech_started', item_id: itemId });
    model.emit({ type: 'input_audio_buffer.speech_stopped', item_id: itemId });
    model.emit({ type: 'input_audio_buffer.committed', item_id: itemId });
    if (transcript === null) model.emit({ type: 'conversation.item.input_audio_transcription.failed', item_id: itemId, content_index: 0, error: { type: 'server_error', message: 'x' } });
    else model.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, content_index: 0, transcript });
  };
  const press = (digit: string) => phone.emit({ event: 'dtmf', streamSid: 'MZ1', sequenceNumber: '5', dtmf: { track: 'inbound', digit } });
  const quoteIdOf = async (c: Cart) => String(((await s.invoke('quote_order', { cart: c })).quote as Json).quoteId);
  const propose = async (contact: Json = { name: 'Customer', messageConsent: false }, c: Cart = cart, quoteId?: string) =>
    invoke('propose_order', { cart: c, quoteId: quoteId ?? 'qte_consent_1', contact, fulfillment: { type: 'pickup', pickupAt: '2026-11-14T21:00:00Z' } });
  const hangUp = async () => { phone.emit({ event: 'stop' }); await relay.done; };
  /**
   * Every way out of the window restores the call's normal settings, or the call closed. Since the
   * interruption gate (NOTES.md), the call's normal turn detection has create_response off and the relay
   * asks for every reply, so "restored" is the window's interrupt_response and transcription undone.
   */
  const restoredOrClosed = () => !model.isOpen || (windowUpdates().at(-1)?.session.audio.input.turn_detection.interrupt_response === false && windowUpdates().at(-1)?.session.audio.input.transcription === null);
  const s = { relay, phone, model, calls, events, lines, contexts, reads, cart, cartB, invoke, systemLines, windowUpdates, ack, quoteAndOpen, playOffer, callerSays, press, propose, quoteIdOf, hangUp, restoredOrClosed, createOrderProposal, createBookingProposal };
  return s;
}

type S = Awaited<ReturnType<typeof setup>>;
const lastLine = (s: S) => s.systemLines().at(-1) ?? '';
const offers = (s: S) => s.systemLines().filter((l) => l.includes(OFFER)).length;
const agreed = (s: S) => s.systemLines().some((l) => l.includes('agreed to one'));

describe('text step: the offer', () => {
  it('opens the window, waits for the provider to confirm it, then queues the offer once with tools off and the last four digits only', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    expect(s.windowUpdates()[0]?.session.audio.input).toMatchObject({ turn_detection: { type: 'server_vad', create_response: false }, transcription: { model: 'gpt-4o-transcribe' } });
    expect(s.windowUpdates()[0]?.event_id).toMatch(/^voice_consent_window_/);
    // Not confirmed yet: nothing is spoken.
    expect(s.systemLines()).toHaveLength(0);
    s.ack();
    expect(lastLine(s)).toContain(OFFER);
    expect(lastLine(s)).not.toContain('Press');
    expect(s.model.ofType('response.create').at(-1)).toMatchObject({ response: { tool_choice: 'none', metadata: { voiceConsentOffer: expect.any(String) } } });
    s.playOffer(); s.callerSays('item_a', 'no');
    await s.invoke('quote_order', { cart: s.cart });
    expect(offers(s)).toBe(1);
    expect(JSON.stringify(s.model.sent)).not.toContain(NUMBER);
    await s.hangUp();
  });

  it('is not offered after a failed quote, nor before any quote', async () => {
    const s = await setup();
    await s.invoke('read_catalog', { query: 'pizza' });
    await s.invoke('quote_order', { cart: { lines: [] } });
    expect(s.windowUpdates()).toHaveLength(0);
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
    expect(s.windowUpdates()).toHaveLength(0);
    await s.hangUp();
  });

  it('for a booking, is offered after the first availability that has a slot, and the booking proposal carries the recipient', async () => {
    const facts = { facts: barberFacts.flatMap((f) => (f.kind === 'menu_item' || f.status !== 'verified' ? [] : [{ kind: f.kind, key: f.key, value: f.value, version: f.version }])), timezone: 'America/Los_Angeles' };
    const s = await setup({ spec: barberSpecV1, channel: 'whatsapp_sandbox', facts });
    expect(await s.invoke('read_calendar_availability', { serviceId: serviceHaircut.id, date: '2026-11-14' })).toMatchObject({ ok: true });
    s.ack();
    expect(lastLine(s)).toContain(BOOKING_OFFER);
    s.playOffer(); s.callerSays('item_1', 'okay');
    expect(lastLine(s)).toContain('the confirmation will come by WhatsApp message');
    await s.invoke('propose_booking', { serviceId: serviceHaircut.id, startUtc: '2026-11-14T22:00:00Z', customer: { name: 'Sam', messageConsent: false } });
    expect(s.createBookingProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'whatsapp_sandbox', customer: { name: 'Sam', messageRecipient: NUMBER, messageConsent: true } });
    await s.hangUp();
  });

  it('for a booking, an availability with no readable hours offers nothing', async () => {
    const s = await setup({ spec: barberSpecV1, channel: 'whatsapp_sandbox', facts: { facts: [], timezone: 'America/Los_Angeles' } });
    await s.invoke('read_calendar_availability', { serviceId: serviceHaircut.id, date: '2026-11-14' });
    expect(s.windowUpdates()).toHaveLength(0);
    await s.hangUp();
  });
});

describe('text step: was the offer delivered (Codex 2, 3; Opus B1, B2)', () => {
  it('B1, Codex 2: a barge-in after generation finished, with Twilio echoing the cleared marks, does not open listening; the full offer is spoken again', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer({ marks: false });
    // The caller talks over the offer: the relay clears Twilio, which echoes the outstanding marks.
    s.model.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item_over' });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.phone.ofType('clear')).toHaveLength(1);
    s.press('1');
    expect(agreed(s)).toBe(false);
    expect(offers(s)).toBe(2);
    await s.hangUp();
  });

  it('B1: the interrupting turn\'s committed and transcript never count, even after the replay played', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer({ marks: false });
    s.model.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item_over' });
    await new Promise((r) => setTimeout(r, 0));
    s.playOffer();
    s.model.emit({ type: 'input_audio_buffer.committed', item_id: 'item_over' });
    s.model.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_over', content_index: 0, transcript: 'yes' });
    expect(agreed(s)).toBe(false);
    await s.hangUp();
  });

  it('Codex 1: a turn that started during the offer and is committed after playback is not the answer', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    // Speech starts while the offer is still being generated and played.
    s.model.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item_early' });
    s.playOffer();
    s.model.emit({ type: 'input_audio_buffer.committed', item_id: 'item_early' });
    s.model.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_early', content_index: 0, transcript: 'yes' });
    expect(agreed(s)).toBe(false);
    // The real answer turn, started while listening, is read.
    s.callerSays('item_answer', 'no');
    expect(lastLine(s)).toContain('did not agree');
    await s.hangUp();
  });

  it('Codex 3: an offer cut off after its first word is replayed in full, never replaced by the short re-ask', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer({ status: 'cancelled' });
    expect(lastLine(s)).toContain(OFFER);
    expect(s.systemLines().some((l) => l.includes(CONSENT_REASK))).toBe(false);
    s.playOffer(); s.callerSays('item_1', 'yes');
    expect(agreed(s)).toBe(true);
    await s.hangUp();
  });

  it('an offer undelivered twice is a decline', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer({ status: 'cancelled' });
    s.playOffer({ status: 'cancelled' });
    expect(lastLine(s)).toContain('did not agree');
    expect(offers(s)).toBe(2);
    expect(s.restoredOrClosed()).toBe(true);
    await s.hangUp();
  });

  it('B2: an offer response that said something else is not delivered; the yes to it is never consent', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer({ said: 'Shall I send this to the shop for approval?' });
    s.press('1');
    expect(agreed(s)).toBe(false);
    expect(offers(s)).toBe(2);
    s.playOffer({ said: 'Got it, sending this now.' });
    expect(lastLine(s)).toContain('did not agree');
    await s.hangUp();
  });

  it('B2: the offer counts when the model\'s transcript writes the digits as words', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer({ said: 'Would you like one text message with your payment link, sent to the number you are calling from, ending in three seven one six?' });
    s.press('1');
    expect(agreed(s)).toBe(true);
    await s.hangUp();
  });

  it('Codex second review: a marketing sentence with the right digits is not the offer, and a keypad 1 after it is not consent', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer({ said: 'Would you like a marketing message sent to the number you are calling from ending in 3 7 1 6?' });
    s.press('1');
    expect(agreed(s)).toBe(false);
    expect(offers(s)).toBe(2);
    await s.hangUp();
  });

  it('an offer response that played no audio is replayed', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer({ audio: false });
    s.press('1');
    expect(agreed(s)).toBe(false);
    expect(offers(s)).toBe(2);
    await s.hangUp();
  });

  it('an offer response that calls a tool is not delivered and the tool never runs', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.model.emit({ type: 'response.created', response: { id: 'resp_tool', metadata: { voiceConsentOffer: String(((s.model.ofType('response.create').at(-1)!.response as Json).metadata as Json).voiceConsentOffer) } } });
    s.model.emit({ type: 'response.done', response: { id: 'resp_tool', status: 'completed', output: [{ type: 'function_call', name: 'propose_order', arguments: '{}', call_id: 'fc_x' }] } });
    expect(s.createOrderProposal).not.toHaveBeenCalled();
    expect(offers(s)).toBe(2);
    await s.hangUp();
  });
});

describe('text step: the answer', () => {
  it('a spoken yes after the offer was verified and played records consent, and the proposal carries the recipient and the channel', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer();
    s.callerSays('item_answer', TRANSCRIPT);
    expect(lastLine(s)).toContain('the caller agreed to one text message');
    expect(lastLine(s)).toContain('ending in 3 7 1 6');
    // Restored to the call's normal settings (create_response stays off on the whole call since the gate).
    expect(s.windowUpdates().at(-1)?.session.audio.input).toMatchObject({ turn_detection: { create_response: false, interrupt_response: false }, transcription: null });
    expect((await s.propose()).ok).toBe(true);
    const input = s.createOrderProposal.mock.calls[0]?.[0];
    expect(input).toMatchObject({ messageChannel: 'surge', contact: { messageRecipient: NUMBER, messageConsent: true } });
    expect(Date.parse(String(input?.contact.consentAt))).not.toBeNaN();
    await s.hangUp();
  });

  it('a spoken yes before Twilio confirmed playback is not consent', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer({ marks: false });
    // No barge-in here: speech_started is only emitted by callerSays, which counts as talking over the offer.
    s.model.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_x', content_index: 0, transcript: 'yes' });
    expect(agreed(s)).toBe(false);
    s.press('1');
    expect(lastLine(s)).toContain('did not agree');
    await s.propose();
    expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'qr_only', contact: { messageConsent: false } });
    await s.hangUp();
  });

  it.each([
    ['a clear no', 'No thanks.'],
    ['a negation with a yes', 'yeah no'],
    ['a question', 'yes?'],
  ])('%s declines or re-asks, never consents', async (_label, said) => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer();
    s.callerSays('item_1', said);
    if (lastLine(s).includes(CONSENT_REASK)) { s.playOffer(); s.callerSays('item_2', said); }
    expect(lastLine(s)).toContain('did not agree');
    await s.propose();
    expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'qr_only' });
    await s.hangUp();
  });

  it('an unclear answer is asked again exactly once with the short re-ask; a second unclear answer declines', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer();
    s.callerSays('item_1', 'I guess');
    expect(lastLine(s)).toContain(CONSENT_REASK);
    s.playOffer();
    s.callerSays('item_2', 'maybe');
    expect(lastLine(s)).toContain('did not agree');
    expect(s.systemLines().filter((l) => l.includes(CONSENT_REASK))).toHaveLength(1);
    await s.hangUp();
  });

  it('an unclear answer then a clear yes to the re-ask records consent', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer(); s.callerSays('item_1', 'hmm');
    s.playOffer(); s.callerSays('item_2', 'yes text me');
    expect(agreed(s)).toBe(true);
    await s.hangUp();
  });

  it('a failed transcription twice declines', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer(); s.callerSays('item_1', null);
    expect(lastLine(s)).toContain(CONSENT_REASK);
    s.playOffer(); s.callerSays('item_2', null);
    expect(lastLine(s)).toContain('did not agree');
    await s.hangUp();
  });

  it('no answer within the window declines', async () => {
    const s = await setup({ windowMs: 300 });
    await s.quoteAndOpen();
    s.playOffer();
    await vi.waitFor(() => expect(lastLine(s)).toContain('did not agree'));
    expect(s.windowUpdates().at(-1)?.session.audio.input).toMatchObject({ transcription: null });
    s.ack();
    await s.hangUp();
  });

  it('the model cannot propose while the server waits for the answer', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    const r = await s.propose({ name: 'Customer', messageConsent: true, messageRecipient: NUMBER, consentAt: FIXTURE_NOW });
    expect(r).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(s.createOrderProposal).not.toHaveBeenCalled();
    await s.hangUp();
  });

  it('the model saying or claiming yes, with no server-read affirmative, never produces a consented proposal', async () => {
    const s = await setup({ windowMs: 300 });
    await s.quoteAndOpen();
    s.playOffer();
    s.model.emit({ type: 'response.output_audio_transcript.done', response_id: 'resp_other', transcript: 'The caller said yes.' });
    await vi.waitFor(() => expect(lastLine(s)).toContain('did not agree'));
    await s.propose({ name: 'Customer', messageConsent: true, messageRecipient: NUMBER, consentAt: FIXTURE_NOW });
    expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'qr_only', contact: { messageConsent: false } });
    expect(s.createOrderProposal.mock.calls[0]?.[0].contact.messageRecipient).toBeUndefined();
    await s.hangUp();
  });
});

describe('text step: nothing else speaks while the question is open (Codex 6)', () => {
  it('another response is cancelled and its audio never reaches the caller', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer();
    const media = s.phone.ofType('media').length;
    s.model.emit({ type: 'response.created', response: { id: 'resp_other' } });
    expect(s.model.ofType('response.cancel').at(-1)).toMatchObject({ response_id: 'resp_other' });
    s.model.emit({ type: 'response.output_audio.delta', response_id: 'resp_other', item_id: 'item_other', delta: ulaw(40) });
    expect(s.phone.ofType('media')).toHaveLength(media);
    await s.hangUp();
  });

  it('a function call while listening runs no tool and creates no response, even with the tool queue full', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer();
    const creates = s.model.ofType('response.create').length;
    s.model.emit({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', name: 'read_catalog', arguments: '{"query":"x"}', call_id: 'fc_w' }] } });
    expect(s.model.ofType('response.create')).toHaveLength(creates);
    await s.hangUp();
  });

  it('Codex 6: with the tool queue full, the busy answer creates no response while the question is open', async () => {
    const full = await setup({ maxPendingResponses: 1 });
    await full.quoteAndOpen();
    full.playOffer();
    const creates = full.model.ofType('response.create').length;
    full.model.emit({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', name: 'read_catalog', arguments: '{"query":"x"}', call_id: 'fc_q1' }] } });
    full.model.emit({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', name: 'read_catalog', arguments: '{"query":"y"}', call_id: 'fc_q2' }] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(full.model.ofType('response.create')).toHaveLength(creates);
    await full.hangUp();
  });

});

describe('text step: the window is confirmed and always restored (liveness)', () => {
  it('a refused window update makes no offer, restores the session and lets the call go on', async () => {
    const s = await setup();
    await s.invoke('quote_order', { cart: s.cart });
    const eventId = s.windowUpdates()[0]!.event_id;
    s.model.emit({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', event_id: eventId } });
    expect(s.model.isOpen).toBe(true);
    expect(s.systemLines()).toHaveLength(0);
    expect(s.restoredOrClosed()).toBe(true);
    expect(s.model.ofType('response.create').at(-1)).toEqual({ type: 'response.create' });
    await s.hangUp();
  });

  it('a window that is never confirmed makes no offer and restores the session', async () => {
    const s = await setup({ windowMs: 300 });
    await s.invoke('quote_order', { cart: s.cart });
    await vi.waitFor(() => expect(s.restoredOrClosed()).toBe(true));
    expect(s.systemLines()).toHaveLength(0);
    await s.hangUp();
  });

  it('a refused restore ends the call', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer(); s.callerSays('item_1', 'no');
    const restore = s.windowUpdates().at(-1)!.event_id;
    s.model.emit({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', event_id: restore } });
    expect((await s.relay.done).endReason).toBe('failed');
  });

  it('an unconfirmed restore ends the call', async () => {
    const s = await setup({ windowMs: 300 });
    await s.quoteAndOpen();
    s.playOffer(); s.callerSays('item_1', 'no');
    expect((await s.relay.done).why).toContain('restore not confirmed');
  });

  const exits: [string, (s: S) => Promise<void> | void][] = [
    ['agreed', (s) => { s.playOffer(); s.callerSays('i1', 'yes'); }],
    ['declined', (s) => { s.playOffer(); s.callerSays('i1', 'no'); }],
    ['unclear twice', (s) => { s.playOffer(); s.callerSays('i1', 'maybe'); s.playOffer(); s.callerSays('i2', 'hmm'); }],
    ['timeout', async (s) => { s.playOffer(); await new Promise((r) => setTimeout(r, 700)); }],
    ['transcription failed twice', (s) => { s.playOffer(); s.callerSays('i1', null); s.playOffer(); s.callerSays('i2', null); }],
    ['barge-in twice', (s) => { s.playOffer({ marks: false }); s.model.emit({ type: 'input_audio_buffer.speech_started', item_id: 'b1' }); s.playOffer({ marks: false }); s.model.emit({ type: 'input_audio_buffer.speech_started', item_id: 'b2' }); }],
    ['keypad', (s) => { s.playOffer(); s.press('2'); }],
    ['call end', async (s) => { s.phone.emit({ event: 'stop' }); await s.relay.done; }],
    ['provider error', async (s) => { s.model.emit({ type: 'error', error: { type: 'server_error', code: 'server_error' } }); await s.relay.done; }],
  ];
  it.each(exits)('exit by %s leaves automatic replies on, or the call closed', async (_label, exit) => {
    const s = await setup({ windowMs: 300 });
    await s.quoteAndOpen();
    await exit(s);
    expect(s.restoredOrClosed()).toBe(true);
    if (s.model.isOpen) { s.ack(); await s.hangUp(); }
  });
});

describe('text step: the keypad', () => {
  it('a 1 after the offer finished records consent (method keypad)', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer();
    s.press('1');
    expect(agreed(s)).toBe(true);
    expect(s.lines.some((l) => l.msg === 'voice: text consent outcome' && l.data.method === 'keypad' && l.data.consent === 'agreed')).toBe(true);
    await s.propose();
    expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'surge', contact: { messageRecipient: NUMBER } });
    await s.hangUp();
  });

  it('a 1 before the offer finished is a decline', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.press('1');
    expect(lastLine(s)).toContain('did not agree');
    await s.hangUp();
  });

  it.each(['2', '7', '#'])('a %s after the offer is a decline', async (digit) => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer();
    s.press(digit);
    expect(lastLine(s)).toContain('did not agree');
    await s.hangUp();
  });

  it('a later 2 withdraws consent before the proposal', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer(); s.callerSays('item_1', 'yes');
    s.press('2');
    expect(lastLine(s)).toContain('pressed 2, so no text message will be sent');
    await s.propose();
    expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'qr_only' });
    await s.hangUp();
  });
});

describe('text step: evidence serves one proposal operation (Codex 4; Opus B4, B5)', () => {
  const agree = async (s: S) => { await s.quoteAndOpen(); s.playOffer(); s.callerSays('item_1', 'yes'); s.ack(); };

  it('a second, different proposal on the call gets no evidence, and the agent is told it has no text', async () => {
    const s = await setup();
    await agree(s);
    expect((await s.propose()).ok).toBe(true);
    const qB = await s.quoteIdOf(s.cartB);
    expect((await s.propose(undefined, s.cartB, qB)).ok).toBe(true);
    expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'surge', contact: { messageRecipient: NUMBER } });
    expect(s.createOrderProposal.mock.calls[1]?.[0]).toMatchObject({ messageChannel: 'qr_only', contact: { messageConsent: false } });
    expect(lastLine(s)).toContain('without a text message');
    await s.hangUp();
  });

  it('the exact replay of the consuming proposal gets the same evidence (idempotent replay); another request does not', async () => {
    const s = await setup();
    await agree(s);
    await s.propose();
    await s.propose();
    expect(s.reads).toHaveLength(2);
    expect(s.reads[1]).toMatchObject({ recipient: NUMBER });
    const qB = await s.quoteIdOf(s.cartB);
    await s.propose(undefined, s.cartB, qB);
    expect(s.reads[2]).toBeUndefined();
    await s.hangUp();
  });

  it('Codex 4: after proposal A, a 2 says the request already went with the text, and proposal B gets nothing', async () => {
    const s = await setup();
    await agree(s);
    await s.propose();
    s.press('2');
    expect(lastLine(s)).toContain('already went to the shop with the text message');
    const qB = await s.quoteIdOf(s.cartB);
    await s.propose(undefined, s.cartB, qB);
    await s.propose();
    expect(s.createOrderProposal.mock.calls[1]?.[0]).toMatchObject({ messageChannel: 'qr_only' });
    // After the withdrawal no proposal, not even a replay of A, is handed the evidence.
    expect(s.reads.slice(1).every((e) => e === undefined)).toBe(true);
    await s.hangUp();
  });
});

describe('text step: privacy and the default', () => {
  it('the full number and the transcript never appear in a log line, an event payload or anything sent', async () => {
    const s = await setup();
    await s.quoteAndOpen();
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
    expect(instructions).not.toContain('3 7 1 6');
    await s.invoke('quote_order', { cart: s.cart });
    s.press('1');
    s.callerSays('item_1', 'yes');
    expect(s.systemLines()).toHaveLength(0);
    expect(s.windowUpdates()).toHaveLength(0);
    const ctx = s.contexts[0] as { consent: { read: () => unknown } };
    expect(ctx.consent.read()).toBeUndefined();
    await s.propose({ name: 'Customer', messageConsent: true, messageRecipient: NUMBER, consentAt: FIXTURE_NOW });
    expect(s.createOrderProposal.mock.calls[0]?.[0]).toMatchObject({ messageChannel: 'qr_only', contact: { name: 'Customer', messageConsent: false } });
    expect(s.createOrderProposal.mock.calls[0]?.[0].contact.messageRecipient).toBeUndefined();
    await s.hangUp();
  });

  it('the evidence reader returns nothing outside a proposal, even after consent', async () => {
    const s = await setup();
    await s.quoteAndOpen();
    s.playOffer(); s.callerSays('item_1', 'yes');
    const ctx = s.contexts[0] as { consent: { read: () => unknown } };
    expect(ctx.consent.read()).toBeUndefined();
    await s.hangUp();
  });
});

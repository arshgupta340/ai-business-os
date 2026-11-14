// PROPOSED text step: the pure parts. The spoken-answer matcher is strict and fails closed.
import { describe, expect, it } from 'vitest';
import { barberSpecV1, pizzaSpecV2 } from '@abos/contracts/fixtures';
import { callerNumberFrom, matchSpokenAnswer, offerLineSpoken, spacedLast4, textOfferAllowed } from '../../src/voice/consent';
import { consentOfferSentence } from '../../src/voice/prompt';
import { specWith } from './helpers';

describe('matchSpokenAnswer', () => {
  it.each([
    // Clear affirmatives.
    ['yes', 'agreed'],
    ['Yes.', 'agreed'],
    ['YES!', 'agreed'],
    ['yeah', 'agreed'],
    ['Yep.', 'agreed'],
    ['yup', 'agreed'],
    ['Yes, please.', 'agreed'],
    ['sure', 'agreed'],
    ['Sure thing.', 'agreed'],
    ['okay', 'agreed'],
    ['OK', 'agreed'],
    ['Please do.', 'agreed'],
    ['That works.', 'agreed'],
    ['Go ahead.', 'agreed'],
    ['Yes, go ahead.', 'agreed'],
    ['Um, yes.', 'agreed'],
    ['Yeah, sure.', 'agreed'],
    ['Yes, thank you.', 'agreed'],
    ['Absolutely.', 'agreed'],
    ['Of course.', 'agreed'],
    ['Yes please do', 'agreed'],
    ['Yes, text me.', 'agreed'],
    ['Yes, send me the link.', 'agreed'],
    ['Yes, please send it.', 'agreed'],
    ['Text me.', 'agreed'],
    // A question is never an answer (Codex 5).
    ['Yes?', 'unclear'],
    ['Sure?', 'unclear'],
    ['Okay?', 'unclear'],
    ['Yes, text me?', 'unclear'],
    ["Yes, don't text me.", 'unclear'],
    ['No, text me later.', 'unclear'],
    // Clear negatives.
    ['no', 'declined'],
    ['No.', 'declined'],
    ['Nope.', 'declined'],
    ['Nah.', 'declined'],
    ['No thanks.', 'declined'],
    ['No, thank you.', 'declined'],
    ["Don't.", 'declined'],
    ["I'd rather not.", 'declined'],
    ['Do not.', 'declined'],
    ['Not now.', 'declined'],
    ['Please don’t.', 'declined'],
    ['Never.', 'declined'],
    // Traps and unclear turns.
    ['Yes, no wait.', 'unclear'],
    ['No yes.', 'unclear'],
    ['Yeah no.', 'unclear'],
    ['I guess.', 'unclear'],
    ["Sure, don't.", 'unclear'],
    ['Not sure.', 'unclear'],
    ['Maybe.', 'unclear'],
    ['Maybe later.', 'unclear'],
    ['Wait.', 'unclear'],
    ['Stop.', 'unclear'],
    ['Yes, but later.', 'unclear'],
    ['Yes or no?', 'unclear'],
    ['I think so.', 'unclear'],
    ['Probably.', 'unclear'],
    ['Sí.', 'unclear'],
    ['Oui.', 'unclear'],
    ['Ja.', 'unclear'],
    ['Um.', 'unclear'],
    ['Uh, hmm.', 'unclear'],
    ['...', 'unclear'],
    ['', 'unclear'],
    ['   ', 'unclear'],
    ['What?', 'unclear'],
    ['Text me at five five five one two one two.', 'unclear'],
    ['Yes yes yes yes yes yes yes yes yes', 'unclear'],
    ['Yes, actually send it to my other number please.', 'unclear'],
    ['Can I get a large pepperoni too?', 'unclear'],
    ['Thank you.', 'unclear'],
    ['Hello?', 'unclear'],
  ] as const)('%j is %s', (phrase, expected) => {
    expect(matchSpokenAnswer(phrase)).toBe(expected);
  });

  it('a missing transcript is unclear', () => {
    expect(matchSpokenAnswer(undefined)).toBe('unclear');
  });
});

describe('callerNumberFrom', () => {
  it.each([
    ['+15555553716', '+15555553716'],
    [' +15555553716 ', '+15555553716'],
    ['anonymous', undefined],
    ['Restricted', undefined],
    ['unknown', undefined],
    ['15555553716', undefined],
    ['+0123456789', undefined],
    ['+1555', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('%j gives %j', (from, expected) => {
    expect(callerNumberFrom(from)).toBe(expected);
  });
});

describe('textOfferAllowed', () => {
  const n = '+15555553716';
  it('needs a sending channel, a pinned number and the message capability of the bundle', () => {
    expect(textOfferAllowed(pizzaSpecV2, 'surge', n)).toBe(true);
    expect(textOfferAllowed(barberSpecV1, 'whatsapp_sandbox', n)).toBe(true);
    expect(textOfferAllowed(pizzaSpecV2, 'qr_only', n)).toBe(false);
    expect(textOfferAllowed(pizzaSpecV2, 'surge', undefined)).toBe(false);
    expect(textOfferAllowed(pizzaSpecV2, 'surge', 'anonymous')).toBe(false);
    expect(textOfferAllowed(specWith(pizzaSpecV2, { capabilities: pizzaSpecV2.capabilities.filter((c) => c !== 'message.checkout.send') }), 'surge', n)).toBe(false);
    expect(textOfferAllowed(specWith(barberSpecV1, { capabilities: barberSpecV1.capabilities.filter((c) => c !== 'message.booking.confirm') }), 'surge', n)).toBe(false);
    expect(textOfferAllowed(specWith(pizzaSpecV2, { template: 'custom' }), 'surge', n)).toBe(false);
  });

  it('spaces the last four digits', () => {
    expect(spacedLast4('+15555553716')).toBe('3 7 1 6');
  });
});

describe('offerLineSpoken: the exact offer sentence (Opus B2, Codex second review)', () => {
  const order = consentOfferSentence('restaurant_order_taker', 'surge', '3716', 1);
  const booking = consentOfferSentence('appointment_booker', 'whatsapp_sandbox', '3716', 1);

  it.each([
    ['order, text message', consentOfferSentence('restaurant_order_taker', 'surge', '3716', 1)],
    ['order, android gateway', consentOfferSentence('restaurant_order_taker', 'android_gateway', '3716', 1)],
    ['order, WhatsApp', consentOfferSentence('restaurant_order_taker', 'whatsapp_sandbox', '3716', 1)],
    ['order, plain message', consentOfferSentence('restaurant_order_taker', 'agentphone', '3716', 1)],
    ['booking, WhatsApp', booking],
    ['booking, text message', consentOfferSentence('appointment_booker', 'surge', '3716', 1)],
    ['the re-ask', consentOfferSentence('restaurant_order_taker', 'surge', '3716', 2)],
  ])('the exact sentence passes: %s', (_label, sentence) => {
    expect(offerLineSpoken(sentence, sentence)).toBe(true);
  });

  it.each([
    ['digits unspaced', 'Would you like one text message with your payment link, sent to the number you are calling from, ending in 3716?'],
    ['digits as words', 'Would you like one text message with your payment link, sent to the number you are calling from, ending in three seven one six?'],
    ['"one" as a digit', 'Would you like 1 text message with your payment link, sent to the number you are calling from, ending in 3 7 1 6?'],
    ['case, punctuation and spacing', 'would  you like one TEXT message with your payment link sent to the number you are calling from ending in 3-7-1-6.'],
  ])('a harmless variant passes: %s', (_label, said) => {
    expect(offerLineSpoken(order, said)).toBe(true);
  });

  it.each([
    ['marketing', 'Would you like a marketing message sent to the number you are calling from ending in 3 7 1 6?'],
    ['a different last four', 'Would you like one text message with your payment link, sent to the number you are calling from, ending in 3 7 1 5?'],
    ['"one" dropped', 'Would you like text message with your payment link, sent to the number you are calling from, ending in 3 7 1 6?'],
    ['"a" for "one"', 'Would you like a text message with your payment link, sent to the number you are calling from, ending in 3 7 1 6?'],
    ['two messages', 'Would you like two text messages with your payment link, sent to the number you are calling from, ending in 3 7 1 6?'],
    ['a different content', 'Would you like one text message with your receipt, sent to the number you are calling from, ending in 3 7 1 6?'],
    ['added offers', 'Would you like one text message with your payment link and our offers, sent to the number you are calling from, ending in 3 7 1 6?'],
    ['another number', 'Would you like one text message with your payment link, sent to another number, ending in 3 7 1 6?'],
    ['the booking content on an order', booking],
    ['a different channel word', consentOfferSentence('restaurant_order_taker', 'whatsapp_sandbox', '3716', 1)],
    ['the approval question', 'Shall I send this to the shop for approval?'],
    ['clauses out of order', 'Sent to the number you are calling from, ending in 3 7 1 6, would you like one text message with your payment link?'],
    ['empty', ''],
  ])('fails: %s', (_label, said) => {
    expect(offerLineSpoken(order, said)).toBe(false);
  });

  it('a missing transcript fails, and the re-ask needs its own sentence', () => {
    expect(offerLineSpoken(order, undefined)).toBe(false);
    const reask = consentOfferSentence('restaurant_order_taker', 'surge', '3716', 2);
    expect(offerLineSpoken(reask, 'Okay, great.')).toBe(false);
    expect(offerLineSpoken(reask, order)).toBe(false);
  });
});

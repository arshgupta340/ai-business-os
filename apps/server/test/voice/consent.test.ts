// PROPOSED text step: the pure parts. The spoken-answer matcher is strict and fails closed.
import { describe, expect, it } from 'vitest';
import { barberSpecV1, pizzaSpecV2 } from '@abos/contracts/fixtures';
import { callerNumberFrom, matchSpokenAnswer, spacedLast4, textOfferAllowed } from '../../src/voice/consent';
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

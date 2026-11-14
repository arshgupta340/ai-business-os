// Spoken replies are plain text: the phone prompt says so, server status text carries no Markdown,
// and sim-call shows the agent's line without Markdown.
import { describe, expect, it } from 'vitest';
import { PLAIN_SPEECH_RULE, buildInstructions, decisionInstruction, plainSpeech } from '../../src/voice/prompt';
import { barberSpecV1, pizzaSpecV2 } from '@abos/contracts/fixtures';
import { specWith } from './helpers';

describe('plainSpeech', () => {
  it('strips Markdown emphasis, code, headings and list markers and keeps the words', () => {
    expect(plainSpeech('That comes to **$23.93**.')).toBe('That comes to $23.93.');
    expect(plainSpeech('It is *really* __good__ and ~~cheap~~ `now`.')).toBe('It is really good and cheap now.');
    expect(plainSpeech('## Menu\n- Pepperoni\n* Cheese\n1. Veggie\n> quoted')).toBe('Menu\nPepperoni\nCheese\nVeggie\nquoted');
    expect(plainSpeech('Order ord_abc_12 for 2 * 3 items, total 5*2')).toBe('Order ord_abc_12 for 2 * 3 items, total 5*2');
    expect(plainSpeech('stray ** markers')).toBe('stray  markers');
  });
  it('the phone instructions and the server status lines say plain speech, with no Markdown', () => {
    for (const template of ['restaurant_order_taker', 'appointment_booker', 'custom'] as const) {
      const base = template === 'appointment_booker' ? barberSpecV1 : pizzaSpecV2;
      const text = buildInstructions(specWith(base, { template }), { businessName: 'Demo Pizza Co.', messageChannel: 'surge' });
      expect(text).toContain(PLAIN_SPEECH_RULE);
    }
    expect(PLAIN_SPEECH_RULE).toMatch(/no Markdown/);
    for (const kind of ['approved', 'rejected', 'expired'] as const) {
      const text = decisionInstruction('restaurant_order_taker', kind === 'approved' ? { kind, messageSent: true } : { kind }, 'surge');
      expect(plainSpeech(text)).toBe(text);
    }
  });
});

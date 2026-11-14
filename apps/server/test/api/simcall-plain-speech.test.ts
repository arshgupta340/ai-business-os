// Sim-call shows the agent's line without Markdown. The phone prompt's own plain-speech rule is
// tested with the voice module (prompt.test.ts).
import { describe, expect, it } from 'vitest';
import { PLAIN_SPEECH_RULE, plainSpeech } from '../../src/api/simcall/plain';

describe('plainSpeech', () => {
  it('strips Markdown emphasis, code, headings and list markers and keeps the words', () => {
    expect(plainSpeech('That comes to **$23.93**.')).toBe('That comes to $23.93.');
    expect(plainSpeech('It is *really* __good__ and ~~cheap~~ `now`.')).toBe('It is really good and cheap now.');
    expect(plainSpeech('## Menu\n- Pepperoni\n* Cheese\n1. Veggie\n> quoted')).toBe('Menu\nPepperoni\nCheese\nVeggie\nquoted');
    expect(plainSpeech('Order ord_abc_12 for 2 * 3 items, total 5*2')).toBe('Order ord_abc_12 for 2 * 3 items, total 5*2');
    expect(plainSpeech('stray ** markers')).toBe('stray  markers');
  });
  it('the sim-call rule says no Markdown', () => {
    expect(PLAIN_SPEECH_RULE).toMatch(/no Markdown/);
  });
});

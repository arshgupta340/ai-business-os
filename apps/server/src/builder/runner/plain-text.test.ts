import { describe, expect, it } from 'vitest';
import { toPlainSpokenText } from './plain-text';

describe('toPlainSpokenText', () => {
  it('removes bold and italic marks (the reply seen with the real model)', () => {
    expect(toPlainSpokenText('Two large pepperoni comes to **$23.93** with tax.')).toBe('Two large pepperoni comes to $23.93 with tax.');
    expect(toPlainSpokenText('That is *really* fresh and __very__ hot, _today_ only.')).toBe('That is really fresh and very hot, today only.');
    expect(toPlainSpokenText('~~old~~ new `code`')).toBe('old new code');
  });

  it('turns a list into sentences on one line', () => {
    expect(toPlainSpokenText('We have:\n- Margherita\n- Pepperoni, from $14\n1. Small\n2) Large.')).toBe(
      'We have: Margherita. Pepperoni, from $14. Small. Large.',
    );
    expect(toPlainSpokenText('* one\n+ two\n• three')).toBe('one. two. three.');
  });

  it('removes headings, quotes, rules and links', () => {
    expect(toPlainSpokenText('## Hours\n> Open at 11.\n---\nSee [our menu](https://example.com/menu).')).toBe('Hours Open at 11. See our menu.');
  });

  it('keeps underscores inside words and IDs, and plain text as it is', () => {
    expect(toPlainSpokenText('Approval apv_mock_0001 for policy.pickup_window is pending.')).toBe('Approval apv_mock_0001 for policy.pickup_window is pending.');
    expect(toPlainSpokenText('On Saturday we are open from 11 am to 10 pm.')).toBe('On Saturday we are open from 11 am to 10 pm.');
    expect(toPlainSpokenText('2 * 3 is not emphasis')).toBe('2 * 3 is not emphasis');
  });

  it('drops an unmatched bold mark', () => {
    expect(toPlainSpokenText('Total **$47.85 with tax')).toBe('Total $47.85 with tax');
  });
});

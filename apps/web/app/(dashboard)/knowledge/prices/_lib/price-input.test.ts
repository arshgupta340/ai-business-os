import {describe, expect, it} from 'vitest';
import {MAX_PRICE_MINOR, minorToInput, parseDollarsToMinor, validateNewPrice} from './price-input';

const minor = (s: string) => {
  const r = parseDollarsToMinor(s);
  return r.ok ? r.minor : r.message;
};

describe('parseDollarsToMinor', () => {
  it('converts amounts that break floating point math to exact cents', () => {
    // 19.99 * 100 is 1998.9999999999998 in floating point.
    expect(19.99 * 100).not.toBe(1999);
    expect(minor('19.99')).toBe(1999);
    // 0.1 + 0.2 is 0.30000000000000004.
    expect(minor('0.3')).toBe(30);
    expect(minor('0.30')).toBe(30);
    expect(minor('1.15')).toBe(115);
    expect(minor('4.35')).toBe(435);
    expect(minor('0.07')).toBe(7);
  });

  it('reads whole dollars, one decimal, a dollar sign, spaces and thousands separators', () => {
    expect(minor('20')).toBe(2000);
    expect(minor('20.')).toBe(2000);
    expect(minor('20.5')).toBe(2050);
    expect(minor('.5')).toBe(50);
    expect(minor(' $ 21.00 ')).toBe(2100);
    expect(minor('$21')).toBe(2100);
    expect(minor('1,250.00')).toBe(125000);
    expect(minor('007.50')).toBe(750);
  });

  it('accepts trailing zeros after the cents but not a fraction of a cent', () => {
    expect(minor('19.900')).toBe(1990);
    expect(minor('19.9900000')).toBe(1999);
    expect(minor('19.991')).toBe('Use at most two digits after the decimal point.');
    expect(minor('1.005')).toBe('Use at most two digits after the decimal point.');
  });

  it('rejects input that is not a plain amount', () => {
    for (const bad of ['', '   ', '$', '.', 'abc', '12a', '1e3', '-5', '+5', '1.2.3', '12,34', '1,2345', '20 dollars', 'NaN', 'Infinity', '0x10']) {
      const r = parseDollarsToMinor(bad);
      expect(r.ok, bad).toBe(false);
    }
  });

  it('rejects absurdly long numbers instead of losing precision', () => {
    expect(parseDollarsToMinor('12345678901').ok).toBe(false);
  });
});

describe('minorToInput', () => {
  it('formats cents for the field', () => {
    expect(minorToInput(2000)).toBe('20.00');
    expect(minorToInput(1999)).toBe('19.99');
    expect(minorToInput(5)).toBe('0.05');
    expect(minorToInput(0)).toBe('0.00');
  });

  it('round trips with the parser', () => {
    for (const m of [1, 9, 10, 99, 100, 1999, 2100, 99999, MAX_PRICE_MINOR]) {
      expect(minor(minorToInput(m))).toBe(m);
    }
  });
});

describe('validateNewPrice', () => {
  it('requires a positive amount', () => {
    expect(validateNewPrice('0', 2000)).toEqual({ok: false, message: 'The price must be more than $0.00.'});
    expect(validateNewPrice('0.00', 2000).ok).toBe(false);
  });

  it('has an upper bound of $1,000.00', () => {
    expect(validateNewPrice('1000', 2000)).toEqual({ok: true, minor: 100000});
    expect(validateNewPrice('1000.01', 2000)).toEqual({ok: false, message: 'The price must be $1,000.00 or less.'});
    expect(validateNewPrice('2000', 2000).ok).toBe(false);
  });

  it('refuses the current price, however it is written', () => {
    for (const same of ['20', '20.00', '$20.0', '20.000']) {
      expect(validateNewPrice(same, 2000)).toEqual({ok: false, message: 'This is already the current price.'});
    }
  });

  it('passes a valid new price through as minor units', () => {
    expect(validateNewPrice('21.00', 2000)).toEqual({ok: true, minor: 2100});
  });

  it('passes parse errors through', () => {
    expect(validateNewPrice('abc', 2000).ok).toBe(false);
  });
});

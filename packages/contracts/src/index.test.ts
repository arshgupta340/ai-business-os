import { describe, expect, it } from 'vitest';
import { CONTRACTS_VERSION } from './index';

describe('contracts package', () => {
  it('exports a version', () => {
    expect(CONTRACTS_VERSION).toBe('1.0.0');
  });
});

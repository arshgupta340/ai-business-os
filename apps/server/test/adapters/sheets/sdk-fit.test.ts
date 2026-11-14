import { sheets } from '@googleapis/sheets';
import { describe, expect, it } from 'vitest';
import type { GoogleSheetsClient } from '../../../src/adapters/sheets/types';

describe('narrow Google Sheets client', () => {
  it('is satisfied by the real SDK client (a compile-time check; no request is made)', () => {
    const real: GoogleSheetsClient = sheets({ version: 'v4' });
    expect(typeof real.spreadsheets.values.append).toBe('function');
  });
});

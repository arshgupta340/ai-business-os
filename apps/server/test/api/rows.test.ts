import { describe, expect, it } from 'vitest';
import { mapRow } from '../../src/api/rows';

describe('database row mapping', () => {
  it('keeps JSON null values and JSON keys while omitting absent optional SQL columns', () => {
    expect(mapRow({ id: 'fact_a', value: null, source_ref: null, created_at: new Date('2026-11-13T00:00:00Z'), confidence: '0.75',
      payload: { field_name: null } })).toEqual({ id: 'fact_a', value: null, createdAt: '2026-11-13T00:00:00.000Z', confidence: 0.75,
      payload: { field_name: null } });
  });
});

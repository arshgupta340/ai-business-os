import { describe, expect, it, vi } from 'vitest';
import { bookingVerified, orderPaid } from '@abos/contracts/fixtures';
import { bookingRow, createSheetsAdapter, orderRow, REPORTING_HEADER } from '../../../src/adapters/sheets';
import type { GoogleSheetsClient, ReportingRow } from '../../../src/adapters/sheets/types';

function setup() {
  const rows: ReportingRow[] = [];
  const get = vi.fn<GoogleSheetsClient['spreadsheets']['values']['get']>(async () => ({ data: { values: [rows.map(row => row[0])] } }));
  const update = vi.fn<GoogleSheetsClient['spreadsheets']['values']['update']>(async req => { rows.push(...req.requestBody.values); return {}; });
  const append = vi.fn<GoogleSheetsClient['spreadsheets']['values']['append']>(async req => { rows.push(...req.requestBody.values); return { data: { updates: { updatedRows: 1 } } }; });
  const adapter = createSheetsAdapter({ client: { spreadsheets: { values: { get, update, append } } }, timeoutMs: 50 });
  return { rows, get, update, append, adapter };
}
const input = { sheetId: 'sheet', tab: "Owner's report", recordId: orderPaid.id, row: orderRow(orderPaid) };
describe('Sheets reporting adapter', () => {
  it('creates a header, appends once, then skips a repeated record', async () => {
    const s = setup();
    expect(await s.adapter.appendOnce(input)).toEqual({ ok: true, status: 'appended' });
    expect(await s.adapter.appendOnce(input)).toEqual({ ok: true, status: 'skipped' });
    expect(s.rows).toEqual([REPORTING_HEADER, input.row]);
    expect(s.append).toHaveBeenCalledTimes(1);
    expect(s.update).toHaveBeenCalledTimes(1);
    expect(s.get.mock.calls[0]![0].range).toBe("'Owner''s report'!A:A");
    expect(s.append.mock.calls[0]![0].valueInputOption).toBe('RAW');
  });
  it('does not add a header to an existing tab', async () => {
    const s = setup(); s.rows.push([...REPORTING_HEADER]);
    await s.adapter.appendOnce(input);
    expect(s.update).not.toHaveBeenCalled();
  });
  it('serializes concurrent calls within one adapter', async () => {
    const s = setup();
    const results = await Promise.all([s.adapter.appendOnce(input), s.adapter.appendOnce(input)]);
    expect(results).toEqual([{ ok: true, status: 'appended' }, { ok: true, status: 'skipped' }]);
    expect(s.append).toHaveBeenCalledTimes(1);
  });
  it('builds explicit reporting columns without names or phone numbers', () => {
    const order = orderRow(orderPaid), booking = bookingRow(bookingVerified);
    expect(order).toEqual([orderPaid.id, 'order', orderPaid.businessId, orderPaid.status, orderPaid.totalMinor, orderPaid.currency, '', '', orderPaid.createdAt, 'sandbox']);
    expect(booking).toEqual([bookingVerified.id, 'booking', bookingVerified.businessId, bookingVerified.status, '', '', bookingVerified.serviceName, bookingVerified.startUtc, bookingVerified.createdAt, '']);
    expect(JSON.stringify(order)).not.toContain(orderPaid.contact.name);
    expect(JSON.stringify(order)).not.toContain(orderPaid.contact.messageRecipient);
    expect(JSON.stringify(booking)).not.toContain(bookingVerified.customer.name);
    expect(JSON.stringify(booking)).not.toContain(bookingVerified.customer.messageRecipient);
  });
  it.each(['get', 'update', 'append'] as const)('maps %s failures to retryable errors', async operation => {
    const s = setup(); s[operation].mockRejectedValue(new Error('private provider token timeout'));
    expect(await s.adapter.appendOnce(input)).toEqual({ ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true });
  });
  it('reconciles a committed append whose response timed out', async () => {
    const s = setup();
    s.append.mockImplementationOnce(async req => { s.rows.push(...req.requestBody.values); throw new Error('timeout'); });
    expect(await s.adapter.appendOnce(input)).toMatchObject({ ok: false, retryable: true });
    expect(await s.adapter.appendOnce(input)).toEqual({ ok: true, status: 'skipped' });
    expect(s.rows.filter(row => row[0] === input.recordId)).toHaveLength(1);
  });
  it('creates the header row when the tab reads back with no values at all', async () => {
    const s = setup();
    s.get.mockResolvedValueOnce({ data: {} });
    expect(await s.adapter.appendOnce(input)).toEqual({ ok: true, status: 'appended' });
    expect(s.update.mock.calls[0]![0]).toMatchObject({ range: "'Owner''s report'!A1", valueInputOption: 'RAW', requestBody: { values: [[...REPORTING_HEADER]] } });
  });
  it('appends a booking row once and skips it on repeat', async () => {
    const s = setup();
    const booking = { sheetId: 'sheet', tab: 'Bookings', recordId: bookingVerified.id, row: bookingRow(bookingVerified) };
    expect(await s.adapter.appendOnce(booking)).toEqual({ ok: true, status: 'appended' });
    expect(await s.adapter.appendOnce(booking)).toEqual({ ok: true, status: 'skipped' });
    expect(s.append).toHaveBeenCalledTimes(1);
  });
  it('lets the job runner put its own key in the record id column', () => {
    const key = 'b'.repeat(64);
    expect(orderRow(orderPaid, key)[0]).toBe(key);
    expect(bookingRow(bookingVerified, key)[0]).toBe(key);
  });
  it('labels every order row sandbox and keeps the header aligned with the rows', () => {
    expect(orderRow(orderPaid)).toHaveLength(REPORTING_HEADER.length);
    expect(bookingRow(bookingVerified)).toHaveLength(REPORTING_HEADER.length);
    expect(orderRow(orderPaid)[REPORTING_HEADER.indexOf('environment')]).toBe('sandbox');
  });
  it('maps a provider timeout to a retryable failure', async () => {
    const s = setup();
    s.get.mockImplementationOnce(() => new Promise<never>(() => {}));
    expect(await s.adapter.appendOnce(input)).toEqual({ ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true });
    expect(s.append).not.toHaveBeenCalled();
  });
  it('does not report success when Google does not confirm one appended row', async () => {
    const s = setup();
    s.append.mockResolvedValueOnce({ data: { updates: { updatedRows: 0 } } });
    expect(await s.adapter.appendOnce(input)).toEqual({ ok: false, reason: 'INTEGRATION_UNAVAILABLE', retryable: true });
  });
  it('refuses mismatched record IDs without a write', async () => {
    const s = setup();
    expect(await s.adapter.appendOnce({ ...input, recordId: 'ord_other' })).toMatchObject({ ok: false, reason: 'VALIDATION_FAILED' });
    expect(s.append).not.toHaveBeenCalled();
  });
});

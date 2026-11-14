// Live verification found the demo sheet shared but without the Orders and Bookings tabs: health said
// "connected" while every Sheets job failed. The probe now checks the tabs the reporting job writes to.
import { describe, expect, it } from 'vitest';
import { sheetsProbe } from '../../src/compose/providers';
import { SHEETS_TABS } from '../../src/compose/executor';

function fakeClient(titles: string[] | 'throw') {
  const calls: { fields?: string }[] = [];
  const client = { spreadsheets: { async get(input: { spreadsheetId: string; fields?: string }) {
    calls.push({ fields: input.fields });
    if (titles === 'throw') throw new Error('403');
    return { data: { sheets: titles.map((title) => ({ properties: { title } })) } };
  } } };
  return { client, calls };
}

describe('Sheets health probe', () => {
  it('is connected when both reporting tabs exist, reading only tab titles', async () => {
    const { client, calls } = fakeClient(['Sheet1', SHEETS_TABS.order, SHEETS_TABS.booking]);
    expect(await sheetsProbe(client, 'sheet_1')()).toEqual({ ok: true, detail: 'sheet shared' });
    expect(calls).toEqual([{ fields: 'sheets.properties.title' }]);
  });

  it('is disconnected and names the missing tabs', async () => {
    expect(await sheetsProbe(fakeClient(['Sheet1']).client, 'sheet_1')()).toEqual({ ok: false, detail: 'sheet missing tabs: Orders, Bookings' });
    expect(await sheetsProbe(fakeClient(['Orders']).client, 'sheet_1')()).toEqual({ ok: false, detail: 'sheet missing tabs: Bookings' });
  });

  it('is disconnected when the sheet cannot be read', async () => {
    expect(await sheetsProbe(fakeClient('throw').client, 'sheet_1')()).toEqual({ ok: false, detail: 'sheet not readable by the service account' });
  });
});

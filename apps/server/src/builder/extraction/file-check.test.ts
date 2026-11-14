import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors';
import { parseCsv } from './csv';
import { checkUpload, cleanFileName } from './file-check';
import { inspectXlsxZip, SpreadsheetError } from './spreadsheet';
import { HOURS_CSV, jpeg, pdf, PIZZA_MENU_TEXT, png, webp, xlsx } from './test-samples';
import { MAX_UPLOAD_BYTES, XLSX_MIME } from './types';

async function refusal(input: Parameters<typeof checkUpload>[0]) {
  const error = await checkUpload(input).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe('VALIDATION_FAILED');
  expect((error as AppError).status).toBe(400);
  return (error as AppError).message;
}

describe('upload check: accepted types', () => {
  it.each([
    ['menu.pdf', 'application/pdf', () => pdf(PIZZA_MENU_TEXT)],
    ['menu.png', 'image/png', () => png('menu')],
    ['menu.jpg', 'image/jpeg', () => jpeg('menu')],
    ['menu.jpeg', 'image/jpeg', () => jpeg('menu')],
    ['menu.webp', 'image/webp', () => webp('menu')],
    ['hours.csv', 'text/csv', () => Buffer.from(HOURS_CSV)],
  ])('accepts %s as %s', async (fileName, mime, make) => {
    await expect(checkUpload({ fileName, declaredMime: mime, bytes: make() })).resolves.toEqual({ name: fileName, mime });
  });

  it('accepts an xlsx workbook', async () => {
    const bytes = await xlsx([['day', 'open', 'close'], ['mon', '11:00', '22:00']]);
    await expect(checkUpload({ fileName: 'hours.xlsx', declaredMime: XLSX_MIME, bytes })).resolves.toEqual({ name: 'hours.xlsx', mime: XLSX_MIME });
  });

  it('accepts a declared type with parameters, such as a charset', async () => {
    await expect(checkUpload({ fileName: 'h.csv', declaredMime: 'text/csv; charset=utf-8', bytes: Buffer.from(HOURS_CSV) })).resolves.toMatchObject({ mime: 'text/csv' });
  });
});

describe('upload check: refused', () => {
  it('refuses a type outside the list', async () => {
    expect(await refusal({ fileName: 'notes.txt', declaredMime: 'text/plain', bytes: Buffer.from('hello') })).toMatch(/Only PDF/);
    expect(await refusal({ fileName: 'menu.gif', declaredMime: 'image/gif', bytes: Buffer.from('GIF89a') })).toMatch(/Only PDF/);
    expect(await refusal({ fileName: 'macro.xlsm', declaredMime: 'application/vnd.ms-excel.sheet.macroEnabled.12', bytes: Buffer.from('PK') })).toMatch(/Only PDF/);
    expect(await refusal({ fileName: 'no-extension', declaredMime: 'application/pdf', bytes: pdf('x') })).toMatch(/Only PDF/);
  });

  it('refuses a declared type that does not match the file name', async () => {
    expect(await refusal({ fileName: 'menu.pdf', declaredMime: 'image/png', bytes: png('x') })).toMatch(/does not match the file name/);
  });

  it('refuses content that does not match the declared type', async () => {
    const msg = /content does not match/;
    expect(await refusal({ fileName: 'menu.pdf', declaredMime: 'application/pdf', bytes: png('x') })).toMatch(msg);
    expect(await refusal({ fileName: 'menu.png', declaredMime: 'image/png', bytes: pdf('x') })).toMatch(msg);
    expect(await refusal({ fileName: 'menu.jpg', declaredMime: 'image/jpeg', bytes: Buffer.from('<html>') })).toMatch(msg);
    expect(await refusal({ fileName: 'menu.webp', declaredMime: 'image/webp', bytes: Buffer.from('RIFF0000WAVEfmt ') })).toMatch(msg);
    // Binary bytes declared as CSV, and a stray quote.
    expect(await refusal({ fileName: 'h.csv', declaredMime: 'text/csv', bytes: png('x') })).toMatch(msg);
    expect(await refusal({ fileName: 'h.csv', declaredMime: 'text/csv', bytes: Buffer.from('a,b"c\n') })).toMatch(msg);
    // A PDF declared as a spreadsheet, and a zip that is not a workbook.
    expect(await refusal({ fileName: 'h.xlsx', declaredMime: XLSX_MIME, bytes: pdf('x') })).toMatch(msg);
    expect(await refusal({ fileName: 'h.xlsx', declaredMime: XLSX_MIME, bytes: Buffer.from('PK\u0003\u0004 not really a zip', 'latin1') })).toMatch(msg);
  });

  it('refuses an empty file and a file over 10 MB', async () => {
    expect(await refusal({ fileName: 'menu.pdf', declaredMime: 'application/pdf', bytes: Buffer.alloc(0) })).toMatch(/empty/);
    const big = png('x', MAX_UPLOAD_BYTES + 1);
    expect(await refusal({ fileName: 'menu.png', declaredMime: 'image/png', bytes: big })).toMatch(/larger than 10 MB/);
    await expect(checkUpload({ fileName: 'menu.png', declaredMime: 'image/png', bytes: png('x', MAX_UPLOAD_BYTES) })).resolves.toMatchObject({ mime: 'image/png' });
  });

  it('never echoes file content in the message', async () => {
    const message = await refusal({ fileName: 'menu.pdf', declaredMime: 'application/pdf', bytes: Buffer.from('SECRET-CONTENT-123') });
    expect(message).not.toContain('SECRET');
  });
});

describe('file names, CSV and zip inspection', () => {
  it('reduces a file name to a safe display name', () => {
    expect(cleanFileName('../../etc/menu.pdf')).toBe('menu.pdf');
    expect(cleanFileName('C:\\Users\\me\\menu\u0000.pdf')).toBe('menu.pdf');
    expect(cleanFileName('a'.repeat(300) + '.pdf')).toHaveLength(200);
  });

  it('parses quoted CSV fields and skips blank lines', () => {
    expect(parseCsv('name,price\r\n"Pizza, large","21.00"\n\n"say ""hi""",1\n')).toEqual([
      ['name', 'price'],
      ['Pizza, large', '21.00'],
      ['say "hi"', '1'],
    ]);
    expect(() => parseCsv('"open')).toThrow();
  });

  it('refuses a zip that declares too much uncompressed data', async () => {
    const bytes = await xlsx([['a']]);
    // Rewrite the first central directory entry's uncompressed size.
    const cd = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const forged = Buffer.from(bytes);
    forged.writeUInt32LE(200 * 1024 * 1024, cd + 24);
    expect(() => inspectXlsxZip(forged)).toThrow(SpreadsheetError);
    expect(() => inspectXlsxZip(bytes)).not.toThrow();
  });
});

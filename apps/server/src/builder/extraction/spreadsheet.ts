import ExcelJS from 'exceljs';

// Reading .xlsx uploads. An .xlsx file is a zip archive. Before the archive
// reaches exceljs, inspectXlsxZip reads the zip central directory itself and
// refuses archives that are not a workbook or that declare too much
// uncompressed data (a zip bomb), so a 10 MB upload cannot expand into
// gigabytes in memory. The declared sizes can lie; this check is a first
// line, and the row and cell caps in readXlsxRows are the second.

export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetError';
  }
}

const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED_BYTES = 60 * 1024 * 1024;

export const ROW_LIMITS = { sheets: 5, rowsPerSheet: 1000, cellsPerRow: 30, charsPerCell: 200 } as const;

export function inspectXlsxZip(bytes: Buffer): void {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw new SpreadsheetError('not a zip archive');
  // The end of central directory record sits in the last 22 + 65535 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SpreadsheetError('zip end record missing');
  const entries = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) throw new SpreadsheetError('zip64 archives are not accepted');
  if (entries > MAX_ENTRIES) throw new SpreadsheetError('too many zip entries');
  if (cdOffset + cdSize > bytes.length) throw new SpreadsheetError('zip directory out of range');

  const names = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== 0x02014b50) throw new SpreadsheetError('bad zip directory entry');
    const uncompressed = bytes.readUInt32LE(p + 24);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    if (uncompressed === 0xffffffff) throw new SpreadsheetError('zip64 entries are not accepted');
    total += uncompressed;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new SpreadsheetError('archive expands too far');
    names.add(bytes.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) throw new SpreadsheetError('zip is not an xlsx workbook');
  if ([...names].some((name) => name.toLowerCase().endsWith('vbaproject.bin'))) throw new SpreadsheetError('macro workbooks are not accepted');
}

// Every sheet's rows as plain strings, capped by ROW_LIMITS. Formulas are
// read as their cached result text; nothing in the workbook is evaluated.
export async function readXlsxRows(bytes: Buffer): Promise<{ sheet: string; rows: string[][] }[]> {
  inspectXlsxZip(bytes);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new SpreadsheetError('workbook could not be read');
  }
  const out: { sheet: string; rows: string[][] }[] = [];
  for (const sheet of workbook.worksheets.slice(0, ROW_LIMITS.sheets)) {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= ROW_LIMITS.rowsPerSheet) return;
      const cells: string[] = [];
      const count = Math.min(row.cellCount, ROW_LIMITS.cellsPerRow);
      for (let c = 1; c <= count; c++) {
        let text = '';
        try {
          text = row.getCell(c).text ?? '';
        } catch {
          text = '';
        }
        cells.push(String(text).slice(0, ROW_LIMITS.charsPerCell));
      }
      if (cells.some((v) => v.trim() !== '')) rows.push(cells);
    });
    out.push({ sheet: sheet.name.slice(0, 60), rows });
  }
  return out;
}

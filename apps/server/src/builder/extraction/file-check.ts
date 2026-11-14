import { apiError } from '../util';
import { CsvParseError, parseCsv } from './csv';
import { readXlsxRows, SpreadsheetError } from './spreadsheet';
import { FileMimeSchema, UPLOAD_MAX_BYTES, type FileMime } from '@abos/contracts';

// The upload cap (SPEC 2.9) and the accepted types (API.md 3.2, P-12), from the package.
export const MAX_UPLOAD_BYTES = UPLOAD_MAX_BYTES;
export const ACCEPTED_MIME: readonly FileMime[] = FileMimeSchema.options;
export const XLSX_MIME = FileMimeSchema.enum['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

// The upload check. It runs on the server before anything is stored or sent
// to a model. Three things must agree: the file name's extension, the
// declared content type, and the real content (magic bytes for PDF and
// images, a full parse for CSV and spreadsheets). Anything else is refused
// with VALIDATION_FAILED (API.md 3.2). The messages never echo file content.

const EXTENSIONS: Record<string, FileMime> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  csv: 'text/csv',
  xlsx: XLSX_MIME,
};

export interface CheckedUpload {
  name: string;
  mime: FileMime;
}

function refuse(message: string, path = 'file') {
  return apiError('VALIDATION_FAILED', message, { issues: [{ path, message }] });
}

// The original file name, reduced to a safe display string: no directory
// part, no control characters, at most 200 characters.
export function cleanFileName(raw: string | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, 200);
}

const startsWith = (bytes: Buffer, sig: number[], at = 0) => bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);

export function contentMatches(mime: FileMime, bytes: Buffer): boolean {
  switch (mime) {
    case 'application/pdf':
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/webp':
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8); // RIFF....WEBP
    case 'text/csv':
    case XLSX_MIME:
      return true; // checked by parsing, below
  }
}

// Decodes CSV bytes as strict UTF-8 and parses them. Throws CsvParseError.
export function decodeCsv(bytes: Buffer): string[][] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CsvParseError('not valid UTF-8 text');
  }
  if (text.includes('\u0000')) throw new CsvParseError('binary content');
  const rows = parseCsv(text);
  if (rows.length === 0) throw new CsvParseError('no rows');
  return rows;
}

export async function checkUpload(input: { fileName: string | undefined; declaredMime: string | undefined; bytes: Buffer }): Promise<CheckedUpload> {
  const name = cleanFileName(input.fileName);
  if (!name) throw refuse('The file needs a name.');
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const byExtension = EXTENSIONS[ext];
  if (!byExtension) throw refuse('Only PDF, PNG, JPEG, WEBP, CSV and XLSX files are accepted.');

  const declared = (input.declaredMime ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(ACCEPTED_MIME as readonly string[]).includes(declared)) {
    throw refuse('Only PDF, PNG, JPEG, WEBP, CSV and XLSX files are accepted.');
  }
  if (declared !== byExtension) throw refuse('The file type does not match the file name.');
  const mime = declared as FileMime;

  if (input.bytes.length === 0) throw refuse('The file is empty.');
  if (input.bytes.length > MAX_UPLOAD_BYTES) throw refuse('The file is larger than 10 MB.');

  if (!contentMatches(mime, input.bytes)) throw refuse('The file content does not match its type.');
  if (mime === 'text/csv') {
    try {
      decodeCsv(input.bytes);
    } catch (error) {
      if (error instanceof CsvParseError) throw refuse('The file content does not match its type.');
      throw error;
    }
  }
  if (mime === XLSX_MIME) {
    try {
      await readXlsxRows(input.bytes);
    } catch (error) {
      if (error instanceof SpreadsheetError) throw refuse('The file content does not match its type.');
      throw refuse('The file content does not match its type.');
    }
  }
  return { name, mime };
}

/** Map SQL columns only. JSON values already use contract keys and must stay intact. */
export function mapRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a database row.');
  const output: Record<string, unknown> = {};
  for (const [column, raw] of Object.entries(value)) {
    if (raw === undefined || (raw === null && column !== 'value')) continue;
    const key = column.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
    output[key] = raw instanceof Date ? raw.toISOString() : column === 'confidence' ? Number(raw) : raw;
  }
  return output;
}

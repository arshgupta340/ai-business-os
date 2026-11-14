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

/**
 * An approval row as the contract shows it. `approval_requests.payload` may hold server-side fields
 * beside the hashed material (today only `resolvesConflictId` on a fact edit, policy/engine.ts). The
 * contract payload is exactly the material, which the database keeps as `payload_canonical` and
 * checks against the hash, so that text is what every reader of an approval gets.
 */
export function mapApprovalRow(value: unknown): Record<string, unknown> {
  const row = mapRow(value);
  if (typeof row.payloadCanonical === 'string') row.payload = JSON.parse(row.payloadCanonical) as unknown;
  return row;
}

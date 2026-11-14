// Stored hash values for the fixtures. The contract hash functions are async (Web Crypto), so the
// values are computed once by `generate-hashes.ts` and stored in `hashes.generated.ts`.
// The fixture test recomputes every value and fails if one is stale.
//
// Regenerate after changing a cart, an approval payload or an execution:
//   npx tsx packages/contracts/fixtures/generate-hashes.ts
import { GENERATED_HASHES } from './hashes.generated';

const ZERO_HEX = '0'.repeat(64);

/** `sha256:` hash stored under `key` (`cart:<ord_id>` or `payload:<apv_id>`). Zero hash until generated. */
export function storedHash(key: string): string {
  return GENERATED_HASHES[key] ?? `sha256:${ZERO_HEX}`;
}

/** 64-hex idempotency key stored under `idem:<exe_id>`. Zeros until generated. */
export function storedKey(key: string): string {
  return GENERATED_HASHES[key] ?? ZERO_HEX;
}

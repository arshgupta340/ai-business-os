// Shared helpers for the Square spike: client, files, idempotency keys, cart,
// error printing. Pure helpers live in verify.ts so tests need no env.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SquareClient, SquareEnvironment, SquareError, type Square } from "square";

export const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOG_IDS_FILE = join(SPIKE_DIR, "catalog-ids.json");
export const LAST_LINK_FILE = join(SPIKE_DIR, "last-link.json");
export const LAST_QUOTE_FILE = join(SPIKE_DIR, "last-quote.json");

export function makeClient(token: string): SquareClient {
  // Always sandbox. env.ts has already refused anything else.
  return new SquareClient({ token, environment: SquareEnvironment.Sandbox });
}

// ---------- JSON files (Money.amount is a bigint in SDK v46) ----------

export function writeJson(path: string, value: unknown): void {
  const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  writeFileSync(path, text + "\n", "utf8");
}

export function readJson<T>(path: string, hint: string): T {
  if (!existsSync(path)) {
    console.error(`MISSING FILE: ${path} does not exist. ${hint}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// ---------- catalog-ids.json ----------

export const PIZZAS = ["Margherita", "Pepperoni"] as const;
export const SIZES = ["Small", "Medium", "Large"] as const;
export const TOPPINGS = ["Extra cheese", "Mushrooms", "Jalapenos"] as const;
export type PizzaName = (typeof PIZZAS)[number];
export type SizeName = (typeof SIZES)[number];
export type ToppingName = (typeof TOPPINGS)[number];

export interface CatalogIds {
  locationId: string;
  taxId: string;
  modifierListId: string;
  modifiers: Record<ToppingName, string>;
  items: Record<PizzaName, { itemId: string; variations: Record<SizeName, string> }>;
  seededAt: string;
}

export function loadCatalogIds(): CatalogIds {
  return readJson<CatalogIds>(CATALOG_IDS_FILE, "Run `npm run seed-catalog` first.");
}

// ---------- last-link.json (written by create-link and fallback-payment) ----------

export interface LastLink {
  paymentLinkId: string;
  url: string;
  orderId: string;
  amountMinor: string;
  currency: string;
  locationId: string;
  idempotencyKey: string;
  createdAt: string;
  /** "payment_link" from create-link, "simulated_fallback" from fallback-payment. */
  source: "payment_link" | "simulated_fallback";
}

export function loadLastLink(): LastLink {
  return readJson<LastLink>(LAST_LINK_FILE, "Run `npm run create-link` (or `npm run fallback-payment`) first.");
}

// ---------- the sample cart used by quote, create-link and fallback ----------

/**
 * Two pizzas, one with a modifier:
 *   1 x Margherita Large
 *   1 x Pepperoni Medium + Extra cheese
 * pricing_options.auto_apply_taxes = true and no order.taxes (SPEC 4).
 */
export function buildSampleOrder(ids: CatalogIds, locationId: string): Square.Order {
  return {
    locationId,
    lineItems: [
      {
        quantity: "1",
        catalogObjectId: ids.items.Margherita.variations.Large,
      },
      {
        quantity: "1",
        catalogObjectId: ids.items.Pepperoni.variations.Medium,
        modifiers: [{ catalogObjectId: ids.modifiers["Extra cheese"], quantity: "1" }],
      },
    ],
    pricingOptions: { autoApplyTaxes: true },
  };
}

// ---------- idempotency keys (SPEC 2.9) ----------

/** sha256(businessId:subjectId:actionType:approvalId), hex. */
export function idempotencyKey(
  businessId: string,
  subjectId: string,
  actionType: string,
  approvalId: string,
): string {
  return createHash("sha256").update(`${businessId}:${subjectId}:${actionType}:${approvalId}`).digest("hex");
}

/** Fixed sample values. Pass --approval <id> to get a fresh key for a new link. */
export function sampleKeyParts(actionType: string): [string, string, string, string] {
  const i = process.argv.indexOf("--approval");
  const approvalId = i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : "apv_SPIKE01";
  return ["biz_pizza_01", "ord_SPIKE01", actionType, approvalId];
}

// ---------- money and errors ----------

export function minor(m: Square.Money | undefined): string {
  if (!m || m.amount === undefined || m.amount === null) return "(none)";
  return `${m.amount.toString()} ${m.currency ?? "?"}`;
}

/** Prints a Square error without request headers (they carry the token). */
export function printSquareError(context: string, err: unknown): void {
  if (err instanceof SquareError) {
    console.error(`SQUARE ERROR during ${context}: HTTP ${err.statusCode ?? "?"}`);
    for (const e of err.errors) {
      console.error(`  ${e.category} ${e.code}${e.field ? ` field=${e.field}` : ""}: ${e.detail ?? ""}`);
    }
  } else {
    console.error(`ERROR during ${context}:`, err instanceof Error ? err.message : err);
  }
}

export async function run(context: string, main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (err) {
    printSquareError(context, err);
    process.exit(1);
  }
}

// Shared quote logic: CalculateOrder on the sample cart.
import type { Square } from "square";
import { buildSampleOrder, loadCatalogIds, makeClient } from "./common.js";

export interface QuoteSummary {
  subtotalMinor: string;
  taxMinor: string;
  totalMinor: string;
  currency: string;
}

/** Subtotal = total minus tax (discounts, tips and service charges are zero in this cart). */
export function summarize(order: Square.Order | undefined): QuoteSummary {
  const total = order?.totalMoney?.amount;
  const tax = order?.totalTaxMoney?.amount ?? 0n;
  const currency = order?.totalMoney?.currency;
  if (total === undefined || total === null || !currency) {
    throw new Error("CalculateOrder returned no total_money");
  }
  return {
    subtotalMinor: (total - tax).toString(),
    taxMinor: tax.toString(),
    totalMinor: total.toString(),
    currency,
  };
}

export async function calculateSampleQuote(token: string, locationId: string): Promise<{ order: Square.Order; summary: QuoteSummary }> {
  const client = makeClient(token);
  const ids = loadCatalogIds();
  const request = buildSampleOrder(ids, locationId);
  if (request.taxes && request.taxes.length > 0) throw new Error("order.taxes must not be sent (SPEC 4)");
  const res = await client.orders.calculate({ order: request });
  if (!res.order) throw new Error("CalculateOrder returned no order");
  return { order: res.order, summary: summarize(res.order) };
}

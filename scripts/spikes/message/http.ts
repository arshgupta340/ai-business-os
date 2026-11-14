// Shared HTTP execution and result mapping for every adapter.
//
// The mapping rule, the same for every channel:
// - timeout or network error          -> UNKNOWN (the request may have reached the provider)
// - 2xx that the adapter recognizes   -> what the adapter says (SENT, or FAILED if the body says failed)
// - 2xx that the adapter cannot read  -> UNKNOWN ("ambiguous_response")
// - 408 or 409                        -> UNKNOWN (timeout at the provider, or "already exists")
// - any other 4xx                     -> FAILED with an error code
// - 5xx or anything else              -> UNKNOWN
// Nothing here retries.

import type { HttpRequest, SendResult } from "./adapter.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type HttpOutcome =
  | { kind: "response"; status: number; json: unknown; text: string }
  | { kind: "timeout" }
  | { kind: "network"; message: string };

export const DEFAULT_TIMEOUT_MS = 15_000;

export async function execute(req: HttpRequest, fetchImpl: FetchLike, timeoutMs: number): Promise<HttpOutcome> {
  try {
    const res = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { kind: "response", status: res.status, json, text };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") return { kind: "timeout" };
    // A network error is ambiguous: the connection may have dropped after the provider got the request.
    return { kind: "network", message: err instanceof Error ? err.message : String(err) };
  }
}

export interface ResponseParsers {
  /** Read a 2xx body. Return undefined if it cannot be understood. */
  success(json: unknown, status: number): SendResult | undefined;
  /** Pick an error code out of a 4xx body. Return undefined to fall back to "http_<status>". */
  errorCode?(json: unknown, status: number): string | undefined;
}

export function mapOutcome(outcome: HttpOutcome, parsers: ResponseParsers): SendResult {
  if (outcome.kind === "timeout") return { status: "UNKNOWN", errorCode: "timeout" };
  if (outcome.kind === "network") return { status: "UNKNOWN", errorCode: "network_error", raw: { message: outcome.message } };

  const { status, json, text } = outcome;
  const raw = json ?? (text ? text.slice(0, 500) : undefined);

  if (status >= 200 && status < 300) {
    const parsed = parsers.success(json, status);
    if (parsed) return { ...parsed, raw };
    return { status: "UNKNOWN", errorCode: "ambiguous_response", raw };
  }
  if (status === 408 || status === 409) {
    return { status: "UNKNOWN", errorCode: parsers.errorCode?.(json, status) ?? `http_${status}`, raw };
  }
  if (status >= 400 && status < 500) {
    return { status: "FAILED", errorCode: parsers.errorCode?.(json, status) ?? `http_${status}`, raw };
  }
  return { status: "UNKNOWN", errorCode: `http_${status}`, raw };
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const SECRET_HEADERS = new Set(["authorization", "x-api-key"]);

/** Copy of the request with secrets replaced, safe to print. */
export function maskRequest(req: HttpRequest): HttpRequest {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!SECRET_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
      continue;
    }
    const scheme = /^(Basic|Bearer)\s/i.exec(v)?.[1];
    headers[k] = scheme ? `${scheme} ****` : "****";
  }
  return { ...req, headers };
}

/**
 * One central report of failed API calls, fed by the QueryClient's query and
 * mutation caches (provider.tsx). The session layer listens for
 * UNAUTHENTICATED and FORBIDDEN_BUSINESS here, so no screen has to. Hooks
 * still return their errors unchanged.
 */
import { isApiError, type ApiError } from "./errors";

export interface ApiErrorReport {
  error: ApiError;
  /** The business in the query key, for a business-scoped query. Absent for mutations and owner-scoped queries. */
  businessId?: string;
}

type Listener = (report: ApiErrorReport) => void;
const listeners = new Set<Listener>();

/** The businessId of a ["api", "biz", businessId, ...] key, or undefined. */
export function businessIdFromQueryKey(queryKey: readonly unknown[] | undefined): string | undefined {
  if (!queryKey || queryKey[0] !== "api" || queryKey[1] !== "biz") return undefined;
  return typeof queryKey[2] === "string" && queryKey[2] ? queryKey[2] : undefined;
}

/** Called by the QueryClient for every failed query or mutation. Errors that are not ApiError are ignored. */
export function reportApiError(error: unknown, queryKey?: readonly unknown[]): void {
  if (!isApiError(error)) return;
  const report: ApiErrorReport = { error, businessId: businessIdFromQueryKey(queryKey) };
  for (const listener of listeners) listener(report);
}

/** Listen to every failed API call. Returns the unsubscribe function. */
export function subscribeApiErrors(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

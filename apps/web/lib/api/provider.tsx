"use client";
/**
 * ApiProvider: the QueryClientProvider for the app, plus the MSW worker in
 * mock mode. Mount it once in the app providers.
 *
 * When NEXT_PUBLIC_MOCK=1 it starts the MSW browser worker before rendering
 * children and renders `fallback` (default: nothing) until the worker is ready.
 * In real mode the dynamic import below is behind a literal env check, so
 * Next.js drops it and MSW never reaches the production bundle.
 */
import { useEffect, useState, type ReactNode } from "react";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./errors";
import { reportApiError } from "./session-errors";

export function createApiQueryClient(): QueryClient {
  return new QueryClient({
    // Every failed call is reported once, centrally. The session layer turns
    // UNAUTHENTICATED into sign-in and FORBIDDEN_BUSINESS into a business fallback.
    queryCache: new QueryCache({ onError: (error, query) => reportApiError(error, query.queryKey) }),
    mutationCache: new MutationCache({ onError: (error) => reportApiError(error) }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => error instanceof ApiError && error.retryable && failureCount < 2,
      },
      mutations: {
        // Never resend a mutation on its own. The owner decides to retry.
        retry: false,
      },
    },
  });
}

export function ApiProvider({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const [queryClient] = useState(createApiQueryClient);
  const [ready, setReady] = useState(process.env.NEXT_PUBLIC_MOCK !== "1");
  const [mockError, setMockError] = useState<string | null>(null);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_MOCK === "1") {
      let cancelled = false;
      import("@/mocks/browser")
        .then((m) => m.startMockWorker())
        .then(() => {
          if (!cancelled) setReady(true);
        })
        .catch((err: unknown) => {
          if (!cancelled) setMockError(err instanceof Error ? err.message : String(err));
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, []);

  if (mockError) {
    // Plain text on purpose: this only appears to developers in mock mode.
    return <p role="alert">The mock API did not start: {mockError}</p>;
  }

  return <QueryClientProvider client={queryClient}>{ready ? children : fallback}</QueryClientProvider>;
}

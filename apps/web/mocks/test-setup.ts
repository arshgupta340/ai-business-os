/** Shared setup for tests that run the client against the MSW node server. */
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { configureApiClient } from "@/lib/api/client";
import { FAST_TIMING, resetDb, server, setMockTiming, whenIdle } from "./server";

export const TEST_BASE_URL = "http://api.test";
export const requests: Request[] = [];

export function useMockServer(): void {
  beforeAll(() => {
    setMockTiming(FAST_TIMING);
    server.listen({ onUnhandledRequest: "error" });
    server.events.on("request:start", ({ request }) => {
      requests.push(request.clone());
    });
  });
  beforeEach(async () => {
    requests.length = 0;
    await resetDb();
    configureApiClient({ baseUrl: TEST_BASE_URL, getAccessToken: async () => "test-token", fetch: (...a) => globalThis.fetch(...a) });
  });
  afterEach(async () => {
    server.resetHandlers();
    await whenIdle();
  });
  afterAll(() => {
    server.close();
  });
}

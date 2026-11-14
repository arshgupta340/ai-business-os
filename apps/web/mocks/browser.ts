/**
 * Browser entry for mock mode. ApiProvider imports this file dynamically
 * only when NEXT_PUBLIC_MOCK=1, so none of it reaches the production bundle.
 */
import { getResponse } from "msw";
import { setupWorker } from "msw/browser";
import { registerMockControls } from "@/lib/api/mock-bridge";
import { handlers } from "./handlers";
import { sweepExpired } from "./db";
import { mockControls } from "./timeline";

let started: Promise<void> | null = null;

/**
 * Fallback for browsers that cannot register a service worker (some embedded
 * webviews, private windows, locked-down test browsers). It answers API calls
 * in the page with the same handlers, so mock mode behaves the same. Requests
 * no handler matches go to the network as usual.
 */
function installInPageMock(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const mocked = await getResponse(handlers, request.clone());
    return mocked ?? realFetch(request);
  };
}

export function startMockWorker(): Promise<void> {
  if (!started) {
    const worker = setupWorker(...handlers);
    started = worker
      .start({ onUnhandledRequest: "bypass", serviceWorker: { url: "/mockServiceWorker.js" }, quiet: true })
      .then(() => undefined)
      .catch((err: unknown) => {
        console.warn("[mock] Service worker did not register. Using the in-page mock instead.", err);
        installInPageMock();
      })
      .then(() => {
        registerMockControls(mockControls);
        // The real server expires approvals with a job; the mock checks every 5 seconds.
        setInterval(() => sweepExpired(), 5000);
      });
  }
  return started;
}

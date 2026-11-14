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

/** How long to wait for the service worker to take control of the page before using the in-page mock. */
export const CONTROL_TIMEOUT_MS = 3000;

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

/** The part of ServiceWorkerContainer that waitForControl reads. */
export type ControlSource = Pick<ServiceWorkerContainer, "controller" | "addEventListener" | "removeEventListener">;

/**
 * Resolves true once the page is controlled by a service worker, or false
 * after `timeoutMs`.
 *
 * worker.start() resolves when the worker is activated and has answered the
 * MSW handshake. It does not wait for the page to be controlled. A page that
 * is not controlled sends its fetches past the worker, straight to the Next
 * server, which has no API routes and answers 404. This happens when MSW
 * finds an existing registration on a page that is not controlled (after a
 * hard reload): msw 2.15 calls location.reload() there and still resolves
 * start(). Waiting here keeps the app from rendering before the reload or
 * the controllerchange.
 */
export function waitForControl(source: ControlSource, timeoutMs: number): Promise<boolean> {
  if (source.controller) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (controlled: boolean) => {
      clearTimeout(timer);
      source.removeEventListener("controllerchange", onChange);
      resolve(controlled);
    };
    const onChange = () => {
      if (source.controller) done(true);
    };
    const timer = setTimeout(() => done(!!source.controller), timeoutMs);
    source.addEventListener("controllerchange", onChange);
  });
}

export function startMockWorker(): Promise<void> {
  if (!started) {
    const worker = setupWorker(...handlers);
    started = worker
      .start({ onUnhandledRequest: "bypass", serviceWorker: { url: "/mockServiceWorker.js" }, quiet: true })
      .then(async () => {
        const controlled = await waitForControl(navigator.serviceWorker, CONTROL_TIMEOUT_MS);
        if (!controlled) {
          console.warn("[mock] The service worker did not take control of this page. Using the in-page mock instead.");
          installInPageMock();
        }
      })
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

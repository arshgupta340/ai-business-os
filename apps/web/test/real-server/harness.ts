/**
 * Runs the web app's own API client against the real server code, in process.
 *
 * The server is `createWorld()` from apps/server/test/e2e/world.ts: the real
 * Fastify app on an in-process Postgres, migrated and seeded with the real
 * seed script, with fake Square, Calendar, message and Sheets providers. No
 * network and no shared database.
 *
 * The client keeps its own method, path, query encoding, headers and response
 * parsing. Only `fetch` is swapped: each Request becomes one `app.inject` call
 * and the inject answer becomes a Response.
 *
 * The bearer token comes from the client's default getter, which loads
 * lib/session/auth/token.ts. Each test file replaces the Supabase browser
 * client with `fakeSupabaseModule` (see `vi.mock` at the top of each file), so
 * token.ts reads `session.access_token` from the fake session set here.
 */
import type { FastifyInstance } from "fastify";
import { configureApiClient } from "@/lib/api/client";
import { createWorld, type World } from "../../../server/test/e2e/world";

export const PIZZA = "biz_pizza_01";
export const BARBER = "biz_barber_01";
export const OTHER_BUSINESS = "biz_other_01";
export const BUSINESSES = [PIZZA, BARBER] as const;

/** The base URL the client is pointed at. Nothing listens on it; requests go to app.inject. */
export const BASE_URL = "http://real-server.test";

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  status: number;
}

// ------------------------------------------------------------ the session

let currentToken: string | null = "owner";

/** Sets the access token token.ts will return: "owner" (the seeded owner), "other" (a stranger), or null (signed out). */
export function setToken(token: string | null): void {
  currentToken = token;
}

/** Stand-in for lib/supabase/client.ts. Only auth.getSession is used by token.ts. */
export const fakeSupabaseModule = {
  getSupabaseBrowserClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: currentToken ? { access_token: currentToken } : null }, error: null }),
    },
  }),
};

// ------------------------------------------------------------ fetch to inject

type InjectMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

/** A fetch that answers every Request through `app.inject`. Each request is pushed onto `log`. */
export function injectFetch(app: FastifyInstance, log: RecordedRequest[]): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    // Request serializes a JSON string or a FormData body (with its multipart boundary) for us.
    const payload = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const res = await app.inject({ method: request.method as InjectMethod, url: url.pathname + url.search, headers, payload });
    log.push({ method: request.method, url, headers: request.headers, status: res.statusCode });

    const out = new Headers();
    for (const [key, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) out.append(key, String(v));
      else out.set(key, String(value));
    }
    const noBody = res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304;
    return new Response(noBody ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out });
  };
}

// ------------------------------------------------------------ the world

export interface RealServer {
  world: World;
  /** Every request the client sent, in order. */
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * Starts a fresh world and points the web client at it. Call it in beforeAll
 * with a long timeout: migrating the in-process Postgres takes a few seconds.
 */
export async function startRealServer(...args: Parameters<typeof createWorld>): Promise<RealServer> {
  // The builder reads its model settings from process.env. Without these it uses its recorded
  // models, so no test can reach OpenAI even when the shell running the tests has a key.
  for (const name of ["OPENAI_API_KEY", "OPENAI_BUILDER_MODEL", "BUILDER_DEV_AUTH"]) delete process.env[name];
  const world = await createWorld(...args);
  const requests: RecordedRequest[] = [];
  setToken("owner");
  configureApiClient({ baseUrl: BASE_URL, fetch: injectFetch(world.app, requests) });
  return { world, requests, close: () => world.close() };
}

/** Integration health that reports every provider up, so publish is not stopped by a disconnected provider. */
export function markProvidersHealthy(world: World): void {
  const up = async () => ({ ok: true as const, detail: "fake probe" });
  const configured = { configured: true, detail: "configured" };
  const providers = ["square", "twilio", "openai", "google_calendar", "google_sheets", "message_channel"] as const;
  for (const p of providers) {
    world.app.composed.providers.status[p] = configured;
    if (world.app.composed.providers.probes) world.app.composed.providers.probes[p] = up;
  }
}

/** The settings that turn the phone path on in the world, so health and publish see Twilio and OpenAI as configured. Test values only. */
export const VOICE_ENV = { TWILIO_AUTH_TOKEN: "test-twilio-token", TWILIO_ACCOUNT_SID: "ACtest", OPENAI_API_KEY: "test-openai-key" };

/** The rejection of a promise that must fail. */
export async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to fail");
}

/** Polls `read` until `done` is true. The server finishes some work (file extraction) after it answered. */
export async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > until) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
}

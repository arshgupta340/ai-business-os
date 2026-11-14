import { z } from 'zod';
import { apiError } from '../util';
import type { ClientSecretRequest } from './session-config';

// Minting a short-lived OpenAI Realtime client secret, behind a small interface.
//
// OpenAiRealtimeMinter calls POST /v1/realtime/client_secrets with the server's
// API key (SPEC section 4). The key goes only into the Authorization header of
// that one request. It is never returned, logged or put in an error.
//
// UnavailableRealtimeMinter runs when there is no usable key. The contract
// (RealtimeClientSecret) has no field that marks a secret as fake, so instead of
// returning a value that looks real it refuses with INTEGRATION_UNAVAILABLE and
// the browser falls back to typed chat.

export interface MintedSecret {
  value: string;
  expiresAt: Date;
}

export interface RealtimeMinter {
  readonly kind: 'openai' | 'unavailable' | 'test';
  mint(request: ClientSecretRequest): Promise<MintedSecret>;
}

// Only what the route may log. Never the key, never the secret, never an upstream body.
export interface MinterLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

const OPENAI_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const TIMEOUT_MS = 10_000;

// Response shape from the API reference: value, expires_at (Unix seconds), session.
const ClientSecretResponse = z.object({
  value: z.string().min(1),
  expires_at: z.number().int().positive(),
  session: z.object({ tools: z.array(z.unknown()).optional() }).passthrough().optional(),
});

const unavailable = (message = 'Voice is not available right now. Use typed chat.') =>
  apiError('INTEGRATION_UNAVAILABLE', message, { provider: 'openai' });

export class OpenAiRealtimeMinter implements RealtimeMinter {
  readonly kind = 'openai' as const;
  readonly #apiKey: string;
  readonly #fetch: (() => typeof fetch) | undefined;
  readonly #log: MinterLog | undefined;

  constructor(options: { apiKey: string; fetch?: typeof fetch; log?: MinterLog }) {
    this.#apiKey = options.apiKey;
    const injected = options.fetch;
    this.#fetch = injected ? () => injected : undefined;
    this.#log = options.log;
  }

  async mint(request: ClientSecretRequest): Promise<MintedSecret> {
    const doFetch = this.#fetch ? this.#fetch() : globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(OPENAI_CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // The error name only: a fetch error message can carry request details.
      this.#log?.warn({ provider: 'openai', error: error instanceof Error ? error.name : 'unknown' }, 'realtime client secret request failed');
      throw unavailable();
    }
    if (!res.ok) {
      // The upstream body is dropped unread: it is a raw provider response.
      await res.body?.cancel().catch(() => undefined);
      this.#log?.warn({ provider: 'openai', status: res.status }, 'realtime client secret request refused');
      throw unavailable();
    }
    let parsed: z.infer<typeof ClientSecretResponse>;
    try {
      parsed = ClientSecretResponse.parse(await res.json());
    } catch {
      this.#log?.warn({ provider: 'openai', status: res.status }, 'realtime client secret response had an unexpected shape');
      throw unavailable();
    }
    // Defense in depth: if OpenAI reports the effective session, it must have no tools.
    if (parsed.session?.tools && parsed.session.tools.length > 0) {
      this.#log?.warn({ provider: 'openai' }, 'realtime session came back with tools; secret discarded');
      throw unavailable();
    }
    return { value: parsed.value, expiresAt: new Date(parsed.expires_at * 1000) };
  }
}

export class UnavailableRealtimeMinter implements RealtimeMinter {
  readonly kind = 'unavailable' as const;
  constructor(private readonly message = 'Voice is not configured on this server. Use typed chat.') {}
  async mint(): Promise<MintedSecret> {
    throw unavailable(this.message);
  }
}
